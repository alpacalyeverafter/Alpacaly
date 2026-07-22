import { createHash } from "node:crypto";

import { MANAGED_STAGING_APPROVAL_AUTHORITIES } from "./managed-staging-approval-registry.js";
import {
    PROVIDER_CANDIDATE_CONTROL_IDS,
    createProviderCandidatePack
} from "./provider-candidate-assessment.js";

export const GOVERNANCE_REVIEW_PACK_VERSION = 1;
export const GOVERNANCE_REVIEW_SCOPE = "INDEPENDENT_PROVIDER_GOVERNANCE_REVIEW_ONLY";
export const GOVERNANCE_REVIEW_DECISIONS = Object.freeze([
    "APPROVE",
    "APPROVE_WITH_CONDITIONS",
    "REJECT",
    "DEFER"
]);

const DAY_MS = 24 * 60 * 60 * 1000;
const ACCEPTABLE_DECISIONS = new Set(["APPROVE", "APPROVE_WITH_CONDITIONS"]);
const SECRET_KEY_PATTERN = /(?:password|secret|token|credential|private.?key|connection.?string|database.?url|access.?key)/i;
const SAFE_FIELDS = new Set([
    "secret-management-and-rotation",
    "credentialsAuthorized",
    "credentialsUsed"
]);

const OWNER_CHECKLISTS = Object.freeze({
    TECHNICAL: Object.freeze([
        ["candidate-integrity", "Validate both candidate-pack digests, schemas, scope declarations and all 22 controls."],
        ["postgres-compatibility", "Review PostgreSQL 16 compatibility, native portability and service-specific limitations."],
        ["recovery-safety", "Confirm no candidate claim weakens restore safety, worker fencing, emergency stops or OUTCOME_UNKNOWN handling."],
        ["rpo-rto-feasibility", "Review the proposed RPO and RTO as test targets rather than service promises."],
        ["technical-open-questions", "Resolve or condition every open question assigned to technical review."]
    ]),
    SECURITY: Object.freeze([
        ["encryption-and-tls", "Review storage, backup, TLS and hostname-verification claims and their evidence gaps."],
        ["network-boundary", "Review private networking and the prohibition on public database access."],
        ["identity-and-secrets", "Review least-privilege roles, secret storage, rotation, MFA and break-glass boundaries."],
        ["audit-and-evidence", "Review administrative audit coverage and the protected evidence-storage boundary."],
        ["security-open-questions", "Resolve or condition every open question assigned to security review."]
    ]),
    OPERATIONS: Object.freeze([
        ["backup-and-restore", "Review backup, PITR, isolated restore, retention and restore-drill operating assumptions."],
        ["monitoring-and-limits", "Review monitoring, alerting, quotas, connection limits and incident history gaps."],
        ["support-and-escalation", "Review support coverage, escalation paths and incident operating responsibilities."],
        ["rto-operability", "Review whether the proposed RTO worksheet includes reconciliation and supervised release."],
        ["operations-open-questions", "Resolve or condition every open question assigned to operations review."]
    ]),
    DATA_GOVERNANCE: Object.freeze([
        ["uk-region-and-transfers", "Review UK region claims, international transfer paths and support-access implications."],
        ["retention-and-deletion", "Review retention, deletion evidence and legal or incident hold requirements."],
        ["evidence-governance", "Review evidence classification, storage, access, retention and immutable audit requirements."],
        ["source-freshness", "Review source dates, missing publication dates and the refresh interval."],
        ["governance-open-questions", "Resolve or condition every open question assigned to data-governance review."]
    ]),
    FINANCE: Object.freeze([
        ["cost-boundary", "Confirm published pricing variables are not treated as a quote or approved budget."],
        ["full-cost-model", "Review HA, backup, PITR, monitoring, transfer, support and restore-drill cost assumptions."],
        ["support-commercials", "Review support-plan and contractual-response evidence without purchasing a service."],
        ["rpo-rto-cost", "Review the cost implications of the proposed RPO and RTO targets."],
        ["finance-open-questions", "Resolve or condition every open question assigned to finance review."]
    ])
});

