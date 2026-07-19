import { randomUUID } from "node:crypto";

import { ApplicationError } from "../errors/application-error.js";

const CLIENT_CONTROLLED_TRUST_FIELDS = Object.freeze([
    "provider",
    "providerEventId",
    "contributionId",
    "verificationStatus",
    "verified",
    "verifiedAt",
    "eligibilityStatus",
    "feedQuantity"
]);

export class DevelopmentWebsiteContributionService {
    constructor({
        providerEventIngestionService,
        contributionVerificationService,
        outboxWorker,
        clock = () => new Date(),
        idGenerator = randomUUID
    }) {
        this.providerEventIngestionService = providerEventIngestionService;
        this.contributionVerificationService = contributionVerificationService;
        this.outboxWorker = outboxWorker;
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    simulate(payload, { feederId } = {}) {
        this.rejectClientControlledTrust(payload);
        const supporterDisplayName = typeof payload?.supporterName === "string"
            ? payload.supporterName.trim()
            : "";
        if (!supporterDisplayName) {
            throw new ApplicationError("The simulated contribution is invalid.", {
                code: "VALIDATION_ERROR",
                statusCode: 400,
                details: ["supporterName is required"]
            });
        }
        if (supporterDisplayName.length > 80) {
            throw new ApplicationError("The simulated contribution is invalid.", {
                code: "VALIDATION_ERROR",
                statusCode: 400,
                details: ["supporterName must be 80 characters or fewer"]
            });
        }

        const message = payload?.message === undefined ? "" : payload.message;
        if (typeof message !== "string" || message.trim().length > 500) {
            throw new ApplicationError("The simulated contribution is invalid.", {
                code: "VALIDATION_ERROR",
                statusCode: 400,
                details: ["message must be a string of 500 characters or fewer"]
            });
        }

        const amountMinor = payload?.amountMinor === undefined
            ? 0
            : Number(payload.amountMinor);
        if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
            throw new ApplicationError("The simulated contribution is invalid.", {
                code: "VALIDATION_ERROR",
                statusCode: 400,
                details: ["amountMinor must be a non-negative integer"]
            });
        }

        const currency = String(payload?.currency || "GBP").trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) {
            throw new ApplicationError("The simulated contribution is invalid.", {
                code: "VALIDATION_ERROR",
                statusCode: 400,
                details: ["currency must be a three-letter code"]
            });
        }
        const externalEventId = String(
            payload?.externalEventId
            || payload?.clientRequestId
            || `website_simulation_${this.idGenerator()}`
        ).trim();
        const ingestion = this.providerEventIngestionService.ingest({
            provider: "WEBSITE",
            externalEventId,
            receivedAt: this.clock().toISOString(),
            rawMetadata: {
                simulation: true,
                source: String(payload?.source || "website"),
                message: message.trim(),
                amountMinor,
                currency
            }
        });
        const verification = this.contributionVerificationService.verify(
            ingestion.providerEvent.providerEventId,
            {
                verified: true,
                eligible: true,
                amountMinor,
                currency,
                supporterDisplayName,
                feedQuantity: 1,
                metadata: { simulation: true },
                feederId,
                message: message.trim()
            }
        );

        if (!verification.contribution) {
            throw new ApplicationError(
                "The simulated ProviderEvent did not produce an eligible Contribution.",
                {
                    code: "CONTRIBUTION_REJECTED",
                    statusCode: 409,
                    details: {
                        providerEventId: ingestion.providerEvent.providerEventId
                    }
                }
            );
        }

        const feedResult = this.outboxWorker.processFeedIntent(
            verification.feedIntent.feedIntentId
        );
        if (!feedResult?.feedRequest) {
            throw new ApplicationError(
                "The durable FeedIntent is already being processed.",
                {
                    code: "FEED_INTENT_PROCESSING",
                    statusCode: 409,
                    details: {
                        feedIntentId: verification.feedIntent.feedIntentId
                    }
                }
            );
        }

        return {
            providerEvent: verification.providerEvent,
            contribution: verification.contribution,
            feedIntent: verification.feedIntent,
            duplicate: ingestion.duplicate,
            ...feedResult
        };
    }

    rejectClientControlledTrust(payload) {
        const forbiddenField = CLIENT_CONTROLLED_TRUST_FIELDS.find(field => (
            payload && Object.hasOwn(payload, field)
        ));
        if (forbiddenField) {
            throw new ApplicationError(
                "Clients cannot control contribution verification or eligibility.",
                {
                    code: "CLIENT_VERIFICATION_FORBIDDEN",
                    statusCode: 400,
                    details: { field: forbiddenField }
                }
            );
        }
    }
}
