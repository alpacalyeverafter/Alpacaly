import { randomUUID } from "node:crypto";

import { ApplicationError } from "../errors/application-error.js";
import { SqliteEventStore } from "../event-store/sqlite-event-store.js";
import {
    FEED_LIFECYCLE_STATES,
    HARDWARE_ACKNOWLEDGEMENT_STAGES,
    PREVIOUS_LIFECYCLE_STATE,
    isLifecycleState
} from "./lifecycle.js";

const MAX_SUPPORTER_NAME_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 500;
const MAX_SOURCE_LENGTH = 50;
const MAX_CLIENT_REQUEST_ID_LENGTH = 128;

function timeToMinutes(value) {
    const [hours, minutes] = value.split(":").map(Number);
    return (hours * 60) + minutes;
}

function localDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function defaultSleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            const error = new Error("Lifecycle delay was cancelled.");
            error.name = "AbortError";
            reject(error);
            return;
        }

        const timeoutId = setTimeout(() => {
            if (signal) {
                signal.removeEventListener("abort", cancel);
            }
            resolve();
        }, milliseconds);

        function cancel() {
            clearTimeout(timeoutId);
            const error = new Error("Lifecycle delay was cancelled.");
            error.name = "AbortError";
            reject(error);
        }

        if (signal) {
            signal.addEventListener("abort", cancel, { once: true });
        }
    });
}

function clone(value) {
    return structuredClone(value);
}

export class EventEngine {
    constructor({
        config,
        logger,
        clock = () => new Date(),
        idGenerator = randomUUID,
        sleep = defaultSleep,
        autoProcess = true,
        eventStore = null
    }) {
        this.config = config;
        this.logger = logger;
        this.clock = clock;
        this.idGenerator = idGenerator;
        this.sleep = sleep;
        this.autoProcess = autoProcess;
        this.eventStore = eventStore || new SqliteEventStore({
            databasePath: config.databasePath || ":memory:",
            logger
        });

        this.feedRequests = new Map();
        this.queue = [];
        this.archivedEventIds = [];
        this.clientRequestIds = new Map();
        this.processingEventIds = new Set();
        this.processedEventIds = new Set();
        this.listeners = new Set();
        this.idleResolvers = new Set();

        this.processing = false;
        this.processingScheduled = false;
        this.activeEventId = null;
        this.lifecycleGeneration = 0;
        this.lifecycleAbortController = new AbortController();
        this.shuttingDown = false;
        this.sequenceNumber = 0;
        this.acceptedToday = 0;
        this.completedToday = 0;
        this.lastUpdatedAt = null;
        this.currentDateKey = localDateKey(this.clock());

        this.restoreFromEventStore();
        this.scheduleProcessing();
    }