const CLAIM_REVIEW_POLICY = Object.freeze({
    "managed-postgresql": ["HIGH", ["TECHNICAL"]],
    "postgresql-16-or-newer": ["HIGH", ["TECHNICAL"]],
    "uk-region": ["HIGH", ["DATA_GOVERNANCE"]],
    "encrypted-storage": ["CRITICAL", ["SECURITY"]],
    "encrypted-backups": ["CRITICAL", ["SECURITY", "OPERATIONS"]],
    "point-in-time-recovery": ["CRITICAL", ["TECHNICAL", "OPERATIONS"]],
    "isolated-restore": ["CRITICAL", ["TECHNICAL", "OPERATIONS"]],
    "tls-and-hostname-verification": ["CRITICAL", ["SECURITY"]],
    "private-networking": ["CRITICAL", ["SECURITY"]],
    "native-dump-and-restore": ["HIGH", ["TECHNICAL", "OPERATIONS"]],
    "monitoring-and-alerting": ["HIGH", ["OPERATIONS"]],
    "least-privilege-role-separation": ["CRITICAL", ["SECURITY"]],
    "secret-management-and-rotation": ["CRITICAL", ["SECURITY"]],
    "administrative-audit-logging": ["CRITICAL", ["SECURITY", "DATA_GOVERNANCE"]],
    "backup-retention-and-deletion": ["HIGH", ["OPERATIONS", "DATA_GOVERNANCE"]],
    "legal-and-incident-hold": ["HIGH", ["DATA_GOVERNANCE", "OPERATIONS"]],
    "service-limits": ["MEDIUM", ["OPERATIONS", "TECHNICAL"]],
    "incident-history": ["MEDIUM", ["OPERATIONS"]],
    "support-response": ["HIGH", ["OPERATIONS", "FINANCE"]],
    "cost-evidence": ["MEDIUM", ["FINANCE"]],
    "uk-data-transfer-review": ["CRITICAL", ["DATA_GOVERNANCE", "SECURITY"]],
    "alpacaly-restore-safety-drill": ["CRITICAL", ["TECHNICAL", "OPERATIONS"]]
});

const QUESTION_AUTHORITIES = Object.freeze([
    ["TECHNICAL", "OPERATIONS"],
    ["SECURITY"],
    ["DATA_GOVERNANCE", "SECURITY"],
    ["OPERATIONS", "FINANCE"],
    ["FINANCE", "OPERATIONS"],
    ["DATA_GOVERNANCE", "OPERATIONS"]
]);

function fail(message, code = "GOVERNANCE_REVIEW_PACK_INVALID") {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function text(value, name, maximumLength = 1000) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) fail(`${name} is required.`);
    if (normalized.length > maximumLength) fail(`${name} must not exceed ${maximumLength} characters.`);
    return normalized;
}

function identifier(value, name) {
    const normalized = text(value, name, 200);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(normalized)) {
        fail(`${name} contains unsupported characters.`);
    }
    return normalized;
}

function timestamp(value, name) {
    const normalized = text(value, name, 80);
    if (Number.isNaN(Date.parse(normalized))) fail(`${name} must be an ISO-compatible timestamp.`);
    return normalized;
}

