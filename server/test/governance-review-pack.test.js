import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
    GOVERNANCE_REVIEW_DECISIONS,
    MANAGED_STAGING_APPROVAL_AUTHORITIES,
    PROVIDER_CANDIDATE_CONTROL_IDS,
    createGovernanceReviewPack,
    readProviderCandidatePack
} from "../src/disaster-recovery/index.js";

const AWS_PATH = join(process.cwd(), "docs/provider-candidates/aws-rds-postgresql-london.json");
const GOOGLE_PATH = join(process.cwd(), "docs/provider-candidates/google-cloud-sql-postgresql-london.json");

function candidates() {
    return [readProviderCandidatePack(AWS_PATH), readProviderCandidatePack(GOOGLE_PATH)];
}

function base(overrides = {}) {
    return {
        reviewPackVersion: 1,
        reviewPackId: "phase-7f2e-governance-review",
        createdAt: "2026-07-22T16:00:00.000Z",
        requesterReference: "governance-coordinator-01",
        maximumSourceAgeDays: 30,
        candidatePacks: candidates(),
        ...overrides
    };
}

function completedReview({ conditionalAuthority = null } = {}) {
    const draft = createGovernanceReviewPack(base());
    const reviewedContent = {
        ownerChecklists: draft.ownerChecklists.map(checklist => ({
            authority: checklist.authority,
            items: checklist.items.map(item => ({
                checkId: item.checkId,
                complete: true,
                evidenceReferences: [`${checklist.authority.toLowerCase()}-${item.checkId}-evidence`]
            }))
        })),
        candidateOpenQuestions: draft.candidateOpenQuestions.map(question => ({
            questionId: question.questionId,
            status: "ANSWERED",
            response: "Independent owners recorded a decision-grade response in protected evidence.",
            evidenceReferences: [`${question.questionId}-evidence`]
        })),
        claimSeverityReview: draft.claimSeverityReview.map(claim => ({
            controlId: claim.controlId,
            finalSeverity: claim.proposedSeverity,
            reviewStatus: "ACCEPTED",
            notes: "Required owners reviewed the severity without scoring either candidate."
        })),
        rpoRtoWorksheet: {
            reviewStatus: "REVIEWED",
            proposedRpoSeconds: 900,
            proposedRtoSeconds: 3600,
            basis: "Independent review accepted these values only as targets for a later disposable drill.",
            evidenceReferences: ["rpo-rto-review-evidence-01"]
        },
        evidenceStorageReview: {
            reviewStatus: "ACCEPTABLE",
            evidenceReferences: ["protected-governance-evidence-design-01"]
        }
    };
    const reviewedBasis = createGovernanceReviewPack(base(reviewedContent));
    const candidateDigests = reviewedBasis.candidatePacks.map(pack => pack.packDigest);
    return createGovernanceReviewPack(base({
        ...reviewedContent,
        decisionRecords: MANAGED_STAGING_APPROVAL_AUTHORITIES.map((authority, index) => ({
            decisionId: `decision-${authority.toLowerCase()}-01`,
            authority,
            reviewerReference: `${authority.toLowerCase()}-reviewer-${index + 1}`,
            decision: authority === conditionalAuthority ? "APPROVE_WITH_CONDITIONS" : "APPROVE",
            rationale: `Independent ${authority.toLowerCase()} review completed against both immutable candidate packs.`,
            conditions: authority === conditionalAuthority
                ? ["The condition must be verified before any later staging authorization."]
                : [],
            decidedAt: `2026-07-23T0${index}:00:00.000Z`,
            reviewBasisDigest: reviewedBasis.reviewBasisDigest,
            reviewedCandidateDigests: candidateDigests
        }))
    }));
}

test("governance draft includes every required section and fails closed", () => {
    const review = createGovernanceReviewPack(base());
    assert.match(review.reviewPackDigest, /^[a-f0-9]{64}$/);
    assert.equal(review.scope, "INDEPENDENT_PROVIDER_GOVERNANCE_REVIEW_ONLY");
    assert.equal(review.candidatePacks.length, 2);
    assert.equal(review.ownerChecklists.length, 5);
    assert.equal(review.ownerChecklists.every(entry => entry.items.length === 5), true);
    assert.equal(review.candidateOpenQuestions.length, 12);
    assert.equal(review.claimSeverityReview.length, PROVIDER_CANDIDATE_CONTROL_IDS.length);
    assert.equal(review.sourceFreshnessRegister.length, 23);
    assert.equal(review.decisionRecords.length, 0);
    assert.equal(review.consolidatedOutcome.status, "BLOCKED");
    assert.deepEqual(review.consolidatedOutcome.missingAuthorities,
        MANAGED_STAGING_APPROVAL_AUTHORITIES);
    assert.equal(review.executiveSummary.recommendation,
        "NO_PROVIDER_RANKING_OR_SELECTION");
    assert.equal(Object.values(review.declarations).every(value => value === false), true);
    assert.equal(review.separationOfDuties.requesterMayDecide, false);
    assert.equal(review.rpoRtoWorksheet.status, "PROPOSED_FOR_REVIEW");
    assert.equal(review.evidenceStorageReview.outsideRepositoryRequired, true);
});

