import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
    MANAGED_STAGING_APPROVAL_AUTHORITIES,
    ManagedStagingEvaluationService,
    createManagedStagingAssessment,
    readManagedStagingAssessment,
    writeManagedStagingAssessment
} from "../src/disaster-recovery/index.js";

const NOW = "2026-07-22T12:00:00.000Z";

function temporaryDirectory(t) {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-managed-staging-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function identifierGenerator(prefix = "id") {
    let sequence = 0;
    return () => `${prefix}-${++sequence}`;
}

function assessment(overrides = {}) {
    const base = {
        assessmentVersion: 1,
        assessmentId: "managed-staging-candidate-01",
        collectedAt: "2026-07-22T11:00:00.000Z",
        environment: "staging",
        candidate: {
            providerLabel: "candidate-a",
            serviceLabel: "managed-postgresql",
            region: "uk-region-a",
            postgresVersion: "16.4"
        },
        capabilities: {
            managedPostgres: true,
            encryptedStorage: true,
            encryptedBackups: true,
            pitrAvailable: true,
            isolatedRestoreAvailable: true,
            nativeExportAvailable: true,
            monitoringAvailable: true
        },
        security: {
            tlsMinimum: "TLS_1_3",
            hostnameVerification: true,
            privateNetworking: true,
            publicAccessDisabled: true,
            secretManagerIntegration: true,
            credentialRotation: true,
            humanMfaRequired: true,
            administrativeAuditLogging: true
        },
        roles: {
            applicationRoleSeparated: true,
            migrationRoleSeparated: true,
            backupRoleSeparated: true,
            restoreRoleSeparated: true,
            monitoringRoleSeparated: true,
            breakGlassControlled: true,
            evidenceReference: "role-boundary-evidence-01"
        },
        pitr: {
            planReference: "pitr-plan-01",
            transactionBoundaryDefined: true,
            walContinuityCheckPlanned: true,
            testStatus: "PASS",
            evidenceReference: "pitr-evidence-01",
            gapDetected: false,
            measuredRpoSeconds: 180,
            targetRpoSeconds: 900
        },
        restoreDrill: {
            reportReference: "restore-report-01",
            status: "PASS",
            checksumVerified: true,
            reconciliationStatus: "PASS",
            workersRemainedBlocked: true,
            uncertainCommandsRemainedBlocked: true,
            emergencyStopsPreserved: true,
            measuredRestoreSeconds: 900,
            measuredReconciliationSeconds: 120,
            measuredSupervisedReleaseSeconds: 300,
            targetRtoSeconds: 3600
        },
        portability: {
            nativeDumpRestore: true,
            exportTested: true,
            extensionInventoryComplete: true,
            proprietaryDependencies: [],
            exitPlanReference: "exit-plan-01",
            lockInRisk: "LOW"
        },
        operations: {
            costEvidenceReference: "cost-evidence-01",
            currency: "GBP",
            monthlyEstimateMinor: 25000,
            supportEvidenceReference: "support-evidence-01",
            supportLevel: "reviewed-staging-support",
            supportResponseMinutes: 30,
            serviceLimitsReviewed: true,
            incidentHistoryReviewed: true,
            monitoringPlanReviewed: true
        },
        governance: {
            ukRegionAvailable: true,
            dataTransferReviewed: true,
            privacyAssessmentReference: "privacy-review-01",
            welfareReviewReference: "welfare-review-01"
        },
        collection: {
            source: "COMBINED",
            collectorVersion: "evaluation-fixture-1"
        }
    };
    return {
        ...base,
        ...overrides,
        candidate: { ...base.candidate, ...overrides.candidate },
        capabilities: { ...base.capabilities, ...overrides.capabilities },
        security: { ...base.security, ...overrides.security },
        roles: { ...base.roles, ...overrides.roles },
        pitr: { ...base.pitr, ...overrides.pitr },
        restoreDrill: { ...base.restoreDrill, ...overrides.restoreDrill },
        portability: { ...base.portability, ...overrides.portability },
        operations: { ...base.operations, ...overrides.operations },
        governance: { ...base.governance, ...overrides.governance },
        collection: { ...base.collection, ...overrides.collection }
    };
}

function service(t, options = {}) {
    const directory = options.directory || temporaryDirectory(t);
    return new ManagedStagingEvaluationService({
        directory,
        clock: options.clock || (() => new Date(NOW)),
        idGenerator: options.idGenerator || identifierGenerator("event"),
        ...options
    });
}

function approveAll(evaluationService, assessmentId = "managed-staging-candidate-01") {
    evaluationService.requestApproval({
        assessmentId,
        requestId: `approval-${assessmentId}`,
        requestedBy: "evaluation-owner-01",
        expiresAt: "2026-08-01T00:00:00.000Z",
        reason: "Request independent managed staging evaluation sign-off."
    });
    for (const [index, authority] of MANAGED_STAGING_APPROVAL_AUTHORITIES.entries()) {
        evaluationService.recordSignoff({
            requestId: `approval-${assessmentId}`,
            authority,
            authorityReference: `${authority.toLowerCase()}-reviewer-${index + 1}`,
            decisionId: `${assessmentId}-${authority.toLowerCase()}-approval`,
            decision: "APPROVE",
            reason: `Independent ${authority.toLowerCase()} evidence review completed.`
        });
    }
}

test("managed staging assessments are allow-listed, checksummed, secret-free and append-only", t => {
    const directory = temporaryDirectory(t);
    const created = createManagedStagingAssessment(assessment());
    assert.match(created.assessmentDigest, /^[a-f0-9]{64}$/);
    const written = writeManagedStagingAssessment(directory, created);
    assert.deepEqual(readManagedStagingAssessment(written.path), created);
    assert.throws(
        () => writeManagedStagingAssessment(directory, created),
        error => error.code === "EEXIST"
    );
    assert.throws(
        () => createManagedStagingAssessment({
            ...assessment(),
            candidate: { ...assessment().candidate, accessToken: "not-allowed" }
        }),
        error => error.code === "MANAGED_STAGING_ASSESSMENT_SECRET_FIELD"
    );

    const tampered = JSON.parse(readFileSync(written.path, "utf8"));
    tampered.security.privateNetworking = false;
    writeFileSync(written.path, JSON.stringify(tampered));
    assert.throws(
        () => readManagedStagingAssessment(written.path),
        error => error.code === "MANAGED_STAGING_ASSESSMENT_DIGEST_MISMATCH"
    );
});

test("complete independent evidence and sign-off produces staging-only PASS", t => {
    const evaluationService = service(t);
    evaluationService.recordAssessment(assessment());
    assert.equal(evaluationService.evaluate().status, "BLOCKED");
    approveAll(evaluationService);

    const report = evaluationService.evaluate();
    assert.equal(report.status, "PASS");
    assert.deepEqual(report.alerts, []);
    assert.equal(report.approval.status, "APPROVED");
    assert.equal(report.assessment.restoreDrillScore, 100);
    assert.equal(report.assessment.measuredRtoSeconds, 1320);
    assert.equal(report.scope, "MANAGED_STAGING_EVALUATION_ONLY");
    assert.equal(report.productionReadiness, false);
    assert.equal(report.productionUseAuthorized, false);
    assert.equal(report.externalConnectionsAuthorized, false);
});

test("warning evidence remains non-production and records portability and support concerns", t => {
    const evaluationService = service(t);
    evaluationService.recordAssessment(assessment({
        portability: {
            lockInRisk: "HIGH",
            proprietaryDependencies: ["provider-specific-observability"]
        },
        operations: { supportResponseMinutes: 90 }
    }));
    approveAll(evaluationService);
    const report = evaluationService.evaluate();
    const codes = new Set(report.alerts.map(entry => entry.code));
    assert.equal(report.status, "WARNING");
    assert.equal(codes.has("MANAGED_STAGING_LOCK_IN_RISK"), true);
    assert.equal(codes.has("MANAGED_STAGING_PROPRIETARY_DEPENDENCIES"), true);
    assert.equal(codes.has("MANAGED_STAGING_SUPPORT_RESPONSE_SLOWER_THAN_RTO"), true);
    assert.equal(report.productionReadiness, false);
});

test("TLS, network, role, PITR, RPO, restore and portability gaps fail closed", t => {
    const evaluationService = service(t);
    evaluationService.recordAssessment(assessment({
        candidate: { postgresVersion: "15.9" },
        capabilities: { isolatedRestoreAvailable: false },
        security: {
            tlsMinimum: "BELOW_TLS_1_2",
            hostnameVerification: false,
            privateNetworking: false,
            publicAccessDisabled: false,
            secretManagerIntegration: false
        },
        roles: { restoreRoleSeparated: false },
        pitr: {
            testStatus: "FAILED",
            evidenceReference: null,
            gapDetected: true,
            measuredRpoSeconds: 1200
        },
        restoreDrill: {
            status: "BLOCKED",
            checksumVerified: false,
            reconciliationStatus: "BLOCKED",
            workersRemainedBlocked: false,
            measuredRestoreSeconds: 4000
        },
        portability: { exportTested: false },
        operations: { serviceLimitsReviewed: false },
        governance: { dataTransferReviewed: false }
    }));
    approveAll(evaluationService);
    const report = evaluationService.evaluate();
    const codes = new Set(report.alerts.map(entry => entry.code));
    assert.equal(report.status, "BLOCKED");
    for (const code of [
        "MANAGED_STAGING_POSTGRES_VERSION_UNSUPPORTED",
        "MANAGED_STAGING_ISOLATED_RESTORE_MISSING",
        "MANAGED_STAGING_TLS_MINIMUM_UNSAFE",
        "MANAGED_STAGING_PRIVATE_NETWORKING_MISSING",
        "MANAGED_STAGING_RESTORE_ROLE_NOT_SEPARATED",
        "MANAGED_STAGING_PITR_TEST_NOT_PASSED",
        "MANAGED_STAGING_PITR_GAP_DETECTED",
        "MANAGED_STAGING_RPO_TARGET_EXCEEDED",
        "MANAGED_STAGING_RESTORE_DRILL_INCOMPLETE",
        "MANAGED_STAGING_RTO_TARGET_EXCEEDED",
        "MANAGED_STAGING_EXPORT_NOT_TESTED",
        "MANAGED_STAGING_SERVICE_LIMITS_NOT_REVIEWED",
        "MANAGED_STAGING_DATA_TRANSFER_NOT_REVIEWED"
    ]) {
        assert.equal(codes.has(code), true, code);
    }
});

test("approval workflow is independent, expiring, single-use and tamper evident", t => {
    const directory = temporaryDirectory(t);
    const evaluationService = service(t, { directory });
    const recorded = evaluationService.recordAssessment(assessment()).assessment;
    evaluationService.requestApproval({
        assessmentId: recorded.assessmentId,
        requestId: "approval-independent-review",
        requestedBy: "requester-01",
        expiresAt: "2026-08-01T00:00:00.000Z",
        reason: "Independent review is required."
    });
    assert.throws(() => evaluationService.recordSignoff({
        requestId: "approval-independent-review",
        authority: "SECURITY",
        authorityReference: "requester-01",
        decisionId: "self-approval",
        decision: "APPROVE",
        reason: "Not independent."
    }), /cannot sign off/);
    evaluationService.recordSignoff({
        requestId: "approval-independent-review",
        authority: "SECURITY",
        authorityReference: "security-reviewer-01",
        decisionId: "security-rejection",
        decision: "REJECT",
        reason: "TLS evidence is incomplete."
    });
    assert.equal(evaluationService.evaluate().approval.status, "REJECTED");
    assert.throws(() => evaluationService.recordSignoff({
        requestId: "approval-independent-review",
        authority: "SECURITY",
        authorityReference: "security-reviewer-02",
        decisionId: "security-replay",
        decision: "APPROVE",
        reason: "Replay attempt."
    }), /already recorded/);

    const expiredView = new ManagedStagingEvaluationService({
        directory,
        clock: () => new Date("2026-08-02T00:00:00.000Z"),
        idGenerator: identifierGenerator("expired-view")
    }).evaluate();
    assert.equal(expiredView.approval.status, "EXPIRED");
    assert.equal(expiredView.status, "BLOCKED");

    const eventName = readdirSync(directory).find(name => (
        name.endsWith(".managed-staging-approval-event.json")
    ));
    const eventPath = join(directory, eventName);
    const tampered = JSON.parse(readFileSync(eventPath, "utf8"));
    tampered.reason = "Tampered approval evidence";
    writeFileSync(eventPath, JSON.stringify(tampered));
    const report = evaluationService.evaluate();
    assert.equal(report.status, "BLOCKED");
    assert.equal(
        report.alerts.some(entry => entry.code === "MANAGED_STAGING_APPROVAL_EVIDENCE_INVALID"),
        true
    );
});

test("managed staging evaluation command records a machine-readable BLOCKED result", t => {
    const catalogue = temporaryDirectory(t);
    const inputDirectory = temporaryDirectory(t);
    const input = writeManagedStagingAssessment(inputDirectory, assessment({
        assessmentId: "managed-staging-cli-blocked",
        security: { privateNetworking: false }
    }));
    const result = spawnSync(process.execPath, [
        join(process.cwd(), "scripts/managed-staging-evaluate.js"),
        "--assessment", input.path,
        "--directory", catalogue
    ], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "BLOCKED");
    assert.equal(report.productionReadiness, false);
    assert.equal(report.alerts.some(
        entry => entry.code === "MANAGED_STAGING_PRIVATE_NETWORKING_MISSING"
    ), true);
});
