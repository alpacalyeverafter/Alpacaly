// ============================================
// Alpacaly Ever After
// Central Event Engine, Version 1
// ============================================

class EventEngine {
    constructor(config, queue, hardware) {
        if (!config || !queue || !hardware) {
            throw new Error("EventEngine requires config, queue and hardware.");
        }

        this.config = config;
        this.queue = queue;
        this.hardware = hardware;
        this.processing = false;
        this.completedFeeds = 0;
        this.seenEventIds = new Set();
        this.eventHistory = [];
        this.listeners = new Set();

        this.state = {
            status: "READY",
            message: "Ready for the next supporter.",
            currentEvent: null,
            completedFeeds: 0,
            feedsRemaining: this.config.dailyFeedLimit,
            queueSize: 0,
            error: null
        };
    }

    subscribe(listener) {
        if (typeof listener !== "function") {
            return () => {};
        }

        this.listeners.add(listener);
        listener(this.getState());

        return () => this.listeners.delete(listener);
    }

    getState() {
        return {
            ...this.state,
            currentEvent: this.state.currentEvent
                ? { ...this.state.currentEvent }
                : null
        };
    }

    getEventHistory() {
        return this.eventHistory.map(entry => ({ ...entry }));
    }

    createDonationEvent({ supporterName, source = "website", amount = 0, message = "" }) {
        return {
            id: this.generateEventId(source),
            type: "FEED_DONATION",
            source: String(source || "website"),
            supporterName: this.cleanSupporterName(supporterName),
            amount: Number(amount) || 0,
            message: String(message || "").trim(),
            createdAt: new Date().toISOString()
        };
    }

    submitEvent(event) {
        const validation = this.validateEvent(event);

        if (!validation.valid) {
            this.logEvent(event, "REJECTED", validation.reason);
            return {
                accepted: false,
                reason: validation.reason,
                message: validation.message
            };
        }

        // Record the ID before queueing. Retries can never produce a second feed.
        this.seenEventIds.add(event.id);

        const welfareCheck = this.checkWelfareRules();
        if (!welfareCheck.allowed) {
            this.logEvent(event, "REJECTED", welfareCheck.reason);
            this.setState("UNAVAILABLE", welfareCheck.message, {
                currentEvent: null,
                error: welfareCheck.reason
            });

            return {
                accepted: false,
                reason: welfareCheck.reason,
                message: welfareCheck.message
            };
        }

        const queueResult = this.queue.add(event);
        if (!queueResult.accepted) {
            this.logEvent(event, "REJECTED", queueResult.reason);
            return {
                accepted: false,
                reason: queueResult.reason,
                message: "This event could not be added to the queue."
            };
        }

        this.logEvent(event, "QUEUED");
        this.setState("QUEUED", `Thank you, ${event.supporterName}. Your feed is queued.`, {
            currentEvent: event,
            error: null
        });

        // Deliberately not awaited. The UI receives an immediate acceptance result.
        void this.processQueue();

        return {
            accepted: true,
            event: { ...event },
            queuePosition: queueResult.position
        };
    }

    validateEvent(event) {
        if (!event || typeof event !== "object") {
            return { valid: false, reason: "INVALID_EVENT", message: "The event is invalid." };
        }

        if (!event.id || typeof event.id !== "string") {
            return { valid: false, reason: "EVENT_ID_REQUIRED", message: "Every event needs a unique ID." };
        }

        if (this.seenEventIds.has(event.id)) {
            return { valid: false, reason: "DUPLICATE_EVENT", message: "This event has already been received." };
        }

        if (event.type !== "FEED_DONATION") {
            return { valid: false, reason: "UNSUPPORTED_EVENT_TYPE", message: "This event type is not supported yet." };
        }

        if (!event.source) {
            return { valid: false, reason: "EVENT_SOURCE_REQUIRED", message: "The event source is required." };
        }

        return { valid: true, reason: null, message: null };
    }