function positiveInteger(value, name) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${name} must be a positive safe integer.`);
    return parsed;
}

function safeReferences(value, name) {
    if (!Array.isArray(value) || value.length > 20) fail(`${name} must contain no more than 20 entries.`);
    const normalized = value.map((entry, index) => identifier(entry, `${name}[${index}]`));
    if (new Set(normalized).size !== normalized.length) fail(`${name} must not contain duplicates.`);
    return normalized;
}

function assertOnlyKeys(value, allowed, name) {
    const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
    if (unexpected.length > 0) fail(`${name} contains unsupported fields: ${unexpected.join(", ")}.`);
}

function uniqueOverrides(value, idField, name) {
    if (!Array.isArray(value)) fail(`${name} must be an array.`);
    const ids = value.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`${name}[${index}] must be an object.`);
        return text(entry[idField], `${name}[${index}].${idField}`, 200);
    });
    if (new Set(ids).size !== ids.length) fail(`${name} must not contain duplicate ${idField} values.`);
    return ids;
}

function rejectSecretFields(value, path = "reviewPack") {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
        if (!SAFE_FIELDS.has(key) && SECRET_KEY_PATTERN.test(key)) {
            fail(`${path}.${key} is not permitted in governance review evidence.`, "GOVERNANCE_REVIEW_SECRET_FIELD");
        }
        rejectSecretFields(child, `${path}.${key}`);
    }
}

function completedChecklist(authority, supplied = []) {
    const expected = OWNER_CHECKLISTS[authority];
    const suppliedById = new Map(supplied.map(entry => [entry.checkId, entry]));
    const unknown = [...suppliedById.keys()].filter(id => !expected.some(([expectedId]) => expectedId === id));
    if (unknown.length) fail(`${authority} checklist contains unsupported items: ${unknown.join(", ")}.`);
    return expected.map(([checkId, description]) => {
        const value = suppliedById.get(checkId) || {};
        return Object.freeze({
            checkId,
            description,
            complete: value.complete === true,
            evidenceReferences: safeReferences(value.evidenceReferences || [], `${authority}.${checkId}.evidenceReferences`)
        });
    }).map(item => {
        if (item.complete && item.evidenceReferences.length === 0) {
            fail(`${authority}.${item.checkId} requires evidence when complete.`);
        }
        return item;
    });
}

function normalizeDecisions(value, requesterReference, candidateDigests, reviewBasisDigest, createdAt) {
    if (!Array.isArray(value) || value.length > MANAGED_STAGING_APPROVAL_AUTHORITIES.length) {
        fail("decisionRecords must contain no more than one decision per required authority.");
    }
    const authoritySet = new Set();
    const reviewerSet = new Set();
    const decisionIdSet = new Set();
    return value.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            fail(`decisionRecords[${index}] must be an object.`);
        }
        const authority = text(entry.authority, `decisionRecords[${index}].authority`, 40).toUpperCase();
        if (!MANAGED_STAGING_APPROVAL_AUTHORITIES.includes(authority)) fail(`decisionRecords[${index}].authority is not supported.`);
        const decision = text(entry.decision, `decisionRecords[${index}].decision`, 50).toUpperCase();
        if (!GOVERNANCE_REVIEW_DECISIONS.includes(decision)) fail(`decisionRecords[${index}].decision is not supported.`);
        const reviewerReference = identifier(entry.reviewerReference, `decisionRecords[${index}].reviewerReference`);
        const decisionId = identifier(entry.decisionId, `decisionRecords[${index}].decisionId`);
        const decidedAt = timestamp(entry.decidedAt, `decisionRecords[${index}].decidedAt`);
        if (Date.parse(decidedAt) < Date.parse(createdAt)) fail(`decisionRecords[${index}].decidedAt predates the review pack.`);
        if (reviewerReference === requesterReference) fail("The review-pack requester cannot record an authority decision.", "GOVERNANCE_REVIEW_SEPARATION_OF_DUTIES");
        if (authoritySet.has(authority)) fail(`Authority ${authority} has more than one decision.`);
        if (reviewerSet.has(reviewerReference)) fail("Each required authority must use a distinct reviewer identity.", "GOVERNANCE_REVIEW_SEPARATION_OF_DUTIES");
        if (decisionIdSet.has(decisionId)) fail("decisionId values must be unique.");
        authoritySet.add(authority);
        reviewerSet.add(reviewerReference);
        decisionIdSet.add(decisionId);
        if (!Array.isArray(entry.conditions) || entry.conditions.length > 20) {
            fail(`decisionRecords[${index}].conditions must contain no more than 20 entries.`);
        }
        const conditions = Array.isArray(entry.conditions)
            ? entry.conditions.map((condition, conditionIndex) => text(condition, `decisionRecords[${index}].conditions[${conditionIndex}]`, 700))
            : [];
        if (new Set(conditions).size !== conditions.length) fail(`decisionRecords[${index}].conditions must not contain duplicates.`);
        if (decision === "APPROVE_WITH_CONDITIONS" && conditions.length === 0) {
            fail("APPROVE_WITH_CONDITIONS requires at least one explicit condition.");
        }
        if (decision !== "APPROVE_WITH_CONDITIONS" && conditions.length > 0) {
            fail("Only APPROVE_WITH_CONDITIONS may record approval conditions.");
        }
        const reviewedCandidateDigests = safeReferences(
            entry.reviewedCandidateDigests || [],
            `decisionRecords[${index}].reviewedCandidateDigests`
        );
        if (JSON.stringify([...reviewedCandidateDigests].sort()) !== JSON.stringify([...candidateDigests].sort())) {
            fail("Every decision must bind to the exact digest of every candidate pack.", "GOVERNANCE_REVIEW_DIGEST_MISMATCH");
        }
        if (entry.reviewBasisDigest !== reviewBasisDigest) {
            fail("Every decision must bind to the exact governance review basis digest.", "GOVERNANCE_REVIEW_DIGEST_MISMATCH");
        }
        return Object.freeze({
            decisionId,
            authority,
            reviewerReference,
            decision,
            rationale: text(entry.rationale, `decisionRecords[${index}].rationale`, 1500),
            conditions: Object.freeze(conditions),
            decidedAt,
            reviewBasisDigest,
            reviewedCandidateDigests: Object.freeze(reviewedCandidateDigests)
        });
    });
}

function questionOverrides(candidatePacks, supplied = []) {
    uniqueOverrides(supplied, "questionId", "candidateOpenQuestions");
    const overrides = new Map(supplied.map(entry => [entry.questionId, entry]));
    const expectedIds = candidatePacks.flatMap(pack => pack.openQuestions.map((_, index) => `${pack.packId}-question-${index + 1}`));
    const unknownIds = [...overrides.keys()].filter(questionId => !expectedIds.includes(questionId));
    if (unknownIds.length) fail(`candidateOpenQuestions contains unsupported question IDs: ${unknownIds.join(", ")}.`);
    return candidatePacks.flatMap(pack => pack.openQuestions.map((question, index) => {
        const questionId = `${pack.packId}-question-${index + 1}`;
        const value = overrides.get(questionId) || {};
        const status = String(value.status || "OPEN").toUpperCase();
        if (!["OPEN", "ANSWERED", "ACCEPTED_AS_CONDITION"].includes(status)) {
            fail(`${questionId}.status is not supported.`);
        }
        const response = value.response == null ? null : text(value.response, `${questionId}.response`, 1500);
        if (status !== "OPEN" && response === null) fail(`${questionId} requires a response when it is not open.`);
        const evidenceReferences = safeReferences(value.evidenceReferences || [], `${questionId}.evidenceReferences`);
        if (status !== "OPEN" && evidenceReferences.length === 0) fail(`${questionId} requires evidence when it is not open.`);
        return Object.freeze({
            questionId,
            candidatePackId: pack.packId,
            question,
            requiredAuthorities: Object.freeze(QUESTION_AUTHORITIES[index] || ["TECHNICAL"]),
            status,
            response,
            evidenceReferences: Object.freeze(evidenceReferences)
        });
    }));
}

function claimReviews(candidatePacks, supplied = []) {
    uniqueOverrides(supplied, "controlId", "claimSeverityReview");
    const overrides = new Map(supplied.map(entry => [entry.controlId, entry]));
    const unknownIds = [...overrides.keys()].filter(controlId => !PROVIDER_CANDIDATE_CONTROL_IDS.includes(controlId));
    if (unknownIds.length) fail(`claimSeverityReview contains unsupported controls: ${unknownIds.join(", ")}.`);
    return PROVIDER_CANDIDATE_CONTROL_IDS.map(controlId => {
        const [proposedSeverity, requiredAuthorities] = CLAIM_REVIEW_POLICY[controlId];
        const value = overrides.get(controlId) || {};
        const reviewStatus = String(value.reviewStatus || "PENDING").toUpperCase();
        if (!["PENDING", "ACCEPTED", "ACCEPTED_WITH_CONDITIONS", "REJECTED"].includes(reviewStatus)) {
            fail(`${controlId}.reviewStatus is not supported.`);
        }
        const finalSeverity = value.finalSeverity == null ? null : String(value.finalSeverity).toUpperCase();
        if (finalSeverity !== null && !["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(finalSeverity)) {
            fail(`${controlId}.finalSeverity is not supported.`);
        }
        const notes = value.notes == null ? null : text(value.notes, `${controlId}.notes`, 1200);
        if (reviewStatus !== "PENDING" && finalSeverity === null) fail(`${controlId} requires a final severity when reviewed.`);
        if (reviewStatus === "ACCEPTED_WITH_CONDITIONS" && notes === null) fail(`${controlId} requires condition notes.`);
        return Object.freeze({
            controlId,
            proposedSeverity,
            finalSeverity,
            rationale: `Severity reflects the impact of unsupported or misconfigured ${controlId} evidence; it is not a provider score.`,
            requiredAuthorities: Object.freeze(requiredAuthorities),
            reviewStatus,
            notes,
            candidateClaims: Object.freeze(candidatePacks.map(pack => {
                const claim = pack.claims.find(entry => entry.controlId === controlId);
                return Object.freeze({
                    candidatePackId: pack.packId,
                    status: claim.status,
                    nextVerification: claim.nextVerification
                });
            }))
        });
    });
}

function consolidatedOutcome({ ownerChecklists, questions, claims, rpoRtoWorksheet,
    evidenceStorageReview, sourceFreshnessRegister, decisions }) {
    const blockers = [];
    for (const checklist of ownerChecklists) {
        if (!checklist.items.every(item => item.complete)) blockers.push(`${checklist.authority}_CHECKLIST_INCOMPLETE`);
    }
    if (questions.some(question => question.status === "OPEN")) blockers.push("OPEN_CANDIDATE_QUESTIONS");
    if (claims.some(claim => ["PENDING", "REJECTED"].includes(claim.reviewStatus))) blockers.push("CLAIM_SEVERITY_REVIEW_INCOMPLETE");
    if (rpoRtoWorksheet.reviewStatus !== "REVIEWED") blockers.push("RPO_RTO_WORKSHEET_NOT_REVIEWED");
    if (evidenceStorageReview.reviewStatus !== "ACCEPTABLE") blockers.push("EVIDENCE_STORAGE_REVIEW_INCOMPLETE");
    if (sourceFreshnessRegister.some(source => source.status !== "CURRENT")) blockers.push("SOURCE_FRESHNESS_REVIEW_BLOCKED");

    const byAuthority = new Map(decisions.map(decision => [decision.authority, decision]));
    const missingAuthorities = MANAGED_STAGING_APPROVAL_AUTHORITIES.filter(authority => !byAuthority.has(authority));
    const rejectingAuthorities = decisions.filter(entry => entry.decision === "REJECT").map(entry => entry.authority);
    const deferredAuthorities = decisions.filter(entry => entry.decision === "DEFER").map(entry => entry.authority);
    const unacceptableAuthorities = decisions.filter(entry => !ACCEPTABLE_DECISIONS.has(entry.decision)).map(entry => entry.authority);
    if (missingAuthorities.length) blockers.push("REQUIRED_AUTHORITY_DECISIONS_MISSING");
    if (unacceptableAuthorities.length) blockers.push("REQUIRED_AUTHORITY_DECISION_NOT_ACCEPTABLE");
    const authoritiesOwningConditions = new Set([
        ...questions
            .filter(question => question.status === "ACCEPTED_AS_CONDITION")
            .flatMap(question => question.requiredAuthorities),
        ...claims
            .filter(claim => claim.reviewStatus === "ACCEPTED_WITH_CONDITIONS")
            .flatMap(claim => claim.requiredAuthorities)
    ]);
    const unboundConditions = [...authoritiesOwningConditions].filter(authority => (
        byAuthority.get(authority)?.decision !== "APPROVE_WITH_CONDITIONS"
    ));
    if (unboundConditions.length) blockers.push("REVIEW_CONDITIONS_NOT_BOUND_TO_AUTHORITY_DECISIONS");

    const acceptableAuthorities = decisions.filter(entry => ACCEPTABLE_DECISIONS.has(entry.decision)).map(entry => entry.authority);
    const conditionalAuthorities = decisions.filter(entry => entry.decision === "APPROVE_WITH_CONDITIONS").map(entry => entry.authority);
    const status = blockers.length > 0
        ? "BLOCKED"
        : conditionalAuthorities.length > 0 ? "REVIEW_COMPLETE_WITH_CONDITIONS" : "REVIEW_COMPLETE";
    return Object.freeze({
        status,
        requiredAuthorities: MANAGED_STAGING_APPROVAL_AUTHORITIES,
        acceptableAuthorities: Object.freeze(acceptableAuthorities),
        conditionalAuthorities: Object.freeze(conditionalAuthorities),
        rejectingAuthorities: Object.freeze(rejectingAuthorities),
        deferredAuthorities: Object.freeze(deferredAuthorities),
        missingAuthorities: Object.freeze(missingAuthorities),
        blockers: Object.freeze([...new Set(blockers)]),
        providerSelected: false,
        stagingAuthorized: false,
        productionAuthorized: false,
        nextDecision: status === "BLOCKED"
            ? "Every required authority must independently complete its checklist and record an acceptable decision on the exact candidate-pack digests."
            : "Governance review is complete only; a separate explicitly authorized disposable-staging decision is still required."
    });
}

function payload(input) {
    assertOnlyKeys(input, [
        "reviewPackVersion", "reviewPackId", "reviewPackDigest", "createdAt",
        "requesterReference", "maximumSourceAgeDays", "candidatePacks",
        "ownerChecklists", "candidateOpenQuestions", "claimSeverityReview",
        "rpoRtoWorksheet", "evidenceStorageReview", "decisionRecords"
    ], "reviewPack input");
    const reviewPackId = identifier(input.reviewPackId, "reviewPackId");
    const createdAt = timestamp(input.createdAt, "createdAt");
    const requesterReference = identifier(input.requesterReference, "requesterReference");
    const maximumSourceAgeDays = positiveInteger(input.maximumSourceAgeDays ?? 30, "maximumSourceAgeDays");
    if (!Array.isArray(input.candidatePacks) || input.candidatePacks.length < 2 || input.candidatePacks.length > 10) {
        fail("candidatePacks must contain between 2 and 10 candidate packs.");
    }
    const candidatePacks = input.candidatePacks.map(createProviderCandidatePack);
    if (new Set(candidatePacks.map(pack => pack.packId)).size !== candidatePacks.length) fail("candidatePacks must use unique packId values.");
    const candidateDigests = candidatePacks.map(pack => pack.packDigest);

    const ownerChecklistInput = input.ownerChecklists || [];
    uniqueOverrides(ownerChecklistInput, "authority", "ownerChecklists");
    const normalizedChecklistAuthorities = ownerChecklistInput.map(entry => String(entry.authority).toUpperCase());
    if (new Set(normalizedChecklistAuthorities).size !== normalizedChecklistAuthorities.length) {
        fail("ownerChecklists must not contain duplicate authorities.");
    }
    const invalidAuthorities = ownerChecklistInput
        .map(entry => String(entry.authority).toUpperCase())
        .filter(authority => !MANAGED_STAGING_APPROVAL_AUTHORITIES.includes(authority));
    if (invalidAuthorities.length) fail(`ownerChecklists contains unsupported authorities: ${invalidAuthorities.join(", ")}.`);
    const suppliedChecklists = new Map(ownerChecklistInput.map(entry => [String(entry.authority).toUpperCase(), entry.items || []]));
    const ownerChecklists = MANAGED_STAGING_APPROVAL_AUTHORITIES.map(authority => Object.freeze({
        authority,
        items: Object.freeze(completedChecklist(authority, suppliedChecklists.get(authority) || []))
    }));
    const questions = questionOverrides(candidatePacks, input.candidateOpenQuestions || []);
    const claims = claimReviews(candidatePacks, input.claimSeverityReview || []);

    const rpoInput = input.rpoRtoWorksheet || {};
    const rpoReviewStatus = String(rpoInput.reviewStatus || "PENDING").toUpperCase();
    if (!["PENDING", "REVIEWED"].includes(rpoReviewStatus)) fail("rpoRtoWorksheet.reviewStatus is not supported.");
    const rpoEvidenceReferences = safeReferences(rpoInput.evidenceReferences || [], "rpoRtoWorksheet.evidenceReferences");
    if (rpoReviewStatus === "REVIEWED" && rpoEvidenceReferences.length === 0) fail("A reviewed RPO/RTO worksheet requires evidence.");
    const rpoRtoWorksheet = Object.freeze({
        status: "PROPOSED_FOR_REVIEW",
        proposedRpoSeconds: positiveInteger(rpoInput.proposedRpoSeconds ?? 900, "rpoRtoWorksheet.proposedRpoSeconds"),
        proposedRtoSeconds: positiveInteger(rpoInput.proposedRtoSeconds ?? 3600, "rpoRtoWorksheet.proposedRtoSeconds"),
        reviewStatus: rpoReviewStatus,
        evidenceReferences: Object.freeze(rpoEvidenceReferences),
        basis: text(rpoInput.basis || "Targets are review inputs for backup frequency, isolated restore, reconciliation and supervised release; they are not service promises.", "rpoRtoWorksheet.basis", 1500),
        assumptions: Object.freeze((rpoInput.assumptions || [
            "Recovery safety mode remains enabled until reconciliation passes.",
            "Emergency stops and OUTCOME_UNKNOWN commands remain blocked after restore.",
            "RTO includes restore, reconciliation and supervised release rather than database availability alone."
        ]).map((entry, index) => text(entry, `rpoRtoWorksheet.assumptions[${index}]`, 700)))
    });

    const evidenceInput = input.evidenceStorageReview || {};
    const evidenceReviewStatus = String(evidenceInput.reviewStatus || "PENDING").toUpperCase();
    if (!["PENDING", "ACCEPTABLE", "REJECTED"].includes(evidenceReviewStatus)) fail("evidenceStorageReview.reviewStatus is not supported.");
    const evidenceReferences = safeReferences(evidenceInput.evidenceReferences || [], "evidenceStorageReview.evidenceReferences");
    if (evidenceReviewStatus === "ACCEPTABLE" && evidenceReferences.length === 0) fail("An acceptable evidence-storage review requires evidence.");
    const evidenceStorageReview = Object.freeze({
        reviewStatus: evidenceReviewStatus,
        outsideRepositoryRequired: true,
        appendOnlyRequired: true,
        encryptionRequired: true,
        leastPrivilegeAccessRequired: true,
        retentionDecisionRequired: true,
        immutableDecisionEvidenceRequired: true,
        evidenceReferences: Object.freeze(evidenceReferences),
        limitations: Object.freeze([
            "This repository contains only schemas, validators and a non-authoritative draft; signed review evidence belongs in a protected external evidence store.",
            "No storage provider, encryption key, credential, location containing secrets or retention schedule is selected by this pack."
        ])
    });

    const sourceFreshnessRegister = Object.freeze(candidatePacks.flatMap(pack => pack.sources.map(source => {
        if (Date.parse(source.accessedAt) > Date.parse(createdAt)) fail(`Source ${source.sourceId} was accessed after the review pack was created.`);
        const ageDays = Math.floor((Date.parse(createdAt) - Date.parse(source.accessedAt)) / DAY_MS);
        return Object.freeze({
            candidatePackId: pack.packId,
            sourceId: source.sourceId,
            accessedAt: source.accessedAt,
            documentDate: source.documentDate,
            ageDays,
            maximumAgeDays: maximumSourceAgeDays,
            status: ageDays > maximumSourceAgeDays ? "STALE" : "CURRENT"
        });
    })));

    const candidatePackSummaries = candidatePacks.map(pack => Object.freeze({
        packId: pack.packId,
        packDigest: pack.packDigest,
        providerLabel: pack.candidate.providerLabel,
        serviceLabel: pack.candidate.serviceLabel,
        regionLabel: pack.candidate.regionLabel,
        regionCode: pack.candidate.regionCode,
        reviewedAt: pack.reviewedAt
    }));
    const risksAndLimitations = Object.freeze([
        { riskId: "published-claims-unverified", severity: "CRITICAL", status: "OPEN", statement: "Published documentation does not prove configured control behaviour or Alpacaly recovery safety." },
        { riskId: "commercial-evidence-incomplete", severity: "HIGH", status: "OPEN", statement: "No quote, contract, support commitment or approved total-cost model exists." },
        { riskId: "uk-data-review-incomplete", severity: "CRITICAL", status: "OPEN", statement: "UK region availability is not a completed data-transfer or privacy review." },
        { riskId: "staging-drill-not-run", severity: "CRITICAL", status: "OPEN", statement: "No provider account, disposable database, PITR test or Alpacaly restore-safety drill has been authorized or run." },
        { riskId: "source-freshness", severity: "MEDIUM", status: sourceFreshnessRegister.some(source => source.status === "STALE") ? "BLOCKED" : "OPEN", statement: "Provider documentation can change and must be refreshed before a later decision." }
    ]);
    const separationOfDuties = Object.freeze({
        requiredAuthorities: MANAGED_STAGING_APPROVAL_AUTHORITIES,
        requesterMayDecide: false,
        distinctReviewerPerAuthorityRequired: true,
        oneDecisionPerAuthority: true,
        exactCandidateDigestsRequired: true,
        exactReviewBasisDigestRequired: true,
        appendOnlyExternalDecisionEvidenceRequired: true
    });
    const reviewBasisDigest = createHash("sha256").update(JSON.stringify({
        reviewPackVersion: GOVERNANCE_REVIEW_PACK_VERSION,
        reviewPackId,
        createdAt,
        scope: GOVERNANCE_REVIEW_SCOPE,
        requesterReference,
        candidatePacks: candidatePackSummaries,
        ownerChecklists,
        candidateOpenQuestions: questions,
        claimSeverityReview: claims,
        rpoRtoWorksheet,
        evidenceStorageReview,
        sourceFreshnessRegister,
        risksAndLimitations,
        separationOfDuties
    })).digest("hex");
    const decisions = normalizeDecisions(
        input.decisionRecords || [],
        requesterReference,
        candidateDigests,
        reviewBasisDigest,
        createdAt
    );
    const outcome = consolidatedOutcome({
        ownerChecklists,
        questions,
        claims,
        rpoRtoWorksheet,
        evidenceStorageReview,
        sourceFreshnessRegister,
        decisions
    });

    return {
        reviewPackVersion: GOVERNANCE_REVIEW_PACK_VERSION,
        reviewPackId,
        reviewBasisDigest,
        createdAt,
        scope: GOVERNANCE_REVIEW_SCOPE,
        requesterReference,
        executiveSummary: {
            purpose: "Independent review of two published-document provider candidate packs before any separate disposable-staging decision.",
            recommendation: "NO_PROVIDER_RANKING_OR_SELECTION",
            consolidatedOutcome: outcome.status,
            nextDecision: outcome.nextDecision
        },
        candidatePacks: candidatePackSummaries,
        ownerChecklists,
        candidateOpenQuestions: questions,
        claimSeverityReview: claims,
        rpoRtoWorksheet,
        evidenceStorageReview,
        sourceFreshnessRegister,
        risksAndLimitations,
        separationOfDuties,
        decisionRecords: decisions,
        consolidatedOutcome: outcome,
        declarations: {
            providerRanked: false,
            providerSelected: false,
            accountsCreated: false,
            credentialsUsed: false,
            providerApiCallsMade: false,
            databasesConnected: false,
            resourcesProvisioned: false,
            stagingAuthorized: false,
            productionAuthorized: false,
            externalConnectionsAuthorized: false
        }
    };
}

export function governanceReviewPackDigest(reviewPack) {
    const normalized = { ...reviewPack };
    delete normalized.reviewPackDigest;
    return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function createGovernanceReviewPack(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("reviewPack input must be an object.");
    rejectSecretFields(input);
    if (input.reviewPackVersion !== undefined && Number(input.reviewPackVersion) !== GOVERNANCE_REVIEW_PACK_VERSION) {
        fail(`Governance review pack version ${input.reviewPackVersion} is not supported.`);
    }
    const normalized = payload(input);
    const reviewPackDigest = governanceReviewPackDigest(normalized);
    if (input.reviewPackDigest && input.reviewPackDigest !== reviewPackDigest) {
        fail("Governance review pack digest does not match its reviewed payload.", "GOVERNANCE_REVIEW_DIGEST_MISMATCH");
    }
    return Object.freeze({ ...normalized, reviewPackDigest });
}
