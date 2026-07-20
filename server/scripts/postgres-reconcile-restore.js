#!/usr/bin/env node
import { parseArgs } from "node:util";

import { loadConfig } from "../src/config/index.js";
import { RecoverySafetyService } from "../src/disaster-recovery/recovery-safety-service.js";
import { reconcileRestoredDatabase } from "../src/disaster-recovery/postgres-restore-service.js";
import { PostgresEventStore } from "../src/event-store/postgres-event-store.js";
import { createLogger } from "../src/logging/logger.js";

const { values } = parseArgs({
    options: {
        "target-environment": { type: "string", default: "test" },
        "isolated-target": { type: "boolean", default: false }
    },
    strict: true
});
if (!values["isolated-target"]) {
    throw new Error("Reconciliation requires --isolated-target.");
}
if (!["test", "staging"].includes(values["target-environment"])) {
    throw new Error("This phase permits reconciliation only in test or staging.");
}
if (!process.env.RESTORE_DATABASE_URL) {
    throw new Error("RESTORE_DATABASE_URL is required.");
}

const config = loadConfig({
    ...process.env,
    NODE_ENV: values["target-environment"],
    CENTRAL_DATABASE_TYPE: "postgres",
    DATABASE_URL: process.env.RESTORE_DATABASE_URL,
    RECOVERY_SAFETY_MODE: "true"
}, { loadEnvFile: false });
const logger = createLogger(config);
const eventStore = new PostgresEventStore({ config, logger });
try {
    const recoverySafetyService = new RecoverySafetyService({
        eventStore,
        config: { recoverySafetyMode: false },
        logger
    });
    const report = reconcileRestoredDatabase({
        eventStore,
        recoverySafetyService
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status === "BLOCKED") {
        process.exitCode = 2;
    }
} finally {
    eventStore.close();
}
