#!/usr/bin/env node
import { parseArgs } from "node:util";

import { loadConfig } from "../src/config/index.js";
import { restorePostgresBackup } from "../src/disaster-recovery/postgres-restore-service.js";
import { createLogger } from "../src/logging/logger.js";

const { values } = parseArgs({
    options: {
        manifest: { type: "string" },
        "target-environment": { type: "string", default: "test" },
        "isolated-target": { type: "boolean", default: false },
        "approve-empty-target": { type: "boolean", default: false },
        "approve-destructive": { type: "boolean", default: false },
        "confirm-target": { type: "string" },
        "approve-migrations": { type: "boolean", default: false }
    },
    strict: true
});

if (!values.manifest) {
    throw new Error("--manifest is required.");
}
if (!process.env.RESTORE_DATABASE_URL) {
    throw new Error("RESTORE_DATABASE_URL is required.");
}

const config = loadConfig({
    ...process.env,
    NODE_ENV: values["target-environment"],
    CENTRAL_DATABASE_TYPE: "postgres",
    DATABASE_URL: process.env.RESTORE_DATABASE_URL
}, { loadEnvFile: false });
const logger = createLogger(config);
const { report, reportPath } = await restorePostgresBackup({
    manifestPath: values.manifest,
    targetConnectionString: process.env.RESTORE_DATABASE_URL,
    activeConnectionString: process.env.DATABASE_URL || null,
    targetEnvironment: values["target-environment"],
    isolatedTarget: values["isolated-target"],
    approveEmptyTarget: values["approve-empty-target"],
    approveDestructive: values["approve-destructive"],
    confirmTargetDatabase: values["confirm-target"] || null,
    approveMigrations: values["approve-migrations"],
    config,
    logger
});

process.stdout.write(`${JSON.stringify({
    status: report.status,
    reportId: report.reportId,
    reportFileName: reportPath.split("/").at(-1),
    workersStarted: false,
    feedingStarted: false
}, null, 2)}\n`);