    submitFeedRequest(payload) {
        const input = this.validateFeedRequest(payload);
        const now = this.clock();
        this.rollDailyCounters(now);

        if (input.clientRequestId && this.clientRequestIds.has(input.clientRequestId)) {
            throw new ApplicationError("This feed request has already been received.", {
                code: "DUPLICATE_FEED_REQUEST",
                statusCode: 409,
                details: {
                    eventId: this.clientRequestIds.get(input.clientRequestId)
                }
            });
        }

        if (this.acceptedToday >= this.config.maxDailyFeeds) {
            throw new ApplicationError("Today's safe feeding limit has been reached.", {
                code: "DAILY_FEED_LIMIT_REACHED",
                statusCode: 409
            });
        }

        if (this.config.enforceFeedingWindow && !this.isWithinFeedingWindow(now)) {
            throw new ApplicationError("Feed requests are currently outside the approved feeding window.", {
                code: "OUTSIDE_FEEDING_WINDOW",
                statusCode: 409
            });
        }

        const id = `feed_${this.idGenerator()}`;
        if (this.feedRequests.has(id)) {
            throw new ApplicationError("A unique Event ID could not be allocated.", {
                code: "EVENT_ID_COLLISION",
                statusCode: 500
            });
        }

        const previousSequenceNumber = this.sequenceNumber;
        const previousLastUpdatedAt = this.lastUpdatedAt;
        const feedRequest = {
            id,
            eventId: id,
            type: "FEED_REQUEST",
            state: null,
            status: null,
            sequenceNumber: ++this.sequenceNumber,
            supporterName: input.supporterName,
            source: input.source,
            message: input.message,
            clientRequestId: input.clientRequestId,
            requestedAt: now.toISOString(),
            updatedAt: now.toISOString(),
            stateTimestamps: {},
            timeline: [],
            hardwareAcknowledgements: {
                BELL: null,
                DISPENSING: null
            },
            acknowledgementHistory: []
        };

        this.feedRequests.set(id, feedRequest);
        this.transitionTo(
            feedRequest,
            "RECEIVED",
            { source: input.source },
            { persist: false, emit: false }
        );
        this.transitionTo(
            feedRequest,
            "VALIDATED",
            { validation: "PASSED" },
            { persist: false, emit: false }
        );

        this.queue.push(id);
        this.acceptedToday += 1;
        if (input.clientRequestId) {
            this.clientRequestIds.set(input.clientRequestId, id);
        }

        const queuePosition = this.queue.length;
        this.transitionTo(
            feedRequest,
            "QUEUED",
            { queuePosition },
            { persist: false, emit: false }
        );

        try {
            this.eventStore.createQueuedEvent(feedRequest);
        } catch (error) {
            this.feedRequests.delete(id);
            this.queue.pop();
            this.acceptedToday -= 1;
            this.sequenceNumber = previousSequenceNumber;
            this.lastUpdatedAt = previousLastUpdatedAt;
            if (input.clientRequestId) {
                this.clientRequestIds.delete(input.clientRequestId);
            }

            this.logger.error({
                event: "feed_request_persistence_failed",
                eventId: id,
                err: error
            }, "Feed request could not be persisted");
            throw new ApplicationError("The feed request could not be stored.", {
                code: "EVENT_STORE_WRITE_FAILED",
                statusCode: 500
            });
        }

        feedRequest.timeline.forEach(entry => {
            this.emitTransition(feedRequest, entry);
        });

        this.logger.info({
            event: "feed_request_queued",
            eventId: id,
            clientRequestId: input.clientRequestId,
            source: input.source,
            sequenceNumber: feedRequest.sequenceNumber,
            queuePosition
        }, "Feed request queued");

        this.scheduleProcessing();

        return {
            feedRequest: this.getFeedRequest(id),
            queuePosition,
            estimatedWaitMs: this.estimateWaitForQueueIndex(queuePosition - 1)
        };
    }

    getFeedRequest(id) {
        const feedRequest = this.feedRequests.get(id);
        if (!feedRequest) {
            return null;
        }

        const queueIndex = this.queue.indexOf(id);
        return {
            ...this.cloneFeedRequest(feedRequest),
            queuePosition: queueIndex >= 0 ? queueIndex + 1 : null,
            estimatedWaitMs: queueIndex >= 0
                ? this.estimateWaitForQueueIndex(queueIndex)
                : 0
        };
    }

    getQueueSummary() {
        return this.queue
            .map((id, index) => {
                const feedRequest = this.feedRequests.get(id);
                return feedRequest
                    ? this.summarizeFeedRequest(feedRequest, { queuePosition: index + 1 })
                    : null;
            })
            .filter(Boolean);
    }

    getArchivedSummary() {
        return this.archivedEventIds
            .map(id => this.feedRequests.get(id))
            .filter(Boolean)
            .map(feedRequest => this.summarizeFeedRequest(feedRequest));
    }

