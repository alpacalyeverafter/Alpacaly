import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { AlpacalyApiClient, ApiClientError } = require("../../js/api-client.js");
const { ServerEventEngine } = require("../../js/event-engine.js");

const browserConfig = Object.freeze({
    DEMO_MAX_FEEDS: 100,
    apiPollIntervalMs: 5000
});

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" }
    });
}

test("browser API client submits feed requests to the configured backend", async () => {
    let capturedRequest = null;
    const client = new AlpacalyApiClient({
        baseUrl: "http://localhost:3000",
        fetchImpl: async (url, options) => {
            capturedRequest = { url, options };
            return jsonResponse({ accepted: true });
        }
    });

    await client.createFeedRequest({ supporterName: "Ada" });

    assert.equal(
        capturedRequest.url,
        "http://localhost:3000/api/development/website-contributions"
    );
    assert.equal(capturedRequest.options.method, "POST");
    assert.deepEqual(JSON.parse(capturedRequest.options.body), { supporterName: "Ada" });
});

test("browser API client preserves structured backend errors", async () => {
    const client = new AlpacalyApiClient({
        fetchImpl: async () => jsonResponse({
            error: {
                code: "DAILY_FEED_LIMIT_REACHED",
                message: "Today's safe feeding limit has been reached."
            }
        }, 409)
    });

    await assert.rejects(
        () => client.createFeedRequest({ supporterName: "Ada" }),
        error => error instanceof ApiClientError
            && error.code === "DAILY_FEED_LIMIT_REACHED"
            && error.statusCode === 409
    );
});

test("browser API client reports an unavailable backend clearly", async () => {
    const client = new AlpacalyApiClient({
        fetchImpl: async () => {
            throw new TypeError("connection refused");
        }
    });

    await assert.rejects(
        () => client.getEventEngineStatus(),
        error => error instanceof ApiClientError
            && error.code === "API_UNAVAILABLE"
            && error.message.includes("unavailable")
    );
});

test("browser API client receives and closes lifecycle event streams", () => {
    let createdSource = null;
    let observedPayload = null;

    class FakeEventSource {
        constructor(url) {
            this.url = url;
            this.listeners = new Map();
            this.closed = false;
            createdSource = this;
        }

        addEventListener(type, listener) {
            this.listeners.set(type, listener);
        }

        emit(type, payload) {
            this.listeners.get(type)({ data: JSON.stringify(payload) });
        }

        close() {
            this.closed = true;
        }
    }

    const client = new AlpacalyApiClient({
        baseUrl: "http://localhost:3000",
        eventSourceFactory: url => new FakeEventSource(url)
    });
    const close = client.subscribeToLifecycle({
        onEvent: payload => {
            observedPayload = payload;
        }
    });

    createdSource.emit("lifecycle", {
        type: "FEED_REQUEST_STATE_CHANGED",
        eventEngine: { status: "BELL" }
    });

    assert.equal(createdSource.url, "http://localhost:3000/api/event-engine/events");
    assert.equal(observedPayload.eventEngine.status, "BELL");
    close();
    assert.equal(createdSource.closed, true);
});

test("browser Event Engine adapter maps server snapshots into the existing UI state", async () => {
    const apiClient = {
        async getEventEngineStatus() {
            return {
                eventEngine: {
                    status: "QUEUED",
                    queueSize: 2,
                    acceptedToday: 2,
                    completedFeeds: 0,
                    feedsRemaining: 98
                }
            };
        }
    };
    const eventEngine = new ServerEventEngine(browserConfig, apiClient, { autoStart: false });

    const result = await eventEngine.refreshStatus();
    assert.equal(result.success, true);
    assert.deepEqual(eventEngine.getState(), {
        status: "QUEUED",
        message: "2 feed request(s) waiting.",
        currentEvent: null,
        trackedEvent: null,
        completedFeeds: 0,
        acceptedToday: 2,
        feedsRemaining: 98,
        queueSize: 2,
        backendAvailable: true,
        error: null
    });
});

