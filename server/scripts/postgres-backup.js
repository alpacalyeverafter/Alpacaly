#!/usr/bin/env node
import { parseArgs } from "node:util";

import { loadConfig } from "../src/config/index.js";
import { createPostgresBackup } from "../src/disaster-recovery/postgres-backup-service.js";
import { createLogger } from "../src/logging/logger.js";

const { values } = parseArgs({
    options: {
        "output-dir": { type: "string" },
        cadence: { type: "string", default: "daily" },
        compression: { type: "string", default: "9" },
        "encryption-status": { type: "string", default: "NONE" },
        "encryption-provider": { type: "string" },
        "legal-or-incident-hold": { type: "boolean", default: false },
        notes: { type: "string" }
    },
    strict: true
});

if (!values["output-dir"]) {
    throw new Error("--output-dir is required.");
}

const config = loadConfig();
const logger = createLogger(config);
const result = await createPostgresBackup({
    config,
    outputDirectory: values["output-dir"],
    cadence: values.cadence,
    compressionLevel: Number(values.compression),
    encryption: {
        status: values["encryption-status"],
        provider: values["encryption-provider"] || null
    },
    legalOrIncidentHold: values["legal-or-incident-hold"],
    notes: values.notes || null,
    logger
});

process.stdout.write(`${JSON.stringify({
    status: "BACKUP_CREATED_RECOVERABILITY_NOT_PROVEN",
    backupId: result.manifest.backupId,
    manifestFileName: result.manifestPath.split("/").at(-1),
    artifactFileName: result.manifest.artifact.fileName,
    checksumRecorded: true
}, null, 2)}\n`);