    checkWelfareRules(now = new Date()) {
        if (this.completedFeeds >= this.config.dailyFeedLimit) {
            return {
                allowed: false,
                reason: "DAILY_LIMIT_REACHED",
                message: "Today's safe feeding limit has been reached."
            };
        }

        // Simulation mode lets the team test safely at any time.
        if (this.config.simulationMode) {
            return { allowed: true, reason: null, message: null };
        }

        if (!this.isWithinFeedingWindow(now)) {
            return {
                allowed: false,
                reason: "OUTSIDE_FEEDING_WINDOW",
                message: "Feeding is currently outside the approved animal-care window."
            };
        }

        return { allowed: true, reason: null, message: null };
    }

    isWithinFeedingWindow(now = new Date()) {
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        return this.config.feedingWindows.some(window => {
            const start = this.timeToMinutes(window.start);
            const end = this.timeToMinutes(window.end);
            return currentMinutes >= start && currentMinutes <= end;
        });
    }

    timeToMinutes(value) {
        const [hours, minutes] = String(value).split(":").map(Number);
        return hours * 60 + minutes;
    }

    async processQueue() {
        if (this.processing) {
            return;
        }

        this.processing = true;

        try {
            while (!this.queue.isEmpty()) {
                const event = this.queue.next();
                if (!event) {
                    break;
                }

                await this.processEvent(event);
            }
        } finally {
            this.processing = false;
            this.setState("READY", "Ready for the next supporter.", {
                currentEvent: null,
                error: null
            });
        }
    }

    async processEvent(event) {
        this.setState("PREPARING", `Preparing ${event.supporterName}'s feed.`, {
            currentEvent: event,
            error: null
        });
        this.logEvent(event, "PROCESSING");

        this.setState("CALLING_HERD", "Bell ringing. The animals are being alerted.", {
            currentEvent: event
        });

        const bellResult = await this.hardware.ringBell(event.id);
        if (!bellResult.success) {
            this.failEvent(event, "BELL_FAILED", bellResult.error || "Bell failed.");
            return;
        }

        this.setState("FEEDING", "A measured demo feed is being released.", {
            currentEvent: event
        });

        const feedResult = await this.hardware.dispenseFeed(event.id);
        if (!feedResult.success) {
            this.failEvent(event, "FEEDER_FAILED", feedResult.error || "Feeder failed.");
            return;
        }

        this.completedFeeds += 1;
        this.logEvent(event, "COMPLETED", null, {
            hardwareConfirmation: "HARDWARE_SEQUENCE_CONFIRMED",
            bellResult,
            feedResult
        });

        this.setState("COMPLETE", `Feed complete. Thank you, ${event.supporterName}.`, {
            currentEvent: event,
            error: null
        });

        await this.delay(this.config.completeDelay);
    }

    failEvent(event, reason, message) {
        this.logEvent(event, "FAILED", reason);
        this.setState("ERROR", message, {
            currentEvent: event,
            error: reason
        });
    }

    logEvent(event, status, reason = null, details = {}) {
        this.eventHistory.push({
            eventId: event && event.id ? event.id : null,
            type: event && event.type ? event.type : null,
            source: event && event.source ? event.source : null,
            supporterName: event && event.supporterName ? event.supporterName : null,
            status,
            reason,
            recordedAt: new Date().toISOString(),
            ...details
        });
    }

    setState(status, message, extra = {}) {
        this.state = {
            ...this.state,
            ...extra,
            status,
            message,
            completedFeeds: this.completedFeeds,
            feedsRemaining: Math.max(0, this.config.dailyFeedLimit - this.completedFeeds),
            queueSize: this.queue.size()
        };

        const snapshot = this.getState();
        this.listeners.forEach(listener => {
            try {
                listener(snapshot);
            } catch (error) {
                console.error("[EventEngine] Listener failed:", error);
            }
        });
    }

    cleanSupporterName(name) {
        const cleaned = String(name || "").trim();
        return cleaned || "Anonymous supporter";
    }

    generateEventId(source = "event") {
        const randomPart = Math.random().toString(36).slice(2, 10);
        return `${source}-${Date.now()}-${randomPart}`;
    }

    delay(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }
}

const eventEngine = new EventEngine(CONFIG, eventQueue, hardwareController);