    subscribe(listener) {
        if (typeof listener !== "function") {
            return () => {};
        }

        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    recordHardwareAcknowledgement(eventId, stage, acknowledgement = {}) {
        const normalizedStage = String(stage || "").trim().toUpperCase();
        if (!HARDWARE_ACKNOWLEDGEMENT_STAGES.includes(normalizedStage)) {
            throw new ApplicationError("Hardware acknowledgements are only supported for BELL and DISPENSING.", {
                code: "INVALID_ACKNOWLEDGEMENT_STAGE",
                statusCode: 400
            });
        }

        const feedRequest = this.feedRequests.get(eventId);
        if (!feedRequest) {
            throw new ApplicationError("Feed request not found.", {
                code: "FEED_REQUEST_NOT_FOUND",
                statusCode: 404
            });
        }

        const entry = {
            stage: normalizedStage,
            status: String(acknowledgement.status || "ACKNOWLEDGED"),
            receivedAt: this.clock().toISOString(),
            details: acknowledgement.details || null
        };

        this.eventStore.addHardwareAcknowledgement(eventId, entry);
        feedRequest.hardwareAcknowledgements[normalizedStage] = entry;
        feedRequest.acknowledgementHistory.push(entry);
        feedRequest.updatedAt = entry.receivedAt;
        this.lastUpdatedAt = entry.receivedAt;
        this.emit({
            type: "HARDWARE_ACKNOWLEDGED",
            eventId,
            acknowledgement: clone(entry),
            feedRequest: this.summarizeFeedRequest(feedRequest),
            eventEngine: this.getSnapshot()
        });

        return clone(entry);
    }

    reset() {
        const clearedRequests = this.feedRequests.size;
        this.eventStore.clearAll();
        this.lifecycleAbortController.abort();
        this.lifecycleAbortController = new AbortController();
        this.lifecycleGeneration += 1;
        this.feedRequests.clear();
        this.queue = [];
        this.archivedEventIds = [];
        this.clientRequestIds.clear();
        this.processingEventIds.clear();
        this.processedEventIds.clear();
        this.processing = false;
        this.processingScheduled = false;
        this.activeEventId = null;
        this.acceptedToday = 0;
        this.completedToday = 0;
        this.sequenceNumber = 0;
        this.lastUpdatedAt = this.clock().toISOString();
        this.currentDateKey = localDateKey(this.clock());
        this.resolveIdleWaiters();

        this.logger.info({
            event: "event_engine_reset",
            clearedRequests
        }, "Event Engine reset");

        const snapshot = this.getSnapshot();
        this.emit({
            type: "EVENT_ENGINE_RESET",
            eventEngine: snapshot
        });
        return snapshot;
    }

    getSnapshot() {
        const now = this.clock();
        this.rollDailyCounters(now);
        const activeEvent = this.activeEventId
            ? this.feedRequests.get(this.activeEventId)
            : null;

        return {
            status: activeEvent
                ? activeEvent.state
                : this.queue.length > 0 ? "QUEUED" : "READY",
            date: this.currentDateKey,
            queueSize: this.queue.length,
            waitingQueueSize: Math.max(0, this.queue.length - (activeEvent ? 1 : 0)),
            acceptedToday: this.acceptedToday,
            completedFeeds: this.completedToday,
            archivedCount: this.archivedEventIds.length,
            feedsRemaining: Math.max(0, this.config.maxDailyFeeds - this.acceptedToday),
            feedingWindowEnforced: this.config.enforceFeedingWindow,
            activeEvent: activeEvent ? this.summarizeFeedRequest(activeEvent) : null,
            lastUpdatedAt: this.lastUpdatedAt
        };
    }

    async processQueue() {
        if (this.processing) {
            return this.waitForIdle();
        }

        this.processing = true;
        const generation = this.lifecycleGeneration;

        try {
            while (this.queue.length > 0 && generation === this.lifecycleGeneration) {
                const eventId = this.queue[0];
                const feedRequest = this.feedRequests.get(eventId);

                if (!feedRequest || this.processedEventIds.has(eventId)) {
                    this.eventStore.removeFromQueue(eventId);
                    this.queue.shift();
                    continue;
                }

                if (this.processingEventIds.has(eventId)) {
                    throw new ApplicationError("Duplicate lifecycle processing was prevented.", {
                        code: "DUPLICATE_EVENT_PROCESSING",
                        statusCode: 500
                    });
                }

                this.processingEventIds.add(eventId);
                this.activeEventId = eventId;

                let archived = false;
                try {
                    archived = await this.runLifecycle(feedRequest, generation);
                } finally {
                    this.processingEventIds.delete(eventId);
                }

                if (!archived || generation !== this.lifecycleGeneration) {
                    break;
                }

                if (this.queue[0] !== eventId) {
                    throw new ApplicationError("Feed queue order changed during processing.", {
                        code: "QUEUE_ORDER_VIOLATION",
                        statusCode: 500
                    });
                }

                this.eventStore.removeFromQueue(eventId);
                this.queue.shift();
                this.processedEventIds.add(eventId);
                this.archivedEventIds.push(eventId);
                this.activeEventId = null;
                this.emitEngineUpdate("EVENT_ARCHIVED");
            }
        } catch (error) {
            this.logger.error({
                event: "event_lifecycle_failed",
                eventId: this.activeEventId,
                err: error
            }, "Event lifecycle failed");
        } finally {
            if (generation === this.lifecycleGeneration || this.shuttingDown) {
                this.processing = false;
                this.processingScheduled = false;
                this.activeEventId = null;
                this.emitEngineUpdate("QUEUE_IDLE");
                this.resolveIdleWaiters();
            }
        }
    }

    waitForIdle() {
        if (!this.processing && !this.processingScheduled && this.queue.length === 0) {
            return Promise.resolve();
        }

        return new Promise(resolve => {
            this.idleResolvers.add(resolve);
        });
    }

    async runLifecycle(feedRequest, generation) {
        if (feedRequest.state === "QUEUED") {
            this.transitionTo(feedRequest, "APPROVED", {
                approval: "AUTOMATIC_PHASE_4"
            });
        }

        if (feedRequest.state === "APPROVED") {
            this.transitionTo(feedRequest, "COUNTDOWN", {
                mode: "SIMULATED",
                durationMs: this.config.lifecycleCountdownMs
            });
        }

        if (feedRequest.state === "COUNTDOWN") {
            if (!await this.waitForStage(
                feedRequest,
                "COUNTDOWN",
                this.config.lifecycleCountdownMs,
                generation
            )) {
                return false;
            }

            this.transitionTo(feedRequest, "BELL", {
                mode: "SIMULATED",
                hardwareAcknowledgement: {
                    supported: true,
                    required: false,
                    status: "NOT_REQUIRED"
                },
                durationMs: this.config.lifecycleBellMs
            });
        }

        if (feedRequest.state === "BELL") {
            if (!await this.waitForStage(
                feedRequest,
                "BELL",
                this.config.lifecycleBellMs,
                generation
            )) {
                return false;
            }

            this.transitionTo(feedRequest, "DISPENSING", {
                mode: "SIMULATED",
                hardwareAcknowledgement: {
                    supported: true,
                    required: false,
                    status: "NOT_REQUIRED"
                },
                durationMs: this.config.lifecycleDispensingMs
            });
        }

        if (feedRequest.state === "DISPENSING") {
            if (!await this.waitForStage(
                feedRequest,
                "DISPENSING",
                this.config.lifecycleDispensingMs,
                generation
            )) {
                return false;
            }

            this.completedToday += 1;
            try {
                this.transitionTo(feedRequest, "COMPLETE", {
                    mode: "SIMULATED_LIFECYCLE"
                });
            } catch (error) {
                this.completedToday -= 1;
                throw error;
            }
        }

        if (feedRequest.state === "COMPLETE") {
            if (!await this.waitForStage(
                feedRequest,
                "COMPLETE",
                this.config.lifecycleArchiveDelayMs,
                generation
            )) {
                return false;
            }

            this.transitionTo(feedRequest, "ARCHIVED", {
                archive: "SQLITE"
            });
        }

        if (feedRequest.state !== "ARCHIVED") {
            throw new ApplicationError(`Cannot resume lifecycle from ${feedRequest.state}.`, {
                code: "INVALID_PERSISTED_LIFECYCLE_STATE",
                statusCode: 500
            });
        }

        return true;
    }

    async waitForStage(feedRequest, state, durationMs, generation) {
        const startedAt = Date.parse(feedRequest.stateTimestamps[state]);
        const elapsedMs = Number.isFinite(startedAt)
            ? Math.max(0, this.clock().getTime() - startedAt)
            : 0;
        const remainingMs = Math.max(0, durationMs - elapsedMs);

        try {
            await this.sleep(remainingMs, this.lifecycleAbortController.signal);
        } catch (error) {
            if (error && error.name === "AbortError") {
                return false;
            }
            throw error;
        }
        return generation === this.lifecycleGeneration
            && this.feedRequests.has(feedRequest.id);
    }

    transitionTo(feedRequest, nextState, details = {}, { persist = true, emit = true } = {}) {
        if (!isLifecycleState(nextState)) {
            throw new ApplicationError("Unknown feed lifecycle state.", {
                code: "UNKNOWN_LIFECYCLE_STATE",
                statusCode: 500
            });
        }

        if (feedRequest.state === nextState) {
            throw new ApplicationError("Duplicate lifecycle transition was prevented.", {
                code: "DUPLICATE_LIFECYCLE_TRANSITION",
                statusCode: 500
            });
        }

        const expectedPreviousState = PREVIOUS_LIFECYCLE_STATE[nextState];
        if (feedRequest.state !== expectedPreviousState) {
            throw new ApplicationError(
                `Invalid lifecycle transition from ${feedRequest.state || "NONE"} to ${nextState}.`,
                {
                    code: "INVALID_LIFECYCLE_TRANSITION",
                    statusCode: 500
                }
            );
        }

        const timestamp = this.clock().toISOString();
        const timelineEntry = {
            state: nextState,
            timestamp,
            details: clone(details)
        };

        if (persist) {
            this.eventStore.appendLifecycleTransition(feedRequest, timelineEntry);
        }

        feedRequest.state = nextState;
        feedRequest.status = nextState;
        feedRequest.updatedAt = timestamp;
        feedRequest.stateTimestamps[nextState] = timestamp;
        feedRequest.timeline.push(timelineEntry);
        this.lastUpdatedAt = timestamp;

        this.logger.info({
            event: "feed_request_state_changed",
            eventId: feedRequest.id,
            sequenceNumber: feedRequest.sequenceNumber,
            state: nextState,
            timestamp
        }, "Feed request state changed");

        if (emit) {
            this.emitTransition(feedRequest, timelineEntry);
        }
    }

    validateFeedRequest(payload) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new ApplicationError("The request body must be a JSON object.", {
                code: "VALIDATION_ERROR",
                statusCode: 400,
                details: ["body must be an object"]
            });
        }

