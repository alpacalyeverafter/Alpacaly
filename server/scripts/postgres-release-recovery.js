#!/usr/bin/env node
import { parseArgs } from "node:util";

import { loadConfig } from "../src/config/index.js";
import { isSameDatabase, databaseName } from "../src/disaster-recovery/backup-manifest.js";
import { RecoverySafetyService } from "../src/disaster-recovery/recovery-safety-service.js";
import { PostgresEventStore } from "../src/event-store/postgres-event-store.js";
import { createLogger } from "../src/logging/logger.js";

const { values } = parseArgs({
    options: {
        "target-environment": { type: "string", default: "test" },
        "isolated-target": { type: "boolean", default: false },
        "confirm-target": { type: "string" },
        "decision-id": { type: "string" },
        "release-safe-work": { type: "boolean", default: false },
        "release-workers": { type: "boolean", default: false }
    },
    strict: true
});
if (!process.env.RESTORE_DATABASE_URL) {
    throw new Error("RESTORE_DATABASE_URL is required.");
}
if (!["test", "staging"].includes(values["target-environment"])) {
    throw new Error("This phase permits recovery release only in test or staging.");
}
if (!values["isolated-target"]) {
    throw new Error("Recovery release requires --isolated-target.");
}
if (values["confirm-target"] !== databaseName(process.env.RESTORE_DATABASE_URL)) {
    throw new Error("Recovery release requires exact target database-name confirmation.");
}
if (!values["decision-id"]) {
    throw new Error("--decision-id is required.");
}
if (!values["release-safe-work"] && !values["release-workers"]) {
    throw new Error("Select --release-safe-work and/or --release-workers.");
}
if (process.env.DATABASE_URL && isSameDatabase(
    process.env.DATABASE_URL,
    process.env.RESTORE_DATABASE_URL
)) {
    throw new Error("Recovery release refuses the configured active application database.");
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
    const safety = new RecoverySafetyService({
        eventStore,
        config: { recoverySafetyMode: false },
        logger
    });
    const result = {};
    if (values["release-safe-work"]) {
        result.safeWork = safety.releaseSafeWork({
            decisionId: values["decision-id"]
        });
    }
    if (values["release-workers"]) {
        result.workerRelease = safety.releaseWorkers({
            decisionId: values["decision-id"]
        });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
    eventStore.close();
}