test("browser Event Engine adapter submits through the API instead of a local queue", async () => {
    let submittedPayload = null;
    const apiClient = {
        async createFeedRequest(payload) {
            submittedPayload = payload;
            return {
                feedRequest: {
                    id: "feed-server-id",
                    eventId: "feed-server-id",
                    supporterName: payload.supporterName,
                    status: "QUEUED",
                    queuePosition: 2,
                    estimatedWaitMs: 17000
                },
                queuePosition: 1,
                estimatedWaitMs: 17000,
                eventEngine: {
                    status: "QUEUED",
                    queueSize: 1,
                    acceptedToday: 1,
                    completedFeeds: 0,
                    feedsRemaining: 99
                }
            };
        }
    };
    const eventEngine = new ServerEventEngine(browserConfig, apiClient, { autoStart: false });
    const result = await eventEngine.submitEvent({
        id: "browser-request-id",
        supporterName: "Ada",
        source: "website-demo",
        message: "For the herd"
    });

    assert.equal(result.accepted, true);
    assert.equal(result.event.id, "feed-server-id");
    assert.equal(result.event.eventId, "feed-server-id");
    assert.equal(result.queuePosition, 2);
    assert.equal(result.estimatedWaitMs, 17000);
    assert.equal(submittedPayload.clientRequestId, "browser-request-id");
    assert.equal(eventEngine.getState().queueSize, 1);
    assert.equal(eventEngine.getState().trackedEvent.eventId, "feed-server-id");
    assert.equal(eventEngine.getState().trackedEvent.queuePosition, 2);
});

test("browser Event Engine adapter refreshes the tracked supporter event from the API", async () => {
    const apiClient = {
        async getFeedRequest(eventId) {
            return {
                feedRequest: {
                    id: eventId,
                    eventId,
                    supporterName: "Ada",
                    state: "BELL",
                    queuePosition: 1,
                    estimatedWaitMs: 0
                }
            };
        }
    };
    const eventEngine = new ServerEventEngine(browserConfig, apiClient, { autoStart: false });
    eventEngine.setTrackedEvent({
        eventId: "feed-server-id",
        state: "QUEUED",
        queuePosition: 2,
        estimatedWaitMs: 17000
    });

    const result = await eventEngine.refreshTrackedEvent();

    assert.equal(result.success, true);
    assert.equal(eventEngine.getState().trackedEvent.state, "BELL");
    assert.equal(eventEngine.getState().trackedEvent.queuePosition, 1);
    assert.equal(eventEngine.getState().trackedEvent.estimatedWaitMs, 0);
});

test("a stale tracked-event response cannot replace a newer submission", async () => {
    let resolveFirstRequest;
    const apiClient = {
        async getFeedRequest(eventId) {
            return new Promise(resolve => {
                resolveFirstRequest = () => resolve({
                    feedRequest: {
                        eventId,
                        state: "BELL",
                        queuePosition: 1,
                        estimatedWaitMs: 0
                    }
                });
            });
        }
    };
    const eventEngine = new ServerEventEngine(browserConfig, apiClient, { autoStart: false });
    eventEngine.setTrackedEvent({ eventId: "feed-first", state: "COUNTDOWN" });
    const refresh = eventEngine.refreshTrackedEvent();
    eventEngine.setTrackedEvent({
        eventId: "feed-second",
        state: "QUEUED",
        queuePosition: 2,
        estimatedWaitMs: 12000
    });
    resolveFirstRequest();

    const result = await refresh;

    assert.equal(result.stale, true);
    assert.equal(eventEngine.getState().trackedEvent.eventId, "feed-second");
    assert.equal(eventEngine.getState().trackedEvent.state, "QUEUED");
});

