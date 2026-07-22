#!/usr/bin/env node
import { parseArgs } from "node:util";

import { BackupCatalogue } from "../src/disaster-recovery/backup-catalogue.js";

const { values } = parseArgs({
    options: {
        directory: { type: "string" },
        "approve-test-deletion": { type: "boolean", default: false }
    },
    strict: true
});
if (!values.directory) {
    throw new Error("--directory is required.");
}
const catalogue = new BackupCatalogue({ directory: values.directory });
const deleted = catalogue.deleteExpiredTestBackups({
    approved: values["approve-test-deletion"]
});
process.stdout.write(`${JSON.stringify({ deleted }, null, 2)}\n`);
