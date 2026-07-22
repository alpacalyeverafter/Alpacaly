#!/usr/bin/env node
import { parseArgs } from "node:util";

import { readManagedBackupEvidence } from "../src/disaster-recovery/managed-backup-evidence.js";
import { ManagedBackupOperationsService } from "../src/disaster-recovery/managed-backup-operations-service.js";

const { values } = parseArgs({
    options: {
        evidence: { type: "string" },
        directory: { type: "string" },
        "restore-catalogue-directory": { type: "string" },
        "expected-environment": { type: "string" },
        "expected-database-identity": { type: "string" },
        "expected-region": { type: "string" },
        "maximum-evidence-age-minutes": { type: "string", default: "30" },
        "maximum-backup-age-hours": { type: "string", default: "24" },
        "rpo-minutes": { type: "string", default: "15" },
        "minimum-retention-days": { type: "string", default: "14" },
        "restore-drill-maximum-age-days": { type: "string", default: "30" }
    },
    strict: true
});

for (const name of [
    "evidence",
    "directory",
    "expected-environment",
    "expected-database-identity",
    "expected-region"
]) {
    if (!values[name]) {
        throw new Error(`--${name} is required.`);
    }
}

const evidence = readManagedBackupEvidence(values.evidence);
const service = new ManagedBackupOperationsService({
    directory: values.directory,
    restoreCatalogueDirectory:
        values["restore-catalogue-directory"] || values.directory,
    expectedEnvironment: values["expected-environment"],
    expectedDatabaseIdentity: values["expected-database-identity"],
    expectedRegion: values["expected-region"],
    maximumEvidenceAgeMinutes: Number(values["maximum-evidence-age-minutes"]),
    maximumBackupAgeHours: Number(values["maximum-backup-age-hours"]),
    recoveryPointObjectiveMinutes: Number(values["rpo-minutes"]),
    minimumRetentionDays: Number(values["minimum-retention-days"]),
    restoreDrillMaximumAgeDays: Number(values["restore-drill-maximum-age-days"])
});
service.recordEvidence(evidence);
const checked = service.recordCheck();

process.stdout.write(`${JSON.stringify(checked.record, null, 2)}\n`);
if (checked.record.status === "BLOCKED") {
    process.exitCode = 2;
}
