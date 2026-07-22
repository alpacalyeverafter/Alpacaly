import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
    createManagedStagingAssessment,
    writeManagedStagingAssessment
} from "./managed-staging-assessment.js";
import {
    MANAGED_STAGING_APPROVAL_AUTHORITIES,
    ManagedStagingApprovalRegistry
} from "./managed-staging-approval-registry.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function positiveInteger(value, name) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive safe integer.`);
    }
    return parsed;
}

function safeEvidenceDirectory(directory) {
    if (!directory || !isAbsolute(directory)) {
        throw new Error("Managed staging evidence directory must be an absolute path.");
    }
    const resolved = resolve(directory);
    if ([resolve("/"), resolve(homedir())].includes(resolved)) {
        throw new Error("Managed staging evidence directory is too broad to use safely.");
    }
    const repositoryRelative = relative(REPOSITORY_ROOT, resolved);
    const insideRepository = repositoryRelative === ""
        || (!repositoryRelative.startsWith(`..${sep}`) && repositoryRelative !== "..");
    if (insideRepository) {
        throw new Error("Managed staging evidence must be stored outside the repository.");
    }
    return resolved;
}

function alert(alerts, code, message, severity = "CRITICAL") {
    alerts.push(Object.freeze({ code, severity, message }));
}

function requireControls(alerts, object, prefix, controls) {
    for (const [field, code, message] of controls) {
        if (!object[field]) {
            alert(alerts, `${prefix}_${code}`, message);
        }
    }
}

function postgresMajor(version) {
    return Number(/^(\d+)(?:\.|$)/.exec(version)?.[1]);
}

function measurementTotal(restoreDrill) {
    const values = [
        restoreDrill.measuredRestoreSeconds,
        restoreDrill.measuredReconciliationSeconds,
        restoreDrill.measuredSupervisedReleaseSeconds
    ];
    return values.every(Number.isSafeInteger) ? values.reduce((total, value) => total + value, 0) : null;
}

function restoreScore(restoreDrill) {
    const controls = [
        restoreDrill.status === "PASS",
        restoreDrill.checksumVerified,
        restoreDrill.reconciliationStatus === "PASS",
        restoreDrill.workersRemainedBlocked,
        restoreDrill.uncertainCommandsRemainedBlocked,
        restoreDrill.emergencyStopsPreserved
    ];
    return Math.round(controls.filter(Boolean).length / controls.length * 100);
}

export class ManagedStagingEvaluationService {
    constructor({
        directory,
        approvalDirectory = directory,
        maximumAssessmentAgeDays = 30,
        requiredAuthorities = MANAGED_STAGING_APPROVAL_AUTHORITIES,
        clock = () => new Date(),
        idGenerator = randomUUID
    } = {}) {
        this.directory = safeEvidenceDirectory(directory);
        this.approvalDirectory = safeEvidenceDirectory(approvalDirectory);
        this.maximumAssessmentAgeDays = positiveInteger(
            maximumAssessmentAgeDays,
            "maximumAssessmentAgeDays"
        );
        this.requiredAuthorities = [...requiredAuthorities].map(entry => String(entry).toUpperCase());
        if (
            this.requiredAuthorities.length === 0
            || this.requiredAuthorities.some(
                entry => !MANAGED_STAGING_APPROVAL_AUTHORITIES.includes(entry)
            )
            || new Set(this.requiredAuthorities).size !== this.requiredAuthorities.length
        ) {
            throw new Error("Managed staging required authorities are invalid.");
        }
        this.clock = clock;
        this.idGenerator = idGenerator;
        this.approvals = new ManagedStagingApprovalRegistry({
            directory: this.approvalDirectory,
            clock,
            idGenerator
        });
    }

    listAssessments() {
        let names;
        try {
            names = readdirSync(this.directory);
        } catch (error) {
            if (error.code === "ENOENT") {
                return [];
            }
            throw new Error("Managed staging evidence catalogue cannot be read.");
        }
        return names
            .filter(name => name.endsWith(".managed-staging-assessment.json"))
            .map(name => {
                try {
                    return createManagedStagingAssessment(JSON.parse(
                        readFileSync(resolve(this.directory, name), "utf8")
                    ));
                } catch (error) {
                    const catalogueError = new Error(
                        `Managed staging evidence catalogue is invalid: ${error.message}`
                    );
                    catalogueError.code = "MANAGED_STAGING_EVIDENCE_CATALOGUE_INVALID";
                    throw catalogueError;
                }
            })
            .sort((left, right) => Date.parse(right.collectedAt) - Date.parse(left.collectedAt));
    }

    assessment(assessmentId) {
        return this.listAssessments().find(entry => entry.assessmentId === assessmentId) || null;
    }

