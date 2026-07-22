#!/usr/bin/env node
import { parseArgs } from "node:util";

import { readManagedStagingAssessment } from "../src/disaster-recovery/managed-staging-assessment.js";
import { ManagedStagingEvaluationService } from "../src/disaster-recovery/managed-staging-evaluation-service.js";

const { values } = parseArgs({
    options: {
        assessment: { type: "string" },
        directory: { type: "string" },
        "approval-directory": { type: "string" },
        "maximum-assessment-age-days": { type: "string", default: "30" }
    },
    strict: true
});

for (const name of ["assessment", "directory"]) {
    if (!values[name]) {
        throw new Error(`--${name} is required.`);
    }
}

const assessment = readManagedStagingAssessment(values.assessment);
const service = new ManagedStagingEvaluationService({
    directory: values.directory,
    approvalDirectory: values["approval-directory"] || values.directory,
    maximumAssessmentAgeDays: Number(values["maximum-assessment-age-days"])
});
if (!service.assessment(assessment.assessmentId)) {
    service.recordAssessment(assessment);
}
const result = service.recordEvaluation(assessment);

process.stdout.write(`${JSON.stringify(result.record, null, 2)}\n`);
if (result.record.status === "BLOCKED") {
    process.exitCode = 2;
}
