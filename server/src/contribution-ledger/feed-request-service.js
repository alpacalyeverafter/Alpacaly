import { randomUUID } from "node:crypto";

import { createContributionAuditRecord } from "../domain/contributions.js";

export class FeedRequestService {
    constructor({
        eventEngine,
        eventStore,
        feedEligibilityService,
        logger,
        clock = () => new Date(),
        idGenerator = randomUUID
    }) {
        this.eventEngine = eventEngine;
        this.eventStore = eventStore;
        this.feedEligibilityService = feedEligibilityService;
        this.logger = logger;
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    createFromFeedIntent(feedIntentId) {
        const feedIntent = this.eventStore.getFeedIntent(feedIntentId);
        if (!feedIntent) {
            throw new Error(`FeedIntent ${feedIntentId} was not found.`);
        }
        const { contribution, providerEvent } = this.feedEligibilityService
            .requireEligibleContribution(feedIntent.contributionId);
        const existingEventId = this.eventStore.getEventIdByFeedIntent(feedIntentId);
        if (existingEventId) {
            const existingFeedRequest = this.eventEngine.getFeedRequest(existingEventId);
            return {
                feedRequest: existingFeedRequest,
                queuePosition: existingFeedRequest?.queuePosition ?? null,
                estimatedWaitMs: existingFeedRequest?.estimatedWaitMs ?? 0,
                created: false
            };
        }

        const occurredAt = this.clock().toISOString();
        const auditRecord = createContributionAuditRecord({
            action: "FEED_REQUEST_CREATED",
            providerEventId: providerEvent.providerEventId,
            contributionId: contribution.contributionId,
            occurredAt,
            details: {
                feedIntentId,
                feederId: feedIntent.feederId
            }
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });
        const result = this.eventEngine.createFeedRequestFromFeedIntent({
            supporterName: contribution.supporterDisplayName,
            source: providerEvent.provider.toLowerCase(),
            message: feedIntent.message,
            clientRequestId: contribution.contributionId
        }, {
            feedIntentId,
            feederId: feedIntent.feederId,
            contributionId: contribution.contributionId,
            auditRecord
        });

        this.logger.info({
            event: "feed_request_created_from_contribution",
            eventId: result.feedRequest.eventId,
            contributionId: contribution.contributionId,
            feedIntentId,
            providerEventId: providerEvent.providerEventId,
            feederId: feedIntent.feederId
        }, "Feed request created from verified Contribution");

        return { ...result, created: true };
    }
}
