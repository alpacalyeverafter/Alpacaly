#!/usr/bin/env node
import { parseArgs } from "node:util";

import { BackupHoldRegistry } from "../src/disaster-recovery/backup-hold-registry.js";

const { values } = parseArgs({
    options: {
        directory: { type: "string" },
        apply: { type: "boolean", default: false },
        release: { type: "boolean", default: false },
        "backup-id": { type: "string" },
        "hold-id": { type: "string" },
        "hold-type": { type: "string" },
        "decision-id": { type: "string" },
        "authority-reference": { type: "string" },
        reason: { type: "string" }
    },
    strict: true
});

if (!values.directory) {
    throw new Error("--directory is required.");
}
if (values.apply === values.release) {
    throw new Error("Specify exactly one of --apply or --release.");
}
for (const name of ["hold-id", "decision-id", "authority-reference", "reason"]) {
    if (!values[name]) {
        throw new Error(`--${name} is required.`);
    }
}

const registry = new BackupHoldRegistry({ directory: values.directory });
const event = values.apply
    ? registry.apply({
        backupId: values["backup-id"],
        holdId: values["hold-id"],
        holdType: values["hold-type"],
        decisionId: values["decision-id"],
        authorityReference: values["authority-reference"],
        reason: values.reason
    })
    : registry.release({
        holdId: values["hold-id"],
        decisionId: values["decision-id"],
        authorityReference: values["authority-reference"],
        reason: values.reason
    });

process.stdout.write(`${JSON.stringify({
    status: event.eventType,
    holdId: event.holdId,
    holdType: event.holdType,
    backupId: event.backupId,
    decisionId: event.decisionId,
    occurredAt: event.occurredAt
}, null, 2)}\n`);