test("reading the admin queue does not create a state-update feedback loop", async () => {
    const apiClient = {
        async listFeedRequests() {
            return {
                feedRequests: [],
                archivedFeedRequests: [],
                eventEngine: {
                    status: "READY",
                    queueSize: 0,
                    acceptedToday: 0,
                    completedFeeds: 0,
                    feedsRemaining: 100
                }
            };
        }
    };
    const eventEngine = new ServerEventEngine(browserConfig, apiClient, { autoStart: false });
    let notifications = 0;
    eventEngine.subscribe(() => {
        notifications += 1;
    });

    const result = await eventEngine.getQueue();

    assert.equal(result.success, true);
    assert.equal(notifications, 1);
});

test("browser Event Engine adapter exposes backend outages to existing subscribers", async () => {
    const apiClient = {
        async getEventEngineStatus() {
            throw new ApiClientError("The feed service is unavailable. Please try again shortly.", {
                code: "API_UNAVAILABLE"
            });
        }
    };
    const eventEngine = new ServerEventEngine(browserConfig, apiClient, { autoStart: false });
    let observedState = null;
    eventEngine.subscribe(state => {
        observedState = state;
    });

    const result = await eventEngine.refreshStatus();
    assert.equal(result.success, false);
    assert.equal(observedState.status, "UNAVAILABLE");
    assert.equal(observedState.backendAvailable, false);
    assert.match(observedState.message, /unavailable/i);
});

test("browser Event Engine adapter applies live lifecycle states", () => {
    let lifecycleHandlers = null;
    let streamClosed = false;
    const apiClient = {
        subscribeToLifecycle(handlers) {
            lifecycleHandlers = handlers;
            return () => {
                streamClosed = true;
            };
        }
    };
    const eventEngine = new ServerEventEngine(browserConfig, apiClient, { autoStart: false });
    let observedState = null;
    eventEngine.subscribe(state => {
        observedState = state;
    });

    eventEngine.startRealtimeUpdates();
    lifecycleHandlers.onEvent({
        type: "FEED_REQUEST_STATE_CHANGED",
        state: "BELL",
        feedRequest: {
            eventId: "feed-live-id",
            supporterName: "Live supporter",
            state: "BELL"
        },
        eventEngine: {
            status: "BELL",
            queueSize: 1,
            acceptedToday: 1,
            completedFeeds: 0,
            feedsRemaining: 99,
            activeEvent: {
                eventId: "feed-live-id",
                supporterName: "Live supporter",
                state: "BELL"
            }
        }
    });

    assert.equal(observedState.status, "BELL");
    assert.equal(observedState.currentEvent.eventId, "feed-live-id");
    assert.equal(observedState.message, "Simulated bell stage in progress.");

    lifecycleHandlers.onEvent({
        type: "FEED_REQUEST_STATE_CHANGED",
        state: "QUEUED",
        eventId: "feed-waiting-id",
        feedRequest: {
            eventId: "feed-waiting-id",
            supporterName: "Waiting supporter",
            state: "QUEUED"
        },
        eventEngine: {
            status: "BELL",
            queueSize: 2,
            acceptedToday: 2,
            completedFeeds: 0,
            feedsRemaining: 98,
            activeEvent: {
                eventId: "feed-live-id",
                supporterName: "Live supporter",
                state: "BELL"
            }
        }
    });
    assert.equal(observedState.status, "BELL");
    assert.equal(observedState.currentEvent.eventId, "feed-live-id");

    lifecycleHandlers.onEvent({
        type: "FEED_REQUEST_STATE_CHANGED",
        state: "RECEIVED",
        feedRequest: {
            eventId: "feed-next-id",
            supporterName: "Next supporter",
            state: "RECEIVED"
        },
        eventEngine: {
            status: "READY",
            queueSize: 0,
            acceptedToday: 0,
            completedFeeds: 0,
            feedsRemaining: 99,
            activeEvent: null
        }
    });
    assert.equal(observedState.status, "RECEIVED");
    assert.equal(observedState.currentEvent.eventId, "feed-next-id");
    eventEngine.stop();
    assert.equal(streamClosed, true);
});
