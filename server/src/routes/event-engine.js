import { Router } from "express";

import { PERMISSIONS } from "../authorization/permissions.js";
import { ApplicationError } from "../errors/application-error.js";
import {
    authenticateAdministrator,
    authorizeAdministrator
} from "../middleware/administrator-security.js";
import {
    presentPublicEventEngineSnapshot,
    presentPublicLifecyclePayload,
    presentPublicQueueStatistics
} from "./public-api-presenters.js";

export function lifecyclePayloadTargetsFeeder(payload, feederId) {
    const payloadFeederId = payload?.feedRequest?.feederId
        || payload?.queueStatistics?.feederId
        || null;
    return !payloadFeederId || payloadFeederId === feederId;
}

export function createEventEngineRouter({
    eventEngine,
    config,
    administratorSecurityServices
}) {
    const router = Router();
    const defaultFeederId = eventEngine.getDefaultFeederId();

    router.get("/status", (req, res) => {
        res.status(200).json({
            eventEngine: presentPublicEventEngineSnapshot(eventEngine.getSnapshot()),
            requestId: req.requestId
        });
    });

    router.get("/queues", (req, res) => {
        res.status(200).json({
            queues: eventEngine.getAllQueueStatistics().map(
                presentPublicQueueStatistics
            ),
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
            res.write(`data: ${JSON.stringify(
                presentPublicLifecyclePayload(payload)
            )}\n\n`);
        }

        sendLifecycleEvent({
            type: "EVENT_ENGINE_SNAPSHOT",
            eventEngine: presentPublicEventEngineSnapshot(eventEngine.getSnapshot())
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

    router.post(
        "/reset",
        authenticateAdministrator(
            administratorSecurityServices.authenticationService
        ),
        authorizeAdministrator({
            authorizationService:
                administratorSecurityServices.authorizationService,
            auditService: administratorSecurityServices.auditService,
            permission: PERMISSIONS.DEVELOPMENT_RESET,
            resolveContext: () => ({
                targetType: "EVENT_ENGINE",
                targetId: "development-reset"
            }),
            platformWide: true
        }),
        (req, res, next) => {
        if (!config.enableDemoReset) {
            administratorSecurityServices.auditService.record({
                administratorId: req.administratorIdentity.administratorId,
                effectiveRole: req.administratorAuthorization.effectiveRole,
                action: "DEVELOPMENT_RESET_ATTEMPTED",
                targetType: "EVENT_ENGINE",
                targetId: "development-reset",
                reason: "DEMO_RESET_DISABLED",
                requestId: req.requestId,
                authenticationStrength:
                    req.administratorIdentity.authenticationStrength,
                result: "REJECTED"
            });
            next(new ApplicationError("The development reset endpoint is disabled.", {
                code: "DEMO_RESET_DISABLED",
                statusCode: 403
            }));
            return;
        }

        const beforeSummary = eventEngine.getSnapshot();
        try {
            const resetSnapshot = eventEngine.reset();
            administratorSecurityServices.auditService.record({
                administratorId: req.administratorIdentity.administratorId,
                effectiveRole: req.administratorAuthorization.effectiveRole,
                action: "DEVELOPMENT_RESET_ATTEMPTED",
                targetType: "EVENT_ENGINE",
                targetId: "development-reset",
                reason: req.body?.reason || "LOCAL_DEVELOPMENT_RESET",
                requestId: req.requestId,
                authenticationStrength:
                    req.administratorIdentity.authenticationStrength,
                result: "SUCCEEDED",
                beforeSummary,
                afterSummary: resetSnapshot
            });
            res.status(200).json({
                reset: true,
                eventEngine: presentPublicEventEngineSnapshot(resetSnapshot),
                requestId: req.requestId
            });
        } catch (error) {
            administratorSecurityServices.auditService.record({
                administratorId: req.administratorIdentity.administratorId,
                effectiveRole: req.administratorAuthorization.effectiveRole,
                action: "DEVELOPMENT_RESET_ATTEMPTED",
                targetType: "EVENT_ENGINE",
                targetId: "development-reset",
                reason: error.code || "RESET_FAILED",
                requestId: req.requestId,
                authenticationStrength:
                    req.administratorIdentity.authenticationStrength,
                result: "FAILED",
                beforeSummary
            });
            next(error);
        }
    });

    return router;
}
