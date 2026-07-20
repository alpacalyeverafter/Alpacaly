import { Router } from "express";

export function createHealthRouter({
    config,
    eventStore = null,
    claimStores = [],
    recoverySafetyService = null,
    clock = () => new Date()
}) {
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

    router.get("/ready", (_req, res) => {
        try {
            const persistence = eventStore?.getPersistenceDiagnostics();
            claimStores.forEach(store => store.getDiagnostics());
            const recoveryBlocked = recoverySafetyService?.isBlocked() === true;
            res.status(recoveryBlocked ? 503 : 200).json({
                status: recoveryBlocked ? "not_ready" : "ready",
                service: config.serviceName,
                environment: config.nodeEnv,
                persistence: {
                    databaseType: persistence?.databaseType || "unknown",
                    schemaVersion: persistence?.schemaVersion || null,
                    reachable: true
                },
                workerCoordination: { reachable: true },
                recovery: {
                    workersBlocked: recoveryBlocked,
                    mode: recoveryBlocked ? "BLOCKED" : "NORMAL"
                },
                timestamp: clock().toISOString()
            });
        } catch {
            res.status(503).json({
                status: "not_ready",
                service: config.serviceName,
                environment: config.nodeEnv,
                persistence: { reachable: false },
                workerCoordination: { reachable: false },
                timestamp: clock().toISOString()
            });
        }
    });

    return router;
}
