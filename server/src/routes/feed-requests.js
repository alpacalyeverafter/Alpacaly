import { Router } from "express";

import { ApplicationError } from "../errors/application-error.js";

export function createFeedRequestsRouter({ eventEngine }) {
    const router = Router();

    router.post("/", (req, res, next) => {
        try {
            const result = eventEngine.submitFeedRequest(req.body);
            res.location(`/api/feed-requests/${result.feedRequest.id}`);
            res.status(202).json({
                accepted: true,
                feedRequest: result.feedRequest,
                queuePosition: result.queuePosition,
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    router.get("/:feedRequestId", (req, res, next) => {
        const feedRequest = eventEngine.getFeedRequest(req.params.feedRequestId);
        if (!feedRequest) {
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
