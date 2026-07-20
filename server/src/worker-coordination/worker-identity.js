import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export function createWorkerIdentity({ config, serviceType, clock = () => new Date() }) {
    if (!serviceType) {
        throw new Error("A worker serviceType is required.");
    }
    const processInstanceId = config.workerInstanceId
        || `${hostname()}:${process.pid}`;
    const bootId = randomUUID();
    const workerId = config.workerId
        ? `${config.workerId}:${processInstanceId}:${serviceType}:${bootId}`
        : `${processInstanceId}:${serviceType}:${bootId}`;
    return Object.freeze({
        workerId,
        serviceType,
        processInstanceId,
        bootId,
        startedAt: clock().toISOString(),
        softwareVersion: config.workerSoftwareVersion || "unknown",
        environment: config.nodeEnv || "development",
        metadata: {
            hostname: hostname(),
            pid: process.pid
        }
    });
}
