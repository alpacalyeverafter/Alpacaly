#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
    createGovernanceReviewPack,
    readProviderCandidatePack
} from "../src/disaster-recovery/index.js";

const SECRET_KEY_PATTERN = /(?:password|secret|token|credential|private.?key|connection.?string|database.?url|access.?key)/i;

function rejectSecretFields(value, path = "review") {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
        if (key !== "credentialsUsed" && SECRET_KEY_PATTERN.test(key)) {
            throw new Error(`${path}.${key} is not permitted in governance review evidence.`);
        }
        rejectSecretFields(child, `${path}.${key}`);
    }
}

const { values } = parseArgs({
    options: {
        candidate: { type: "string", multiple: true },
        review: { type: "string" },
        "review-pack-id": { type: "string" },
        requester: { type: "string" },
        "created-at": { type: "string" },
        "maximum-source-age-days": { type: "string", default: "30" }
    },
    strict: true
});

if (!values.candidate || values.candidate.length < 2) {
    throw new Error("At least two --candidate files are required.");
}
const existing = values.review
    ? JSON.parse(readFileSync(values.review, "utf8"))
    : null;
rejectSecretFields(existing);
const requesterReference = values.requester || existing?.requesterReference;
if (!requesterReference) {
    throw new Error("--requester is required and must be an opaque non-secret identity reference.");
}

const reviewPack = createGovernanceReviewPack({
    reviewPackVersion: existing?.reviewPackVersion || 1,
    reviewPackId: values["review-pack-id"]
        || existing?.reviewPackId
        || "phase-7f2e-governance-review",
    createdAt: values["created-at"] || existing?.createdAt || new Date().toISOString(),
    requesterReference,
    maximumSourceAgeDays: Number(values["maximum-source-age-days"]),
    candidatePacks: values.candidate.map(readProviderCandidatePack),
    ownerChecklists: existing?.ownerChecklists,
    candidateOpenQuestions: existing?.candidateOpenQuestions,
    claimSeverityReview: existing?.claimSeverityReview,
    rpoRtoWorksheet: existing?.rpoRtoWorksheet,
    evidenceStorageReview: existing?.evidenceStorageReview,
    decisionRecords: existing?.decisionRecords
});

process.stdout.write(`${JSON.stringify(reviewPack, null, 2)}\n`);
