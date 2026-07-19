import { Router } from "express";

import { ApplicationError } from "../errors/application-error.js";

export function requireDevelopmentContributionSimulation(config) {
    if (
        config.nodeEnv === "production"
        || !config.enableDevelopmentContributionSimulation
    ) {
        throw new ApplicationError(
            "Development contribution simulation is disabled.",
            {
                code: "DEVELOPMENT_CONTRIBUTION_SIMULATION_DISABLED",
                statusCode: 403
            }
        );
    }
}

export function createDevelopmentContributionsRouter({
    config,
    eventEngine,
    developmentWebsiteContributionService
}) {
    const router = Router();

    router.post("/website-contributions", (req, res, next) => {
        try {
            requireDevelopmentContributionSimulation(config);
            const result = developmentWebsiteContributionService.simulate(req.body, {
                feederId: req.body?.feederId || eventEngine.getDefaultFeederId()
            });
            const feederId = result.feedRequest.feederId;
            res.location(
                feederId === eventEngine.getDefaultFeederId()
                    ? `/api/feed-requests/${result.feedRequest.eventId}`
                    : `/api/feeders/${feederId}/feed-requests/${result.feedRequest.eventId}`
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
                eventEngine: eventEngine.getSnapshot(),
                queueStatistics: eventEngine.getQueueStatistics(feederId),
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    return router;
}
