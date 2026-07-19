export class FeedIntentOutboxWorker {
    constructor({
        eventStore,
        eventEngine,
        feedIntentService,
        feedRequestService,
        logger,
        clock = () => new Date(),
        pollIntervalMs = 250,
        retryDelayMs = 1000
    }) {
        this.eventStore = eventStore;
        this.eventEngine = eventEngine;
        this.feedIntentService = feedIntentService;
        this.feedRequestService = feedRequestService;
        this.logger = logger;
        this.clock = clock;
        this.pollIntervalMs = pollIntervalMs;
        this.retryDelayMs = retryDelayMs;
        this.started = false;
        this.processing = false;
        this.timer = null;
    }

    start() {
        if (this.started) {
            return;
        }

        this.started = true;
        this.reconcileAfterStartup();
        this.processPending();
        this.scheduleNextPoll();
    }

    stop() {
        this.started = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    reconcileAfterStartup() {
        const recoveredAt = this.clock().toISOString();
        const recoveredIds = this.eventStore.recoverInterruptedFeedIntents(recoveredAt);
        const repairedContributionIds = [];

        this.eventStore.getContributionsWithoutFeedIntents().forEach(contribution => {
            this.feedIntentService.ensureForContribution(contribution.contributionId);
            repairedContributionIds.push(contribution.contributionId);
        });

        if (recoveredIds.length > 0 || repairedContributionIds.length > 0) {
            this.logger.warn({
                event: "feed_intent_outbox_reconciled",
                recoveredFeedIntentIds: recoveredIds,
                repairedContributionIds
            }, "Durable feed processing was recovered after startup");
        }

        return { recoveredIds, repairedContributionIds };
    }

    processPending({ limit = 100 } = {}) {
        if (this.processing || this.eventStore.closed) {
            return [];
        }

        this.processing = true;
        const results = [];
        try {
            let attempted = 0;
            let processingFailed = false;
            while (attempted < limit && !processingFailed) {
                const now = this.clock().toISOString();
                const entries = this.eventStore.getProcessableOutboxEntries(
                    now,
                    limit - attempted
                );
                if (entries.length === 0) {
                    break;
                }
                entries.forEach(entry => {
                    attempted += 1;
                    try {
                        const result = this.processFeedIntent(entry.feedIntentId);
                        if (result) {
                            results.push(result);
                        }
                    } catch (error) {
                        processingFailed = true;
                        this.logger.error({
                            event: "feed_intent_outbox_processing_failed",
                            feedIntentId: entry.feedIntentId,
                            err: error
                        }, "FeedIntent Outbox processing failed and will be retried");
                    }
                });
            }
        } finally {
            this.processing = false;
        }
        return results;
    }

    processFeedIntent(feedIntentId) {
        const intent = this.eventStore.getFeedIntent(feedIntentId);
        if (!intent) {
            throw new Error(`FeedIntent ${feedIntentId} was not found.`);
        }

        const existingEventId = this.eventStore.getEventIdByFeedIntent(feedIntentId);
        if (existingEventId) {
            const feedRequest = this.eventEngine.getFeedRequest(existingEventId);
            return {
                feedRequest,
                queuePosition: feedRequest?.queuePosition ?? null,
                estimatedWaitMs: feedRequest?.estimatedWaitMs ?? 0,
                created: false
            };
        }

        if (intent.status === "COMPLETED") {
            throw new Error(
                `Completed FeedIntent ${feedIntentId} has no Feed Request.`
            );
        }
        if (intent.status === "PROCESSING") {
            return null;
        }

        const startedAt = this.clock().toISOString();
        const claimed = this.eventStore.claimFeedIntent(feedIntentId, startedAt);
        if (!claimed) {
            return null;
        }

        try {
            return this.feedRequestService.createFromFeedIntent(feedIntentId);
        } catch (error) {
            const failedAtDate = this.clock();
            this.eventStore.markFeedIntentFailed(feedIntentId, {
                failedAt: failedAtDate.toISOString(),
                retryAt: new Date(
                    failedAtDate.getTime() + this.retryDelayMs
                ).toISOString(),
                error
            });
            throw error;
        }
    }

    scheduleNextPoll() {
        if (!this.started || this.eventStore.closed) {
            this.stop();
            return;
        }

        this.timer = setTimeout(() => {
            this.timer = null;
            if (!this.started || this.eventStore.closed) {
                this.stop();
                return;
            }
            this.processPending();
            this.scheduleNextPoll();
        }, this.pollIntervalMs);
        this.timer.unref?.();
    }
}
