import { Router } from "express";

import { ApplicationError } from "../errors/application-error.js";
import { requireDevelopmentContributionSimulation } from "./development-contributions.js";

export function createResourceQueuesRouter({
    eventEngine,
    config,
    developmentWebsiteContributionService
}) {
    const router = Router();

    router.get("/", (req, res) => {
        res.status(200).json({
            feeders: eventEngine.getAllQueueStatistics(),
            requestId: req.requestId
        });
    });

    function sendFeederQueue(req, res, next) {
        try {
            const { feederId } = req.params;
            res.status(200).json({
                feederId,
                feedRequests: eventEngine.getQueueSummary(feederId),
                archivedFeedRequests: eventEngine.getArchivedSummary(feederId),
                queueStatistics: eventEngine.getQueueStatistics(feederId),
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    }

    router.get("/:feederId/queue", sendFeederQueue);
    router.get("/:feederId/feed-requests", sendFeederQueue);

    router.post("/:feederId/feed-requests", (req, res, next) => {
        try {
            requireDevelopmentContributionSimulation(config);
            const result = developmentWebsiteContributionService.simulate(req.body, {
                feederId: req.params.feederId
            });
            res.location(
                `/api/feeders/${req.params.feederId}/feed-requests/${result.feedRequest.id}`
            );
            res.status(202).json({
                accepted: true,
                simulated: true,
                duplicate: result.duplicate,
                providerEvent: result.providerEvent,
                contribution: result.contribution,
                feedRequest: result.feedRequest,
                queuePosition: result.queuePosition,
                estimatedWaitMs: result.estimatedWaitMs,
                queueStatistics: eventEngine.getQueueStatistics(req.params.feederId),
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    router.get("/:feederId/feed-requests/:feedRequestId", (req, res, next) => {
        try {
            eventEngine.getQueueStatistics(req.params.feederId);
            const feedRequest = eventEngine.getFeedRequest(req.params.feedRequestId);
            if (!feedRequest || feedRequest.feederId !== req.params.feederId) {
                next(new ApplicationError("Feed request not found for this feeder.", {
                    code: "FEED_REQUEST_NOT_FOUND",
                    statusCode: 404
                }));
                return;
            }

            res.status(200).json({
                feedRequest,
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    return router;
}
