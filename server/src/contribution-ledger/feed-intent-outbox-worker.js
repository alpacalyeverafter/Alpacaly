export class FeedIntentOutboxWorker {
    constructor({
        eventStore,
        eventEngine,
        feedIntentService,
        feedRequestService,
        claimStore,
        workerIdentity,
        logger,
        clock = () => new Date(),
        pollIntervalMs = 250,
        retryDelayMs = 1000,
        heartbeatIntervalMs = 5000,
        maximumAttempts = 10,
        recoverySafetyService = null
    }) {
        this.eventStore = eventStore;
        this.eventEngine = eventEngine;
        this.feedIntentService = feedIntentService;
        this.feedRequestService = feedRequestService;
        this.claimStore = claimStore;
        this.workerIdentity = workerIdentity;
        this.logger = logger;
        this.clock = clock;
        this.pollIntervalMs = pollIntervalMs;
        this.retryDelayMs = retryDelayMs;
        this.heartbeatIntervalMs = heartbeatIntervalMs;
        this.maximumAttempts = maximumAttempts;
        this.recoverySafetyService = recoverySafetyService;
        this.started = false;
        this.processing = false;
        this.timer = null;
        this.heartbeatTimer = null;
        this.workerRegistered = false;
    }

    start() {
        if (this.started) {
            return true;
        }
        if (this.recoverySafetyService && !this.recoverySafetyService.workersMayStart()) {
            this.logger.warn({
                event: "feed_intent_worker_recovery_blocked"
            }, "FeedIntent worker remains disabled in recovery safety mode");
            return false;
        }

        this.started = true;
        this.ensureWorkerRegistered();
        this.scheduleHeartbeat();
        this.reconcileAfterStartup();
        this.processPending();
        this.scheduleNextPoll();
        return true;
    }

    stop() {
        this.started = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.heartbeatTimer) {
            clearTimeout(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.workerRegistered && !this.eventStore.closed) {
            this.claimStore.stopWorker(this.workerIdentity);
        }
        this.workerRegistered = false;
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
        if (
            this.processing
            || this.eventStore.closed
            || (this.recoverySafetyService
                && !this.recoverySafetyService.workersMayStart())
        ) {
            return [];
        }

        this.processing = true;
        const results = [];
        try {
            let attempted = 0;
            const attemptedIds = new Set();
            while (attempted < limit) {
                const now = this.clock().toISOString();
                const entries = this.eventStore.getProcessableOutboxEntries(
                    now,
                    limit - attempted
                );
                if (entries.length === 0) {
                    break;
                }
                const eligibleEntries = entries.filter(
                    entry => !attemptedIds.has(entry.feedIntentId)
                );
                if (eligibleEntries.length === 0) {
                    break;
                }
                eligibleEntries.forEach(entry => {
                    attempted += 1;
                    attemptedIds.add(entry.feedIntentId);
                    try {
                        const result = this.processFeedIntent(entry.feedIntentId);
                        if (result) {
                            results.push(result);
                        }
                    } catch (error) {
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
        this.recoverySafetyService?.assertOperationAllowed("FEED_INTENT_PROCESSING");
        this.ensureWorkerRegistered();
        let intent = this.eventStore.getFeedIntent(feedIntentId);
        if (!intent) {
            throw new Error(`FeedIntent ${feedIntentId} was not found.`);
        }

        const claim = this.claimStore.claim(
            "FEED_INTENT",
            feedIntentId,
            this.workerIdentity,
            {
                maximumAttempts: this.maximumAttempts,
                metadata: { feederId: intent.feederId, queueId: intent.queueId }
            }
        );
        if (!claim) {
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
            return null;
        }

        const existingEventId = this.eventStore.getEventIdByFeedIntent(feedIntentId);
        if (existingEventId) {
            this.claimStore.complete(claim, this.workerIdentity, {
                eventId: existingEventId,
                recovery: "DOMAIN_COMMIT_ALREADY_PRESENT"
            });
            const feedRequest = this.eventEngine.getFeedRequest(existingEventId);
            return {
                feedRequest,
                queuePosition: feedRequest?.queuePosition ?? null,
                estimatedWaitMs: feedRequest?.estimatedWaitMs ?? 0,
                created: false
            };
        }

        if (intent.status === "COMPLETED") {
            this.claimStore.fail(claim, this.workerIdentity, {
                error: new Error("Completed FeedIntent has no Feed Request."),
                nonRetryable: true,
                failureCode: "INCONSISTENT_COMPLETED_INTENT"
            });
            throw new Error(
                `Completed FeedIntent ${feedIntentId} has no Feed Request.`
            );
        }
        if (intent.status === "PROCESSING") {
            this.eventStore.recoverInterruptedFeedIntent(
                feedIntentId,
                this.clock().toISOString()
            );
            intent = this.eventStore.getFeedIntent(feedIntentId);
        }

        const startedAt = this.clock().toISOString();
        const claimed = this.eventStore.claimFeedIntent(feedIntentId, startedAt);
        if (!claimed) {
            return null;
        }

        try {
            return this.feedRequestService.createFromFeedIntent(feedIntentId, {
                workClaim: {
                    claim,
                    identity: this.workerIdentity,
                    claimStore: this.claimStore
                }
            });
        } catch (error) {
            const failedAtDate = this.clock();
            const retryAt = new Date(
                failedAtDate.getTime() + this.retryDelayMs
            ).toISOString();
            if (this.eventStore.getFeedIntent(feedIntentId)?.status === "PROCESSING") {
                this.eventStore.markFeedIntentFailed(feedIntentId, {
                    failedAt: failedAtDate.toISOString(),
                    retryAt,
                    error
                });
            }
            this.claimStore.fail(claim, this.workerIdentity, {
                error,
                retryAt,
                failureCode: error?.code || "FEED_INTENT_PROCESSING_FAILED"
            });
            throw error;
        }
    }

    scheduleHeartbeat() {
        if (!this.started) {
            return;
        }
        this.heartbeatTimer = setTimeout(() => {
            this.heartbeatTimer = null;
            if (this.eventStore.closed) {
                this.started = false;
                this.workerRegistered = false;
                return;
            }
            if (this.started) {
                this.claimStore.heartbeatWorker(this.workerIdentity);
                this.scheduleHeartbeat();
            }
        }, this.heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();
    }

    ensureWorkerRegistered() {
        if (!this.workerRegistered) {
            this.claimStore.registerWorker(this.workerIdentity);
            this.workerRegistered = true;
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
