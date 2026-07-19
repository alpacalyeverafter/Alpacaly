import { Router } from "express";

import { ApplicationError } from "../errors/application-error.js";

export function lifecyclePayloadTargetsFeeder(payload, feederId) {
    const payloadFeederId = payload?.feedRequest?.feederId
        || payload?.queueStatistics?.feederId
        || null;
    return !payloadFeederId || payloadFeederId === feederId;
}

export function createEventEngineRouter({ eventEngine, config }) {
    const router = Router();
    const defaultFeederId = eventEngine.getDefaultFeederId();

    router.get("/status", (req, res) => {
        res.status(200).json({
            eventEngine: eventEngine.getSnapshot(),
            requestId: req.requestId
        });
    });

    router.get("/queues", (req, res) => {
        res.status(200).json({
            queues: eventEngine.getAllQueueStatistics(),
            requestId: req.requestId
        });
    });

    router.get("/events", (req, res) => {
        res.status(200);
        res.set({
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive"
        });
        res.flushHeaders();

        function sendLifecycleEvent(payload) {
            if (!lifecyclePayloadTargetsFeeder(payload, defaultFeederId)) {
                return;
            }
            res.write("event: lifecycle\n");
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }

        sendLifecycleEvent({
            type: "EVENT_ENGINE_SNAPSHOT",
            eventEngine: eventEngine.getSnapshot()
        });

        const unsubscribe = eventEngine.subscribe(sendLifecycleEvent);
        const heartbeatId = setInterval(() => {
            res.write(": heartbeat\n\n");
        }, 15000);

        req.on("close", () => {
            clearInterval(heartbeatId);
            unsubscribe();
        });
    });

    router.post("/reset", (req, res, next) => {
        if (!config.enableDemoReset) {
            next(new ApplicationError("The development reset endpoint is disabled.", {
                code: "DEMO_RESET_DISABLED",
                statusCode: 403
            }));
            return;
        }

        res.status(200).json({
            reset: true,
            eventEngine: eventEngine.reset(),
            requestId: req.requestId
        });
    });

    return router;
}
