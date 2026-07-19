import { Router } from "express";

import { ApplicationError } from "../errors/application-error.js";
import { requireDevelopmentContributionSimulation } from "./development-contributions.js";

export function createFeedRequestsRouter({
    eventEngine,
    config,
    developmentWebsiteContributionService
}) {
    const router = Router();

    router.get("/", (req, res) => {
        res.status(200).json({
            feedRequests: eventEngine.getQueueSummary(),
            archivedFeedRequests: eventEngine.getArchivedSummary(),
            eventEngine: eventEngine.getSnapshot(),
            requestId: req.requestId
        });
    });

    router.post("/", (req, res, next) => {
        try {
            requireDevelopmentContributionSimulation(config);
            const result = developmentWebsiteContributionService.simulate(req.body, {
                feederId: eventEngine.getDefaultFeederId()
            });
            res.location(`/api/feed-requests/${result.feedRequest.id}`);
            res.status(202).json({
                accepted: true,
                simulated: true,
                duplicate: result.duplicate,
                providerEvent: result.providerEvent,
                contribution: result.contribution,
                feedRequest: result.feedRequest,
                queuePosition: result.queuePosition,
                estimatedWaitMs: result.estimatedWaitMs,
                eventEngine: eventEngine.getSnapshot(),
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    router.get("/:feedRequestId", (req, res, next) => {
        const feedRequest = eventEngine.getFeedRequest(req.params.feedRequestId);
        if (
            !feedRequest
            || feedRequest.feederId !== eventEngine.getDefaultFeederId()
        ) {
            next(new ApplicationError("Feed request not found.", {
                code: "FEED_REQUEST_NOT_FOUND",
                statusCode: 404
            }));
            return;
        }

        res.status(200).json({
            feedRequest,
            requestId: req.requestId
        });
    });

    return router;
}
