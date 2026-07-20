// ============================================
// Alpacaly Ever After
// Server-backed Event Engine adapter
// ============================================

(function exposeServerEventEngine(global) {
    "use strict";

    class ServerEventEngine {
        constructor(config, apiClient, { autoStart = true } = {}) {
            if (!config || !apiClient) {
                throw new Error("ServerEventEngine requires config and apiClient.");
            }

            this.config = config;
            this.apiClient = apiClient;
            this.listeners = new Set();
            this.pollTimerId = null;
            this.lifecycleStreamClose = null;
            this.state = {
                status: "CONNECTING",
                message: "Connecting to the feed service.",
                currentEvent: null,
                trackedEvent: null,
                completedFeeds: 0,
                acceptedToday: 0,
                feedsRemaining: this.config.DEMO_MAX_FEEDS,
                queueSize: 0,
                backendAvailable: null,
                error: null
            };

            if (autoStart) {
                void this.refreshStatus();
                this.startRealtimeUpdates();
                this.startPolling();
            }
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
                    : null,
                trackedEvent: this.state.trackedEvent
                    ? { ...this.state.trackedEvent }
                    : null
            };
        }

        createDonationEvent({ supporterName, source = "website", message = "" }) {
            const clientRequestId = this.generateClientRequestId(source);
            return {
                id: clientRequestId,
                type: "FEED_REQUEST",
                clientRequestId,
                source: String(source || "website"),
                supporterName: this.cleanSupporterName(supporterName),
                message: String(message || "").trim(),
                createdAt: new Date().toISOString()
            };
        }

        async submitEvent(event) {
            try {
                const response = await this.apiClient.createFeedRequest({
                    supporterName: event && event.supporterName,
                    source: event && event.source,
                    message: event && event.message,
                    clientRequestId: event && (event.clientRequestId || event.id)
                });

                this.applySnapshot(response.eventEngine, {
                    message: `Thank you, ${response.feedRequest.supporterName}. Your feed is queued.`
                });

                const trackedEvent = this.setTrackedEvent({
                    ...response.feedRequest,
                    queuePosition: response.feedRequest.queuePosition ?? response.queuePosition,
                    estimatedWaitMs: response.feedRequest.estimatedWaitMs
                        ?? response.estimatedWaitMs
                        ?? 0
                });
                void this.refreshTrackedEvent();

                return {
                    accepted: true,
                    event: trackedEvent,
                    queuePosition: trackedEvent.queuePosition,
                    estimatedWaitMs: trackedEvent.estimatedWaitMs
                };
            } catch (error) {
                this.handleApiError(error);
                return {
                    accepted: false,
                    reason: error.code || "API_ERROR",
                    message: error.message || "The feed request could not be submitted."
                };
            }
        }

        async refreshStatus() {
            try {
                const response = await this.apiClient.getEventEngineStatus();
                this.applySnapshot(response.eventEngine);
                return { success: true, state: this.getState() };
            } catch (error) {
                this.handleApiError(error);
                return {
                    success: false,
                    reason: error.code || "API_ERROR",
                    message: error.message
                };
            }
        }

        async getQueue() {
            try {
                const response = await this.apiClient.listFeedRequests();
                return {
                    success: true,
                    feedRequests: Array.isArray(response.feedRequests)
                        ? response.feedRequests.map(entry => ({ ...entry }))
                        : [],
                    archivedFeedRequests: Array.isArray(response.archivedFeedRequests)
                        ? response.archivedFeedRequests.map(entry => ({ ...entry }))
                        : []
                };
            } catch (error) {
                this.handleApiError(error);
                return {
                    success: false,
                    feedRequests: [],
                    archivedFeedRequests: [],
                    reason: error.code || "API_ERROR",
                    message: error.message
                };
            }
        }

        async refreshTrackedEvent() {
            const trackedEvent = this.state.trackedEvent;
            if (
                !trackedEvent
                || !trackedEvent.eventId
                || typeof this.apiClient.getFeedRequest !== "function"
            ) {
                return { success: true, event: trackedEvent };
            }

            try {
                const response = await this.apiClient.getFeedRequest(trackedEvent.eventId);
                if (
                    !this.state.trackedEvent
                    || this.state.trackedEvent.eventId !== trackedEvent.eventId
                ) {
                    return {
                        success: true,
                        stale: true,
                        event: this.state.trackedEvent
                    };
                }

                return {
                    success: true,
                    event: this.setTrackedEvent(response.feedRequest)
                };
            } catch (error) {
                if (error && error.code === "FEED_REQUEST_NOT_FOUND") {
                    if (
                        this.state.trackedEvent
                        && this.state.trackedEvent.eventId === trackedEvent.eventId
                    ) {
                        this.setState({ trackedEvent: null });
                    }
                    return { success: false, reason: error.code, event: null };
                }

                this.handleApiError(error);
                return {
                    success: false,
                    reason: error.code || "API_ERROR",
                    message: error.message,
                    event: trackedEvent
                };
            }
        }

        async resetDemo() {
            try {
                const response = await this.apiClient.resetEventEngine();
                this.applySnapshot(response.eventEngine, {
                    message: "Demo queue reset. Ready for the next supporter."
                });
                this.setState({ trackedEvent: null });
                return { success: true, state: this.getState() };
            } catch (error) {
                this.handleApiError(error);
                return {
                    success: false,
                    reason: error.code || "API_ERROR",
                    message: error.message
                };
            }
        }

        applySnapshot(snapshot, { message = null } = {}) {
            if (!snapshot || typeof snapshot !== "object") {
                return;
            }

            const status = snapshot.status || "READY";
            const defaultMessage = this.getLifecycleMessage(status, snapshot);
            const safetyMessage = snapshot.availability?.available === false
                ? snapshot.availability.message
                : null;

            this.setState({
                status,
                message: safetyMessage || message || defaultMessage,
                currentEvent: snapshot.activeEvent
                    ? { ...snapshot.activeEvent }
                    : null,
                completedFeeds: Number(snapshot.completedFeeds) || 0,
                acceptedToday: Number(snapshot.acceptedToday) || 0,
                feedsRemaining: Number(snapshot.feedsRemaining) || 0,
                queueSize: Number(snapshot.queueSize) || 0,
                backendAvailable: true,
                error: null
            });
        }

        handleApiError(error) {
            const serviceUnavailable = [
                "API_UNAVAILABLE",
                "REQUEST_TIMEOUT",
                "FETCH_UNAVAILABLE",
                "INVALID_API_RESPONSE"
            ].includes(error && error.code);

            if (serviceUnavailable) {
                this.setState({
                    status: "UNAVAILABLE",
                    message: error.message || "The feed service is unavailable. Please try again shortly.",
                    backendAvailable: false,
                    error: error.code || "API_UNAVAILABLE"
                });
                return;
            }

            this.setState({
                message: error && error.message
                    ? error.message
                    : "The feed request could not be completed.",
                backendAvailable: true,
                error: error && error.code ? error.code : "API_ERROR"
            });
        }

        setState(nextState) {
            this.state = {
                ...this.state,
                ...nextState
            };

            const snapshot = this.getState();
            this.listeners.forEach(listener => {
                try {
                    listener(snapshot);
                } catch (error) {
                    console.error("[ServerEventEngine] Listener failed:", error);
                }
            });
        }

        setTrackedEvent(feedRequest) {
            if (!feedRequest || typeof feedRequest !== "object") {
                this.setState({ trackedEvent: null });
                return null;
            }

            const trackedEvent = {
                ...feedRequest,
                eventId: feedRequest.eventId || feedRequest.id,
                id: feedRequest.id || feedRequest.eventId,
                state: feedRequest.state || feedRequest.status || "QUEUED",
                status: feedRequest.status || feedRequest.state || "QUEUED",
                queuePosition: feedRequest.queuePosition !== null
                    && feedRequest.queuePosition !== undefined
                    && Number.isFinite(Number(feedRequest.queuePosition))
                    ? Number(feedRequest.queuePosition)
                    : null,
                estimatedWaitMs: Math.max(0, Number(feedRequest.estimatedWaitMs) || 0)
            };

            this.setState({ trackedEvent });
            return { ...trackedEvent };
        }

        startRealtimeUpdates() {
            if (
                this.lifecycleStreamClose
                || typeof this.apiClient.subscribeToLifecycle !== "function"
            ) {
                return;
            }

            this.lifecycleStreamClose = this.apiClient.subscribeToLifecycle({
                onEvent: payload => {
                    if (!payload || !payload.eventEngine) {
                        return;
                    }

                    if (
                        payload.type === "FEED_REQUEST_STATE_CHANGED"
                        && payload.state
                        && payload.feedRequest
                    ) {
                        const activeEvent = payload.eventEngine.activeEvent
                            ? payload.eventEngine.activeEvent
                            : payload.feedRequest;
                        this.applySnapshot({
                            ...payload.eventEngine,
                            status: activeEvent.state || activeEvent.status || payload.state,
                            activeEvent
                        });
                    } else {
                        this.applySnapshot(payload.eventEngine);
                    }

                    if (payload.type === "EVENT_ENGINE_RESET") {
                        this.setState({ trackedEvent: null });
                    } else if (
                        payload.type === "FEED_REQUEST_STATE_CHANGED"
                        && payload.feedRequest
                        && this.state.trackedEvent
                        && payload.eventId === this.state.trackedEvent.eventId
                    ) {
                        this.setTrackedEvent(payload.feedRequest);
                    }

                    void this.refreshTrackedEvent();
                },
                onError: () => {
                    void this.refreshStatus();
                }
            });
        }

        startPolling() {
            if (this.pollTimerId) {
                return;
            }

            const interval = Number(this.config.apiPollIntervalMs) || 5000;
            this.pollTimerId = global.setInterval(() => {
                void this.refreshStatus();
                void this.refreshTrackedEvent();
            }, interval);
        }

        stopPolling() {
            if (!this.pollTimerId) {
                return;
            }

            global.clearInterval(this.pollTimerId);
            this.pollTimerId = null;
        }

        stop() {
            this.stopPolling();
            if (typeof this.lifecycleStreamClose === "function") {
                this.lifecycleStreamClose();
            }
            this.lifecycleStreamClose = null;
        }

        getLifecycleMessage(status, snapshot) {
            const messages = {
                RECEIVED: "Feed request received.",
                VALIDATED: "Feed request validated.",
                QUEUED: `${Number(snapshot.queueSize) || 0} feed request(s) waiting.`,
                APPROVED: "Feed request approved.",
                COUNTDOWN: "Feed countdown in progress.",
                BELL: "Simulated bell stage in progress.",
                DISPENSING: "Simulated dispensing stage in progress.",
                COMPLETE: "Feed lifecycle complete.",
                ARCHIVED: "Feed lifecycle archived.",
                READY: "Ready for the next supporter."
            };

            return messages[status] || "Feed service ready.";
        }

        cleanSupporterName(name) {
            const cleaned = String(name || "").trim();
            return cleaned || "Anonymous supporter";
        }

        generateClientRequestId(source = "website") {
            if (global.crypto && typeof global.crypto.randomUUID === "function") {
                return `${source}-${global.crypto.randomUUID()}`;
            }

            return `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        }
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { ServerEventEngine };
    }

    if (global) {
        global.ServerEventEngine = ServerEventEngine;

        if (global.document && global.CONFIG && global.alpacalyApiClient) {
            global.eventEngine = new ServerEventEngine(
                global.CONFIG,
                global.alpacalyApiClient
            );
            global.alpacalyEventEngine = global.eventEngine;
        }
    }
})(typeof window !== "undefined" ? window : globalThis);
