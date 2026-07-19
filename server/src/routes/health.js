import { Router } from "express";

export function createHealthRouter({ config, clock = () => new Date() }) {
    const router = Router();

    router.get("/", (_req, res) => {
        res.status(200).json({
            status: "ok",
            service: config.serviceName,
            environment: config.nodeEnv,
            timestamp: clock().toISOString(),
            uptimeSeconds: Number(process.uptime().toFixed(3))
        });
    });

    return router;
}