    recordAssessment(input) {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        return writeManagedStagingAssessment(this.directory, input);
    }

    requestApproval({ assessmentId, requestId, requestedBy, expiresAt, reason }) {
        const assessment = this.assessment(assessmentId);
        if (!assessment) {
            throw new Error("Managed staging assessment does not exist.");
        }
        return this.approvals.request({
            requestId,
            assessmentId: assessment.assessmentId,
            assessmentDigest: assessment.assessmentDigest,
            requestedBy,
            requiredAuthorities: this.requiredAuthorities,
            expiresAt,
            reason
        });
    }

    recordSignoff(input) {
        return this.approvals.decide(input);
    }

    evaluate(input = undefined) {
        const now = this.clock();
        let candidate = input;
        if (candidate === undefined) {
            try {
                candidate = this.listAssessments()[0] || null;
            } catch {
                return this.#report({
                    assessment: null,
                    alerts: [Object.freeze({
                        code: "MANAGED_STAGING_EVIDENCE_CATALOGUE_INVALID",
                        severity: "CRITICAL",
                        message: "Managed staging evidence is unreadable, invalid, or incomplete."
                    })],
                    now,
                    approval: null
                });
            }
        }
        const assessment = candidate ? createManagedStagingAssessment(candidate) : null;
        const alerts = [];
        if (!assessment) {
            alert(
                alerts,
                "MANAGED_STAGING_ASSESSMENT_MISSING",
                "No provider-neutral managed staging assessment has been recorded."
            );
            return this.#report({ assessment: null, alerts, now, approval: null });
        }

        const collectedAt = Date.parse(assessment.collectedAt);
        if (collectedAt > now.getTime() + 5 * 60 * 1000) {
            alert(
                alerts,
                "MANAGED_STAGING_ASSESSMENT_FROM_FUTURE",
                "The managed staging assessment has an invalid future collection time."
            );
        }
        if (now.getTime() - collectedAt > this.maximumAssessmentAgeDays * DAY_MS) {
            alert(
                alerts,
                "MANAGED_STAGING_ASSESSMENT_STALE",
                "The managed staging assessment is older than the configured review window."
            );
        }
        const postgresVersion = postgresMajor(assessment.candidate.postgresVersion);
        if (!Number.isSafeInteger(postgresVersion) || postgresVersion < 16) {
            alert(
                alerts,
                "MANAGED_STAGING_POSTGRES_VERSION_UNSUPPORTED",
                "The candidate does not provide PostgreSQL 16 or newer."
            );
        }

        requireControls(alerts, assessment.capabilities, "MANAGED_STAGING", [
            ["managedPostgres", "MANAGED_POSTGRES_MISSING", "Managed PostgreSQL is not evidenced."],
            ["encryptedStorage", "ENCRYPTED_STORAGE_MISSING", "Encrypted storage is not evidenced."],
            ["encryptedBackups", "ENCRYPTED_BACKUPS_MISSING", "Encrypted backups are not evidenced."],
            ["pitrAvailable", "PITR_CAPABILITY_MISSING", "PITR capability is not evidenced."],
            ["isolatedRestoreAvailable", "ISOLATED_RESTORE_MISSING", "Isolated restore capability is not evidenced."],
            ["nativeExportAvailable", "NATIVE_EXPORT_MISSING", "Native PostgreSQL export is not evidenced."],
            ["monitoringAvailable", "MONITORING_CAPABILITY_MISSING", "Operational monitoring is not evidenced."]
        ]);

        if (!["TLS_1_2", "TLS_1_3"].includes(assessment.security.tlsMinimum)) {
            alert(
                alerts,
                "MANAGED_STAGING_TLS_MINIMUM_UNSAFE",
                "TLS 1.2 or newer is not evidenced."
            );
        }
        requireControls(alerts, assessment.security, "MANAGED_STAGING", [
            ["hostnameVerification", "TLS_HOSTNAME_VERIFICATION_MISSING", "TLS hostname verification is not evidenced."],
            ["privateNetworking", "PRIVATE_NETWORKING_MISSING", "Private network isolation is not evidenced."],
            ["publicAccessDisabled", "PUBLIC_ACCESS_NOT_DISABLED", "Public database access is not disabled."],
            ["secretManagerIntegration", "SECRET_MANAGER_MISSING", "A managed secret boundary is not evidenced."],
            ["credentialRotation", "CREDENTIAL_ROTATION_MISSING", "Credential rotation is not evidenced."],
            ["humanMfaRequired", "HUMAN_MFA_MISSING", "Human MFA is not evidenced."],
            ["administrativeAuditLogging", "ADMIN_AUDIT_LOGGING_MISSING", "Administrative audit logging is not evidenced."]
        ]);
        requireControls(alerts, assessment.roles, "MANAGED_STAGING", [
            ["applicationRoleSeparated", "APPLICATION_ROLE_NOT_SEPARATED", "Application duty separation is not evidenced."],
            ["migrationRoleSeparated", "MIGRATION_ROLE_NOT_SEPARATED", "Migration duty separation is not evidenced."],
            ["backupRoleSeparated", "BACKUP_ROLE_NOT_SEPARATED", "Backup duty separation is not evidenced."],
            ["restoreRoleSeparated", "RESTORE_ROLE_NOT_SEPARATED", "Restore duty separation is not evidenced."],
            ["monitoringRoleSeparated", "MONITORING_ROLE_NOT_SEPARATED", "Monitoring duty separation is not evidenced."],
            ["breakGlassControlled", "BREAK_GLASS_NOT_CONTROLLED", "Break-glass access control is not evidenced."]
        ]);

        if (!assessment.pitr.transactionBoundaryDefined) {
            alert(alerts, "MANAGED_STAGING_PITR_BOUNDARY_MISSING", "The PITR transaction boundary is not defined.");
        }
        if (!assessment.pitr.walContinuityCheckPlanned) {
            alert(alerts, "MANAGED_STAGING_WAL_CHECK_MISSING", "The PITR plan omits WAL continuity verification.");
        }
        if (assessment.pitr.testStatus !== "PASS" || !assessment.pitr.evidenceReference) {
            alert(alerts, "MANAGED_STAGING_PITR_TEST_NOT_PASSED", "A successful PITR test with safe evidence is not recorded.");
        }
        if (assessment.pitr.gapDetected) {
            alert(alerts, "MANAGED_STAGING_PITR_GAP_DETECTED", "The PITR evidence reports a WAL or recovery gap.");
        }
        if (!Number.isSafeInteger(assessment.pitr.measuredRpoSeconds)) {
            alert(alerts, "MANAGED_STAGING_RPO_MEASUREMENT_MISSING", "Measured RPO evidence is missing.");
        } else if (assessment.pitr.measuredRpoSeconds > assessment.pitr.targetRpoSeconds) {
            alert(alerts, "MANAGED_STAGING_RPO_TARGET_EXCEEDED", "The measured RPO exceeds the proposed evaluation target.");
        }

        const drillScore = restoreScore(assessment.restoreDrill);
        const measuredRtoSeconds = measurementTotal(assessment.restoreDrill);
        if (!assessment.restoreDrill.reportReference || drillScore !== 100) {
            alert(alerts, "MANAGED_STAGING_RESTORE_DRILL_INCOMPLETE", "The isolated restore drill did not satisfy every safety scoring control.");
        }
        if (measuredRtoSeconds === null) {
            alert(alerts, "MANAGED_STAGING_RTO_MEASUREMENT_MISSING", "Complete restore, reconciliation, and supervised-release measurements are missing.");
        } else if (measuredRtoSeconds > assessment.restoreDrill.targetRtoSeconds) {
            alert(alerts, "MANAGED_STAGING_RTO_TARGET_EXCEEDED", "The measured end-to-end RTO exceeds the proposed evaluation target.");
        }

        requireControls(alerts, assessment.portability, "MANAGED_STAGING", [
            ["nativeDumpRestore", "NATIVE_DUMP_RESTORE_MISSING", "Native PostgreSQL dump and restore portability is not evidenced."],
            ["exportTested", "EXPORT_NOT_TESTED", "A provider exit export has not been tested."],
            ["extensionInventoryComplete", "EXTENSION_INVENTORY_INCOMPLETE", "The PostgreSQL extension inventory is incomplete."]
        ]);
        if (assessment.portability.proprietaryDependencies.length > 0) {
            alert(
                alerts,
                "MANAGED_STAGING_PROPRIETARY_DEPENDENCIES",
                "The assessment records provider-specific dependencies requiring review.",
                "WARNING"
            );
        }
        if (assessment.portability.lockInRisk !== "LOW") {
            alert(
                alerts,
                "MANAGED_STAGING_LOCK_IN_RISK",
                "Portability evidence records non-low provider lock-in risk.",
                "WARNING"
            );
        }

        requireControls(alerts, assessment.operations, "MANAGED_STAGING", [
            ["serviceLimitsReviewed", "SERVICE_LIMITS_NOT_REVIEWED", "Provider service limits have not been reviewed."],
            ["incidentHistoryReviewed", "INCIDENT_HISTORY_NOT_REVIEWED", "Provider incident history has not been reviewed."],
            ["monitoringPlanReviewed", "MONITORING_PLAN_NOT_REVIEWED", "Monitoring and alert routing have not been reviewed."]
        ]);
        if (assessment.operations.supportResponseMinutes * 60
            > assessment.restoreDrill.targetRtoSeconds) {
            alert(
                alerts,
                "MANAGED_STAGING_SUPPORT_RESPONSE_SLOWER_THAN_RTO",
                "The evidenced support response is slower than the proposed RTO.",
                "WARNING"
            );
        }
        requireControls(alerts, assessment.governance, "MANAGED_STAGING", [
            ["ukRegionAvailable", "UK_REGION_NOT_EVIDENCED", "A reviewed UK staging region is not evidenced."],
            ["dataTransferReviewed", "DATA_TRANSFER_NOT_REVIEWED", "Regional data transfer has not been reviewed."]
        ]);

        let approval;
        try {
            approval = this.approvals.statusForAssessment(
                assessment.assessmentId,
                assessment.assessmentDigest
            );
        } catch {
            approval = { status: "INVALID", approved: [], missing: this.requiredAuthorities };
        }
        const approvalCodes = {
            MISSING: "MANAGED_STAGING_APPROVAL_MISSING",
            PENDING: "MANAGED_STAGING_APPROVAL_PENDING",
            EXPIRED: "MANAGED_STAGING_APPROVAL_EXPIRED",
            REJECTED: "MANAGED_STAGING_APPROVAL_REJECTED",
            DIGEST_MISMATCH: "MANAGED_STAGING_APPROVAL_DIGEST_MISMATCH",
            INVALID: "MANAGED_STAGING_APPROVAL_EVIDENCE_INVALID"
        };
        if (approval.status !== "APPROVED") {
            alert(
                alerts,
                approvalCodes[approval.status] || "MANAGED_STAGING_APPROVAL_INCOMPLETE",
                "The managed staging evaluation does not have complete, current, independent sign-off."
            );
        }
        return this.#report({ assessment, alerts, now, approval, drillScore, measuredRtoSeconds });
    }

    recordEvaluation(input = undefined) {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        let assessment = input;
        if (input !== undefined) {
            assessment = createManagedStagingAssessment(input);
            const persisted = this.assessment(assessment.assessmentId);
            if (!persisted || persisted.assessmentDigest !== assessment.assessmentDigest) {
                throw new Error(
                    "Managed staging evaluation requires the matching append-only assessment record."
                );
            }
        }
        const report = this.evaluate(assessment);
        const evaluationId = `managed-staging-evaluation-${this.idGenerator()}`;
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(evaluationId)) {
            throw new Error("Managed staging evaluation identity is unsafe.");
        }
        const record = { evaluationVersion: 1, evaluationId, ...report };
        const path = resolve(this.directory, `${evaluationId}.managed-staging-evaluation.json`);
        writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600
        });
        return { record, path };
    }

    #report({ assessment, alerts, now, approval, drillScore = null,
        measuredRtoSeconds = null }) {
        const status = alerts.some(entry => entry.severity === "CRITICAL")
            ? "BLOCKED"
            : alerts.length > 0 ? "WARNING" : "PASS";
        return Object.freeze({
            status,
            scope: "MANAGED_STAGING_EVALUATION_ONLY",
            productionReadiness: false,
            productionUseAuthorized: false,
            externalConnectionsAuthorized: false,
            checkedAt: now.toISOString(),
            assessment: assessment ? {
                assessmentId: assessment.assessmentId,
                assessmentDigest: assessment.assessmentDigest,
                collectedAt: assessment.collectedAt,
                providerLabel: assessment.candidate.providerLabel,
                serviceLabel: assessment.candidate.serviceLabel,
                region: assessment.candidate.region,
                postgresVersion: assessment.candidate.postgresVersion,
                measuredRpoSeconds: assessment.pitr.measuredRpoSeconds,
                targetRpoSeconds: assessment.pitr.targetRpoSeconds,
                measuredRtoSeconds,
                targetRtoSeconds: assessment.restoreDrill.targetRtoSeconds,
                restoreDrillScore: drillScore,
                lockInRisk: assessment.portability.lockInRisk,
                proprietaryDependencyCount: assessment.portability.proprietaryDependencies.length,
                monthlyEstimateMinor: assessment.operations.monthlyEstimateMinor,
                currency: assessment.operations.currency,
                supportLevel: assessment.operations.supportLevel,
                supportResponseMinutes: assessment.operations.supportResponseMinutes
            } : null,
            approval: approval ? {
                status: approval.status,
                requestId: approval.requestId || null,
                required: approval.required || this.requiredAuthorities,
                approved: approval.approved || [],
                missing: approval.missing || this.requiredAuthorities
            } : null,
            alerts
        });
    }
}
