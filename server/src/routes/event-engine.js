import { Router } from "express";

export function createEventEngineRouter({ eventEngine }) {
    const router = Router();

    router.get("/status", (req, res) => {
        res.status(200).json({
            eventEngine: eventEngine.getSnapshot(),
            requestId: req.requestId
        });
    });

    return router;
}
