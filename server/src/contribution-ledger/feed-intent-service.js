import { randomUUID } from "node:crypto";

import {
    createFeedIntent,
    createOutboxEntry
} from "../domain/feed-intents.js";
import { ApplicationError } from "../errors/application-error.js";

export class FeedIntentService {
    constructor({
        eventStore,
        feedEligibilityService,
        defaultFeederId,
        clock = () => new Date(),
        idGenerator = randomUUID
    }) {
        this.eventStore = eventStore;
        this.feedEligibilityService = feedEligibilityService;
        this.defaultFeederId = defaultFeederId;
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    buildForContribution(contribution, {
        feederId = this.defaultFeederId,
        message
    } = {}) {
        const queue = this.eventStore.getQueueForFeeder(feederId);
        if (!queue) {
            throw new ApplicationError("Feeder not found.", {
                code: "FEEDER_NOT_FOUND",
                statusCode: 404,
                details: { feederId }
            });
        }
        const providerEvent = this.eventStore.getProviderEvent(
            contribution.providerEventId
        );
        const persistedMessage = message === undefined
            ? providerEvent?.rawMetadata?.message || ""
            : message;
        const createdAt = this.clock().toISOString();
        const feedIntent = createFeedIntent({
            contributionId: contribution.contributionId,
            barnId: queue.barnId,
            feederId: queue.feederId,
            queueId: queue.queueId,
            message: persistedMessage,
            createdAt
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });
        const outboxEntry = createOutboxEntry({
            feedIntentId: feedIntent.feedIntentId,
            createdAt
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });

        return { feedIntent, outboxEntry };
    }

    ensureForContribution(contributionId, options = {}) {
        const existing = this.eventStore.getFeedIntentByContribution(contributionId);
        if (existing) {
            return {
                feedIntent: existing,
                outboxEntry: this.eventStore.getOutboxEntry(existing.feedIntentId),
                created: false
            };
        }

        const { contribution } = this.feedEligibilityService
            .requireEligibleContribution(contributionId);
        const records = this.buildForContribution(contribution, options);
        try {
            this.eventStore.createFeedIntentOutbox(
                records.feedIntent,
                records.outboxEntry
            );
            return { ...records, created: true };
        } catch (error) {
            const concurrent = this.eventStore.getFeedIntentByContribution(contributionId);
            if (!concurrent) {
                throw error;
            }
            return {
                feedIntent: concurrent,
                outboxEntry: this.eventStore.getOutboxEntry(concurrent.feedIntentId),
                created: false
            };
        }
    }
}
