#!/usr/bin/env node
import { parseArgs } from "node:util";

import {
    compareProviderCandidatePacks,
    readProviderCandidatePack
} from "../src/disaster-recovery/index.js";

const { values } = parseArgs({
    options: {
        candidate: { type: "string", multiple: true },
        "maximum-age-days": { type: "string", default: "30" }
    },
    strict: true
});

if (!values.candidate || values.candidate.length < 2) {
    throw new Error("At least two --candidate files are required.");
}

const report = compareProviderCandidatePacks(
    values.candidate.map(readProviderCandidatePack),
    { maximumAgeDays: Number(values["maximum-age-days"]) }
);

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