test("all five independent acceptable decisions complete review without authorizing staging", () => {
    const review = completedReview();
    assert.equal(review.consolidatedOutcome.status, "REVIEW_COMPLETE");
    assert.deepEqual(review.consolidatedOutcome.blockers, []);
    assert.equal(review.consolidatedOutcome.acceptableAuthorities.length, 5);
    assert.equal(review.consolidatedOutcome.providerSelected, false);
    assert.equal(review.consolidatedOutcome.stagingAuthorized, false);
    assert.equal(review.consolidatedOutcome.productionAuthorized, false);
    assert.equal(review.declarations.externalConnectionsAuthorized, false);
});

test("acceptable conditional decisions remain explicit and non-authorizing", () => {
    const review = completedReview({ conditionalAuthority: "SECURITY" });
    assert.equal(review.consolidatedOutcome.status, "REVIEW_COMPLETE_WITH_CONDITIONS");
    assert.deepEqual(review.consolidatedOutcome.conditionalAuthorities, ["SECURITY"]);
    assert.equal(review.declarations.stagingAuthorized, false);

    const draft = createGovernanceReviewPack(base());
    assert.throws(() => createGovernanceReviewPack(base({
        decisionRecords: [{
            decisionId: "conditional-without-condition",
            authority: "SECURITY",
            reviewerReference: "security-reviewer-01",
            decision: "APPROVE_WITH_CONDITIONS",
            rationale: "Incomplete conditional record.",
            conditions: [],
            decidedAt: "2026-07-23T00:00:00.000Z",
            reviewBasisDigest: draft.reviewBasisDigest,
            reviewedCandidateDigests: draft.candidatePacks.map(pack => pack.packDigest)
        }]
    })), /requires at least one explicit condition/);
});

test("conditional review findings must be bound to the responsible authority decisions", () => {
    const complete = completedReview();
    const questions = complete.candidateOpenQuestions.map((question, index) => (
        index === 0 ? { ...question, status: "ACCEPTED_AS_CONDITION" } : question
    ));
    const reviewedContent = {
        ownerChecklists: complete.ownerChecklists,
        candidateOpenQuestions: questions,
        claimSeverityReview: complete.claimSeverityReview,
        rpoRtoWorksheet: complete.rpoRtoWorksheet,
        evidenceStorageReview: complete.evidenceStorageReview
    };
    const basis = createGovernanceReviewPack(base(reviewedContent));
    const decisions = complete.decisionRecords.map(decision => ({
        ...decision,
        reviewBasisDigest: basis.reviewBasisDigest
    }));
    const unbound = createGovernanceReviewPack(base({ ...reviewedContent, decisionRecords: decisions }));
    assert.equal(unbound.consolidatedOutcome.status, "BLOCKED");
    assert.equal(unbound.consolidatedOutcome.blockers.includes(
        "REVIEW_CONDITIONS_NOT_BOUND_TO_AUTHORITY_DECISIONS"
    ), true);

    const boundDecisions = decisions.map(decision => (
        ["TECHNICAL", "OPERATIONS"].includes(decision.authority)
            ? {
                ...decision,
                decision: "APPROVE_WITH_CONDITIONS",
                conditions: ["Resolve the recorded deployment-shape condition before staging."]
            }
            : decision
    ));
    const bound = createGovernanceReviewPack(base({
        ...reviewedContent,
        decisionRecords: boundDecisions
    }));
    assert.equal(bound.consolidatedOutcome.status, "REVIEW_COMPLETE_WITH_CONDITIONS");
});

test("missing, deferred or rejected authority decisions keep the review blocked", () => {
    const complete = completedReview();
    const common = {
        ownerChecklists: complete.ownerChecklists,
        candidateOpenQuestions: complete.candidateOpenQuestions,
        claimSeverityReview: complete.claimSeverityReview,
        rpoRtoWorksheet: complete.rpoRtoWorksheet,
        evidenceStorageReview: complete.evidenceStorageReview
    };
    const missing = createGovernanceReviewPack(base({
        ...common,
        decisionRecords: complete.decisionRecords.slice(0, 4)
    }));
    assert.equal(missing.consolidatedOutcome.status, "BLOCKED");
    assert.deepEqual(missing.consolidatedOutcome.missingAuthorities, ["FINANCE"]);

    for (const decision of ["DEFER", "REJECT"]) {
        const decisions = complete.decisionRecords.map(entry => (
            entry.authority === "FINANCE" ? { ...entry, decision } : entry
        ));
        const review = createGovernanceReviewPack(base({ ...common, decisionRecords: decisions }));
        assert.equal(review.consolidatedOutcome.status, "BLOCKED", decision);
    }
});

