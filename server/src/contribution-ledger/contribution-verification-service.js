import { randomUUID } from "node:crypto";

import {
    createContribution,
    createContributionAuditRecord
} from "../domain/contributions.js";
import { ApplicationError } from "../errors/application-error.js";

export class ContributionVerificationService {
    constructor({
        eventStore,
        feedIntentService,
        logger,
        clock = () => new Date(),
        idGenerator = randomUUID
    }) {
        this.eventStore = eventStore;
        this.feedIntentService = feedIntentService;
        this.logger = logger;
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    verify(providerEventId, decision) {
        const providerEvent = this.eventStore.getProviderEvent(providerEventId);
        if (!providerEvent) {
            throw new ApplicationError("Provider event not found.", {
                code: "PROVIDER_EVENT_NOT_FOUND",
                statusCode: 404
            });
        }

        const existingContribution = this.eventStore.getContributionByProviderEvent(
            providerEventId
        );
        if (existingContribution) {
            const intent = this.feedIntentService.ensureForContribution(
                existingContribution.contributionId,
                {
                    feederId: decision?.feederId,
                    message: decision?.message
                }
            );
            return {
                providerEvent,
                contribution: existingContribution,
                feedIntent: intent.feedIntent,
                accepted: true,
                created: false
            };
        }

        if (providerEvent.verificationStatus !== "PENDING") {
            return {
                providerEvent,
                contribution: null,
                feedIntent: null,
                accepted: false,
                created: false
            };
        }

        if (decision?.verified !== true) {
            return this.reject(providerEvent, decision?.rejectionReason || "VERIFICATION_FAILED");
        }

        if (decision?.eligible !== true) {
            return this.rejectIneligible(
                providerEvent,
                decision?.rejectionReason || "INELIGIBLE"
            );
        }

        const now = this.clock().toISOString();
        const contribution = createContribution({
            providerEventId,
            verifiedAt: now,
            amountMinor: decision.amountMinor,
            currency: decision.currency,
            supporterDisplayName: decision.supporterDisplayName,
            eligibilityStatus: "ELIGIBLE",
            feedQuantity: decision.feedQuantity,
            metadata: decision.metadata,
            createdAt: now,
            updatedAt: now
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });
        const auditRecords = [
            this.audit("VERIFICATION_PASSED", {
                providerEventId,
                occurredAt: now
            }),
            this.audit("CONTRIBUTION_CREATED", {
                providerEventId,
                contributionId: contribution.contributionId,
                occurredAt: now,
                details: {
                    amountMinor: contribution.amountMinor,
                    currency: contribution.currency,
                    feedQuantity: contribution.feedQuantity
                }
            })
        ];
        const { feedIntent, outboxEntry } = this.feedIntentService
            .buildForContribution(contribution, {
                feederId: decision.feederId,
                message: decision.message
            });

        try {
            this.eventStore.persistContributionDecision({
                providerEventId,
                verificationStatus: "VERIFIED",
                rejectionReason: null,
                updatedAt: now,
                contribution,
                feedIntent,
                outboxEntry,
                auditRecords
            });
        } catch (error) {
            const concurrentContribution = this.eventStore
                .getContributionByProviderEvent(providerEventId);
            if (!concurrentContribution) {
                throw error;
            }
            return {
                providerEvent: this.eventStore.getProviderEvent(providerEventId),
                contribution: concurrentContribution,
                feedIntent: this.feedIntentService.ensureForContribution(
                    concurrentContribution.contributionId
                ).feedIntent,
                accepted: true,
                created: false
            };
        }
        const verifiedProviderEvent = this.eventStore.getProviderEvent(providerEventId);

        this.logger.info({
            event: "contribution_created",
            providerEventId,
            contributionId: contribution.contributionId,
            amountMinor: contribution.amountMinor,
            currency: contribution.currency,
            feedQuantity: contribution.feedQuantity
        }, "Verified Contribution created");

        return {
            providerEvent: verifiedProviderEvent,
            contribution: { ...contribution },
            feedIntent: { ...feedIntent },
            accepted: true,
            created: true
        };
    }

    reject(providerEvent, rejectionReason) {
        const now = this.clock().toISOString();
        this.eventStore.persistContributionDecision({
            providerEventId: providerEvent.providerEventId,
            verificationStatus: "REJECTED",
            rejectionReason,
            updatedAt: now,
            auditRecords: [
                this.audit("VERIFICATION_FAILED", {
                    providerEventId: providerEvent.providerEventId,
                    occurredAt: now,
                    details: { rejectionReason }
                }),
                this.audit("CONTRIBUTION_REJECTED", {
                    providerEventId: providerEvent.providerEventId,
                    occurredAt: now,
                    details: { rejectionReason }
                })
            ]
        });
        return {
            providerEvent: this.eventStore.getProviderEvent(providerEvent.providerEventId),
            contribution: null,
            feedIntent: null,
            accepted: false,
            created: false
        };
    }

    rejectIneligible(providerEvent, rejectionReason) {
        const now = this.clock().toISOString();
        this.eventStore.persistContributionDecision({
            providerEventId: providerEvent.providerEventId,
            verificationStatus: "VERIFIED",
            rejectionReason,
            updatedAt: now,
            auditRecords: [
                this.audit("VERIFICATION_PASSED", {
                    providerEventId: providerEvent.providerEventId,
                    occurredAt: now
                }),
                this.audit("CONTRIBUTION_REJECTED", {
                    providerEventId: providerEvent.providerEventId,
                    occurredAt: now,
                    details: { rejectionReason }
                })
            ]
        });
        return {
            providerEvent: this.eventStore.getProviderEvent(providerEvent.providerEventId),
            contribution: null,
            feedIntent: null,
            accepted: false,
            created: false
        };
    }

    audit(action, input) {
        return createContributionAuditRecord({ action, ...input }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });
    }
}