        const details = [];
        const supporterName = typeof payload.supporterName === "string"
            ? payload.supporterName.trim()
            : "";

        if (!supporterName) {
            details.push("supporterName is required");
        } else if (supporterName.length > MAX_SUPPORTER_NAME_LENGTH) {
            details.push(`supporterName must be ${MAX_SUPPORTER_NAME_LENGTH} characters or fewer`);
        }

        const source = payload.source === undefined ? "website" : payload.source;
        if (typeof source !== "string" || !source.trim()) {
            details.push("source must be a non-empty string");
        } else if (source.trim().length > MAX_SOURCE_LENGTH) {
            details.push(`source must be ${MAX_SOURCE_LENGTH} characters or fewer`);
        }

        const message = payload.message === undefined ? "" : payload.message;
        if (typeof message !== "string") {
            details.push("message must be a string");
        } else if (message.trim().length > MAX_MESSAGE_LENGTH) {
            details.push(`message must be ${MAX_MESSAGE_LENGTH} characters or fewer`);
        }

        const clientRequestId = payload.clientRequestId === undefined ? null : payload.clientRequestId;
        if (clientRequestId !== null && (typeof clientRequestId !== "string" || !clientRequestId.trim())) {
            details.push("clientRequestId must be a non-empty string when provided");
        } else if (typeof clientRequestId === "string" && clientRequestId.trim().length > MAX_CLIENT_REQUEST_ID_LENGTH) {
            details.push(`clientRequestId must be ${MAX_CLIENT_REQUEST_ID_LENGTH} characters or fewer`);
        }