test("separation of duties, candidate digests and decision values fail closed", () => {
    const draft = createGovernanceReviewPack(base());
    const candidateDigests = draft.candidatePacks.map(pack => pack.packDigest);
    const decision = {
        decisionId: "technical-decision-01",
        authority: "TECHNICAL",
        reviewerReference: "governance-coordinator-01",
        decision: "APPROVE",
        rationale: "Attempted self-review.",
        conditions: [],
        decidedAt: "2026-07-23T00:00:00.000Z",
        reviewBasisDigest: draft.reviewBasisDigest,
        reviewedCandidateDigests: candidateDigests
    };
    assert.throws(
        () => createGovernanceReviewPack(base({ decisionRecords: [decision] })),
        error => error.code === "GOVERNANCE_REVIEW_SEPARATION_OF_DUTIES"
    );
    assert.throws(() => createGovernanceReviewPack(base({
        decisionRecords: [{
            ...decision,
            reviewerReference: "technical-reviewer-01",
            reviewedCandidateDigests: [candidateDigests[0]]
        }]
    })), error => error.code === "GOVERNANCE_REVIEW_DIGEST_MISMATCH");
    assert.deepEqual(GOVERNANCE_REVIEW_DECISIONS,
        ["APPROVE", "APPROVE_WITH_CONDITIONS", "REJECT", "DEFER"]);
});

test("stale sources and incomplete review worksheets remain visible blockers", () => {
    const review = createGovernanceReviewPack(base({
        createdAt: "2026-09-01T00:00:00.000Z",
        maximumSourceAgeDays: 30
    }));
    assert.equal(review.sourceFreshnessRegister.every(source => source.status === "STALE"), true);
    assert.equal(review.consolidatedOutcome.status, "BLOCKED");
    assert.equal(review.consolidatedOutcome.blockers.includes("SOURCE_FRESHNESS_REVIEW_BLOCKED"), true);
    assert.equal(review.consolidatedOutcome.blockers.includes("RPO_RTO_WORKSHEET_NOT_REVIEWED"), true);
    assert.equal(review.consolidatedOutcome.blockers.includes("EVIDENCE_STORAGE_REVIEW_INCOMPLETE"), true);
});

test("candidate tampering and secret-shaped review fields are rejected", () => {
    const tampered = JSON.parse(readFileSync(AWS_PATH, "utf8"));
    tampered.candidate.regionLabel = "Changed after candidate review";
    assert.throws(() => createGovernanceReviewPack(base({
        candidatePacks: [tampered, candidates()[1]]
    })), error => error.code === "PROVIDER_CANDIDATE_PACK_DIGEST_MISMATCH");
    assert.throws(() => createGovernanceReviewPack(base({
        databaseUrl: "forbidden"
    })), error => error.code === "GOVERNANCE_REVIEW_SECRET_FIELD");
});

test("offline command emits a blocked, non-authorizing review draft", () => {
    const result = spawnSync(process.execPath, [
        join(process.cwd(), "scripts/governance-review-pack.js"),
        "--candidate", AWS_PATH,
        "--candidate", GOOGLE_PATH,
        "--requester", "governance-coordinator-01",
        "--created-at", "2026-07-22T16:00:00.000Z"
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const review = JSON.parse(result.stdout);
    assert.equal(review.consolidatedOutcome.status, "BLOCKED");
    assert.equal(review.declarations.providerRanked, false);
    assert.equal(review.declarations.providerSelected, false);
    assert.equal(review.declarations.accountsCreated, false);
    assert.equal(review.declarations.externalConnectionsAuthorized, false);
});

test("offline command revalidates an edited local review without trusting derived fields", t => {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-governance-review-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const draft = createGovernanceReviewPack(base());
    const path = join(directory, "review.json");
    writeFileSync(path, JSON.stringify({
        ...draft,
        executiveSummary: { ...draft.executiveSummary, consolidatedOutcome: "REVIEW_COMPLETE" },
        declarations: { ...draft.declarations, providerSelected: true }
    }));
    const result = spawnSync(process.execPath, [
        join(process.cwd(), "scripts/governance-review-pack.js"),
        "--candidate", AWS_PATH,
        "--candidate", GOOGLE_PATH,
        "--review", path
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const regenerated = JSON.parse(result.stdout);
    assert.equal(regenerated.executiveSummary.consolidatedOutcome, "BLOCKED");
    assert.equal(regenerated.declarations.providerSelected, false);
    assert.equal(regenerated.reviewPackDigest, draft.reviewPackDigest);
});

test("governance schema fixes scope, decision choices and authorization declarations", () => {
    const schema = JSON.parse(readFileSync(
        join(process.cwd(), "docs/governance-review-pack.schema.json"),
        "utf8"
    ));
    assert.equal(schema.properties.scope.const,
        "INDEPENDENT_PROVIDER_GOVERNANCE_REVIEW_ONLY");
    assert.deepEqual(schema.properties.decisionRecords.items.properties.decision.enum,
        GOVERNANCE_REVIEW_DECISIONS);
    for (const property of schema.properties.declarations.required) {
        assert.equal(schema.properties.declarations.properties[property].const, false);
    }
});
