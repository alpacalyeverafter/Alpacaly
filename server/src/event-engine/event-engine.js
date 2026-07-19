import { randomUUID } from "node:crypto";

import { ApplicationError } from "../errors/application-error.js";

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

export class EventEngine {
    constructor({ config, logger, clock = () => new Date(), idGenerator = randomUUID }) {
        this.config = config;
        this.logger = logger;
        this.clock = clock;
        this.idGenerator = idGenerator;
        this.feedRequests = new Map();
        this.queue = [];
        this.clientRequestIds = new Set();
        this.acceptedToday = 0;
        this.currentDateKey = localDateKey(this.clock());
    }

    submitFeedRequest(payload) {
        const input = this.validateFeedRequest(payload);
        const now = this.clock();
        this.rollDailyCounters(now);

        if (input.clientRequestId && this.clientRequestIds.has(input.clientRequestId)) {
            throw new ApplicationError("This feed request has already been received.", {
                code: "DUPLICATE_FEED_REQUEST",
                statusCode: 409
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
        const feedRequest = {
            id,
            type: "FEED_REQUEST",
            status: "QUEUED",
            supporterName: input.supporterName,
            source: input.source,
            message: input.message,
            clientRequestId: input.clientRequestId,
            requestedAt: now.toISOString()
        };

        this.feedRequests.set(id, feedRequest);
        this.queue.push(id);
        this.acceptedToday += 1;

        if (input.clientRequestId) {
            this.clientRequestIds.add(input.clientRequestId);
        }

        const queuePosition = this.queue.length;
        this.logger.info({
            event: "feed_request_queued",
            feedRequestId: id,
            clientRequestId: input.clientRequestId,
            source: input.source,
            queuePosition
        }, "Feed request queued");

        return {
            feedRequest: { ...feedRequest },
            queuePosition
        };
    }

    getFeedRequest(id) {
        const feedRequest = this.feedRequests.get(id);
        return feedRequest ? { ...feedRequest } : null;
    }

    getSnapshot() {
        const now = this.clock();
        this.rollDailyCounters(now);

        return {
            status: "READY",
            date: this.currentDateKey,
            queueSize: this.queue.length,
            acceptedToday: this.acceptedToday,
            feedsRemaining: Math.max(0, this.config.maxDailyFeeds - this.acceptedToday),
            feedingWindowEnforced: this.config.enforceFeedingWindow
        };
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
        this.acceptedToday = 0;
        this.clientRequestIds.clear();
    }
}