        if (details.length > 0) {
            throw new ApplicationError("The feed request is invalid.", {
                code: "VALIDATION_ERROR",
                statusCode: 400,
                details
            });
        }

        return {
            supporterName,
            source: source.trim(),
            message: message.trim(),
            clientRequestId: clientRequestId === null ? null : clientRequestId.trim()
        };
    }

    isWithinFeedingWindow(now) {
        const currentMinutes = (now.getHours() * 60) + now.getMinutes();
        const startMinutes = timeToMinutes(this.config.feedingWindowStart);
        const endMinutes = timeToMinutes(this.config.feedingWindowEnd);

        if (startMinutes <= endMinutes) {
            return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
        }

        return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    }

    rollDailyCounters(now) {
        const dateKey = localDateKey(now);
        if (dateKey === this.currentDateKey) {
            return;
        }

        this.currentDateKey = dateKey;
        this.recalculateDailyCounters();
    }

    restoreFromEventStore() {
        const restored = this.eventStore.loadState();
        const queuedEventIds = new Set(restored.queueEventIds);

        restored.events.forEach(feedRequest => {
            this.validateRestoredEvent(feedRequest);
            this.feedRequests.set(feedRequest.eventId, feedRequest);
            this.sequenceNumber = Math.max(this.sequenceNumber, feedRequest.sequenceNumber);

            if (feedRequest.clientRequestId) {
                this.clientRequestIds.set(feedRequest.clientRequestId, feedRequest.eventId);
            }

            if (feedRequest.state === "ARCHIVED") {
                this.archivedEventIds.push(feedRequest.eventId);
                this.processedEventIds.add(feedRequest.eventId);
            } else if (!queuedEventIds.has(feedRequest.eventId)) {
                throw new Error(
                    `Persistent event ${feedRequest.eventId} is ${feedRequest.state} but is missing from Queue.`
                );
            }

            if (!this.lastUpdatedAt || feedRequest.updatedAt > this.lastUpdatedAt) {
                this.lastUpdatedAt = feedRequest.updatedAt;
            }
        });

        restored.queueEventIds.forEach(eventId => {
            const feedRequest = this.feedRequests.get(eventId);
            if (!feedRequest) {
                throw new Error(`Queue references unknown persistent event ${eventId}.`);
            }

            if (feedRequest.state === "ARCHIVED") {
                this.eventStore.removeFromQueue(eventId);
                return;
            }

            this.queue.push(eventId);
        });

        this.recalculateDailyCounters();
        this.logger.info({
            event: "event_store_restored",
            eventCount: this.feedRequests.size,
            queueSize: this.queue.length,
            archivedCount: this.archivedEventIds.length
        }, "Event Engine state restored from SQLite");
    }

    validateRestoredEvent(feedRequest) {
        if (!isLifecycleState(feedRequest.state)) {
            throw new Error(`Persistent event ${feedRequest.eventId} has an invalid state.`);
        }

        const stateIndex = FEED_LIFECYCLE_STATES.indexOf(feedRequest.state);
        const expectedStates = FEED_LIFECYCLE_STATES.slice(0, stateIndex + 1);
        const restoredStates = feedRequest.timeline.map(entry => entry.state);
        if (
            expectedStates.length !== restoredStates.length
            || expectedStates.some((state, index) => state !== restoredStates[index])
        ) {
            throw new Error(`Persistent lifecycle history is invalid for ${feedRequest.eventId}.`);
        }
    }

    recalculateDailyCounters() {
        this.acceptedToday = 0;
        this.completedToday = 0;

        this.feedRequests.forEach(feedRequest => {
            if (localDateKey(new Date(feedRequest.requestedAt)) === this.currentDateKey) {
                this.acceptedToday += 1;
            }

            const completedAt = feedRequest.stateTimestamps.COMPLETE;
            if (completedAt && localDateKey(new Date(completedAt)) === this.currentDateKey) {
                this.completedToday += 1;
            }
        });
    }

    estimateWaitForQueueIndex(queueIndex) {
        if (!Number.isInteger(queueIndex) || queueIndex <= 0) {
            return 0;
        }

        return this.queue
            .slice(0, queueIndex)
            .reduce((total, eventId) => {
                const feedRequest = this.feedRequests.get(eventId);
                return total + (feedRequest ? this.estimateRemainingLifecycleMs(feedRequest) : 0);
            }, 0);
    }

    estimateRemainingLifecycleMs(feedRequest) {
        const durations = {
            countdown: this.config.lifecycleCountdownMs,
            bell: this.config.lifecycleBellMs,
            dispensing: this.config.lifecycleDispensingMs,
            archive: this.config.lifecycleArchiveDelayMs
        };

        switch (feedRequest.state) {
            case "RECEIVED":
            case "VALIDATED":
            case "QUEUED":
            case "APPROVED":
                return durations.countdown
                    + durations.bell
                    + durations.dispensing
                    + durations.archive;
            case "COUNTDOWN":
                return this.remainingStageMs(feedRequest, "COUNTDOWN", durations.countdown)
                    + durations.bell
                    + durations.dispensing
                    + durations.archive;
            case "BELL":
                return this.remainingStageMs(feedRequest, "BELL", durations.bell)
                    + durations.dispensing
                    + durations.archive;
            case "DISPENSING":
                return this.remainingStageMs(feedRequest, "DISPENSING", durations.dispensing)
                    + durations.archive;
            case "COMPLETE":
                return this.remainingStageMs(feedRequest, "COMPLETE", durations.archive);
            case "ARCHIVED":
            default:
                return 0;
        }
    }

    remainingStageMs(feedRequest, state, durationMs) {
        const startedAt = Date.parse(feedRequest.stateTimestamps[state]);
        if (!Number.isFinite(startedAt)) {
            return durationMs;
        }

        return Math.max(0, durationMs - Math.max(0, this.clock().getTime() - startedAt));
    }

    scheduleProcessing() {
        if (
            !this.autoProcess
            || this.queue.length === 0
            || this.processing
            || this.processingScheduled
        ) {
            return;
        }

        this.processingScheduled = true;
        queueMicrotask(() => {
            this.processingScheduled = false;
            if (!this.autoProcess || this.shuttingDown) {
                this.resolveIdleWaiters();
                return;
            }
            void this.processQueue();
        });
    }

    resolveIdleWaiters() {
        this.idleResolvers.forEach(resolve => resolve());
        this.idleResolvers.clear();
    }

    summarizeFeedRequest(feedRequest, extra = {}) {
        const queueIndex = this.queue.indexOf(feedRequest.eventId);
        return {
            id: feedRequest.id,
            eventId: feedRequest.eventId,
            supporterName: feedRequest.supporterName,
            source: feedRequest.source,
            state: feedRequest.state,
            status: feedRequest.status,
            sequenceNumber: feedRequest.sequenceNumber,
            requestedAt: feedRequest.requestedAt,
            updatedAt: feedRequest.updatedAt,
            stateTimestamps: clone(feedRequest.stateTimestamps),
            timeline: clone(feedRequest.timeline),
            hardwareAcknowledgements: clone(feedRequest.hardwareAcknowledgements),
            queuePosition: queueIndex >= 0 ? queueIndex + 1 : null,
            estimatedWaitMs: queueIndex >= 0
                ? this.estimateWaitForQueueIndex(queueIndex)
                : 0,
            ...extra
        };
    }

    cloneFeedRequest(feedRequest) {
        return clone(feedRequest);
    }

    emitTransition(feedRequest, timelineEntry) {
        const transitionIndex = feedRequest.timeline.indexOf(timelineEntry);
        const feedRequestAtTransition = this.summarizeFeedRequest(feedRequest);

        if (transitionIndex >= 0 && transitionIndex < feedRequest.timeline.length - 1) {
            const timeline = feedRequest.timeline.slice(0, transitionIndex + 1);
            feedRequestAtTransition.state = timelineEntry.state;
            feedRequestAtTransition.status = timelineEntry.state;
            feedRequestAtTransition.updatedAt = timelineEntry.timestamp;
            feedRequestAtTransition.timeline = clone(timeline);
            feedRequestAtTransition.stateTimestamps = Object.fromEntries(
                timeline.map(entry => [entry.state, entry.timestamp])
            );
        }

        this.emit({
            type: "FEED_REQUEST_STATE_CHANGED",
            eventId: feedRequest.id,
            state: timelineEntry.state,
            timestamp: timelineEntry.timestamp,
            timelineEntry: clone(timelineEntry),
            feedRequest: feedRequestAtTransition,
            eventEngine: this.getSnapshot()
        });
    }

    emitEngineUpdate(reason) {
        this.emit({
            type: "EVENT_ENGINE_UPDATED",
            reason,
            eventEngine: this.getSnapshot()
        });
    }

    emit(payload) {
        this.listeners.forEach(listener => {
            try {
                listener(clone(payload));
            } catch (error) {
                this.logger.error({
                    event: "event_engine_listener_failed",
                    err: error
                }, "Event Engine listener failed");
            }
        });
    }

    close() {
        if (this.processing || this.processingScheduled) {
            throw new Error("Event Engine cannot close while lifecycle processing is active.");
        }

        this.eventStore.close();
    }

    async shutdown() {
        if (this.shuttingDown) {
            return;
        }

        this.shuttingDown = true;
        this.autoProcess = false;
        this.lifecycleGeneration += 1;
        this.lifecycleAbortController.abort();

        if (this.processing) {
            await new Promise(resolve => {
                this.idleResolvers.add(resolve);
            });
        }

        this.processingScheduled = false;
        this.eventStore.close();
    }
}

export { FEED_LIFECYCLE_STATES };
