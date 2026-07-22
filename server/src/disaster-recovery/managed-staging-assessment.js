import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export const MANAGED_STAGING_ASSESSMENT_VERSION = 1;

const SECRET_KEY_PATTERN = /(?:password|secret|token|credential|private.?key|connection.?string|database.?url|access.?key)/i;
const SAFE_CONTROL_FIELDS = new Set(["secretManagerIntegration", "credentialRotation"]);
const COLLECTION_SOURCES = Object.freeze([
    "DOCUMENT_REVIEW",
    "CONTROL_PLANE_EXPORT",
    "RESTORE_DRILL",
    "COMBINED"
]);

function fail(message, code = "MANAGED_STAGING_ASSESSMENT_INVALID") {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function object(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(`${name} must be an object.`);
    }
    return value;
}

function text(value, name, { maximumLength = 240 } = {}) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        fail(`${name} is required.`);
    }
    if (normalized.length > maximumLength) {
        fail(`${name} must not exceed ${maximumLength} characters.`);
    }
    return normalized;
}

function identifier(value, name) {
    const normalized = text(value, name, { maximumLength: 200 });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) {
        fail(`${name} contains unsupported characters.`);
    }
    return normalized;
}

function safeReference(value, name, { nullable = false } = {}) {
    if ((value === null || value === undefined || value === "") && nullable) {
        return null;
    }
    const normalized = text(value, name, { maximumLength: 240 });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(normalized)) {
        fail(`${name} contains unsupported characters.`);
    }
    return normalized;
}

function timestamp(value, name) {
    const normalized = text(value, name);
    if (Number.isNaN(Date.parse(normalized))) {
        fail(`${name} must be an ISO-compatible timestamp.`);
    }
    return normalized;
}

function boolean(value, name) {
    if (typeof value !== "boolean") {
        fail(`${name} must be a boolean.`);
    }
    return value;
}

function integer(value, name, { minimum = 0, nullable = false } = {}) {
    if ((value === null || value === undefined) && nullable) {
        return null;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        fail(`${name} must be a safe integer of at least ${minimum}.`);
    }
    return parsed;
}

function choice(value, name, choices) {
    const normalized = text(value, name).toUpperCase();
    if (!choices.includes(normalized)) {
        fail(`${name} must be one of: ${choices.join(", ")}.`);
    }
    return normalized;
}

function allowedKeys(value, allowed, name) {
    const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
    if (unexpected.length > 0) {
        fail(`${name} contains unsupported fields: ${unexpected.join(", ")}.`);
    }
}

function rejectSecretShapedFields(value, path = "assessment") {
    if (!value || typeof value !== "object") {
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        if (!SAFE_CONTROL_FIELDS.has(key) && SECRET_KEY_PATTERN.test(key)) {
            fail(
                `${path}.${key} is not permitted in managed staging evidence.`,
                "MANAGED_STAGING_ASSESSMENT_SECRET_FIELD"
            );
        }
        rejectSecretShapedFields(child, `${path}.${key}`);
    }
}

function safeReferenceList(value, name) {
    if (!Array.isArray(value) || value.length > 20) {
        fail(`${name} must be an array containing no more than 20 entries.`);
    }
    return value.map((entry, index) => safeReference(entry, `${name}[${index}]`));
}

function payload(input) {
    const candidate = object(input.candidate, "candidate");
    const capabilities = object(input.capabilities, "capabilities");
    const security = object(input.security, "security");
    const roles = object(input.roles, "roles");
    const pitr = object(input.pitr, "pitr");
    const restoreDrill = object(input.restoreDrill, "restoreDrill");
    const portability = object(input.portability, "portability");
    const operations = object(input.operations, "operations");
    const governance = object(input.governance, "governance");
    const collection = object(input.collection, "collection");

    allowedKeys(input, [
        "assessmentVersion", "assessmentId", "assessmentDigest", "collectedAt",
        "environment", "candidate", "capabilities", "security", "roles", "pitr",
        "restoreDrill", "portability", "operations", "governance", "collection"
    ], "assessment");
    allowedKeys(candidate, [
        "providerLabel", "serviceLabel", "region", "postgresVersion"
    ], "candidate");
    allowedKeys(capabilities, [
        "managedPostgres", "encryptedStorage", "encryptedBackups", "pitrAvailable",
        "isolatedRestoreAvailable", "nativeExportAvailable", "monitoringAvailable"
    ], "capabilities");
    allowedKeys(security, [
        "tlsMinimum", "hostnameVerification", "privateNetworking",
        "publicAccessDisabled", "secretManagerIntegration", "credentialRotation",
        "humanMfaRequired", "administrativeAuditLogging"
    ], "security");
    allowedKeys(roles, [
        "applicationRoleSeparated", "migrationRoleSeparated", "backupRoleSeparated",
        "restoreRoleSeparated", "monitoringRoleSeparated", "breakGlassControlled",
        "evidenceReference"
    ], "roles");
    allowedKeys(pitr, [
        "planReference", "transactionBoundaryDefined", "walContinuityCheckPlanned",
        "testStatus", "evidenceReference", "gapDetected", "measuredRpoSeconds",
        "targetRpoSeconds"
    ], "pitr");
    allowedKeys(restoreDrill, [
        "reportReference", "status", "checksumVerified", "reconciliationStatus",
        "workersRemainedBlocked", "uncertainCommandsRemainedBlocked",
        "emergencyStopsPreserved", "measuredRestoreSeconds",
        "measuredReconciliationSeconds", "measuredSupervisedReleaseSeconds",
        "targetRtoSeconds"
    ], "restoreDrill");
    allowedKeys(portability, [
        "nativeDumpRestore", "exportTested", "extensionInventoryComplete",
        "proprietaryDependencies", "exitPlanReference", "lockInRisk"
    ], "portability");
    allowedKeys(operations, [
        "costEvidenceReference", "currency", "monthlyEstimateMinor",
        "supportEvidenceReference", "supportLevel", "supportResponseMinutes",
        "serviceLimitsReviewed", "incidentHistoryReviewed", "monitoringPlanReviewed"
    ], "operations");
    allowedKeys(governance, [
        "ukRegionAvailable", "dataTransferReviewed", "privacyAssessmentReference",
        "welfareReviewReference"
    ], "governance");
    allowedKeys(collection, ["source", "collectorVersion"], "collection");

    const environment = text(input.environment, "environment").toLowerCase();
    if (environment !== "staging") {
        fail("Managed staging assessment environment must be staging.");
    }

    return {
        assessmentVersion: MANAGED_STAGING_ASSESSMENT_VERSION,
        assessmentId: identifier(input.assessmentId, "assessmentId"),
        collectedAt: timestamp(input.collectedAt, "collectedAt"),
        environment,
        candidate: {
            providerLabel: text(candidate.providerLabel, "candidate.providerLabel"),
            serviceLabel: text(candidate.serviceLabel, "candidate.serviceLabel"),
            region: text(candidate.region, "candidate.region"),
            postgresVersion: text(candidate.postgresVersion, "candidate.postgresVersion")
        },
        capabilities: Object.fromEntries([
            "managedPostgres",
            "encryptedStorage",
            "encryptedBackups",
            "pitrAvailable",
            "isolatedRestoreAvailable",
            "nativeExportAvailable",
            "monitoringAvailable"
        ].map(key => [key, boolean(capabilities[key], `capabilities.${key}`)])),
        security: {
            tlsMinimum: choice(security.tlsMinimum, "security.tlsMinimum", [
                "TLS_1_2", "TLS_1_3", "BELOW_TLS_1_2", "UNKNOWN"
            ]),
            hostnameVerification: boolean(
                security.hostnameVerification,
                "security.hostnameVerification"
            ),
            privateNetworking: boolean(security.privateNetworking, "security.privateNetworking"),
            publicAccessDisabled: boolean(
                security.publicAccessDisabled,
                "security.publicAccessDisabled"
            ),
            secretManagerIntegration: boolean(
                security.secretManagerIntegration,
                "security.secretManagerIntegration"
            ),
            credentialRotation: boolean(
                security.credentialRotation,
                "security.credentialRotation"
            ),
            humanMfaRequired: boolean(security.humanMfaRequired, "security.humanMfaRequired"),
            administrativeAuditLogging: boolean(
                security.administrativeAuditLogging,
                "security.administrativeAuditLogging"
            )
        },
        roles: {
            applicationRoleSeparated: boolean(
                roles.applicationRoleSeparated,
                "roles.applicationRoleSeparated"
            ),
            migrationRoleSeparated: boolean(
                roles.migrationRoleSeparated,
                "roles.migrationRoleSeparated"
            ),
            backupRoleSeparated: boolean(roles.backupRoleSeparated, "roles.backupRoleSeparated"),
            restoreRoleSeparated: boolean(
                roles.restoreRoleSeparated,
                "roles.restoreRoleSeparated"
            ),
            monitoringRoleSeparated: boolean(
                roles.monitoringRoleSeparated,
                "roles.monitoringRoleSeparated"
            ),
            breakGlassControlled: boolean(roles.breakGlassControlled, "roles.breakGlassControlled"),
            evidenceReference: safeReference(roles.evidenceReference, "roles.evidenceReference")
        },
        pitr: {
            planReference: safeReference(pitr.planReference, "pitr.planReference"),
            transactionBoundaryDefined: boolean(
                pitr.transactionBoundaryDefined,
                "pitr.transactionBoundaryDefined"
            ),
            walContinuityCheckPlanned: boolean(
                pitr.walContinuityCheckPlanned,
                "pitr.walContinuityCheckPlanned"
            ),
            testStatus: choice(pitr.testStatus, "pitr.testStatus", [
                "NOT_RUN", "PASS", "FAILED"
            ]),
            evidenceReference: safeReference(
                pitr.evidenceReference,
                "pitr.evidenceReference",
                { nullable: true }
            ),
            gapDetected: boolean(pitr.gapDetected, "pitr.gapDetected"),
            measuredRpoSeconds: integer(
                pitr.measuredRpoSeconds,
                "pitr.measuredRpoSeconds",
                { nullable: true }
            ),
            targetRpoSeconds: integer(pitr.targetRpoSeconds, "pitr.targetRpoSeconds", {
                minimum: 1
            })
        },
        restoreDrill: {
            reportReference: safeReference(
                restoreDrill.reportReference,
                "restoreDrill.reportReference",
                { nullable: true }
            ),
            status: choice(restoreDrill.status, "restoreDrill.status", [
                "NOT_RUN", "PASS", "WARNING", "BLOCKED"
            ]),
            checksumVerified: boolean(
                restoreDrill.checksumVerified,
                "restoreDrill.checksumVerified"
            ),
            reconciliationStatus: choice(
                restoreDrill.reconciliationStatus,
                "restoreDrill.reconciliationStatus",
                ["NOT_RUN", "PASS", "BLOCKED"]
            ),
            workersRemainedBlocked: boolean(
                restoreDrill.workersRemainedBlocked,
                "restoreDrill.workersRemainedBlocked"
            ),
            uncertainCommandsRemainedBlocked: boolean(
                restoreDrill.uncertainCommandsRemainedBlocked,
                "restoreDrill.uncertainCommandsRemainedBlocked"
            ),
            emergencyStopsPreserved: boolean(
                restoreDrill.emergencyStopsPreserved,
                "restoreDrill.emergencyStopsPreserved"
            ),
            measuredRestoreSeconds: integer(
                restoreDrill.measuredRestoreSeconds,
                "restoreDrill.measuredRestoreSeconds",
                { nullable: true }
            ),
            measuredReconciliationSeconds: integer(
                restoreDrill.measuredReconciliationSeconds,
                "restoreDrill.measuredReconciliationSeconds",
                { nullable: true }
            ),
            measuredSupervisedReleaseSeconds: integer(
                restoreDrill.measuredSupervisedReleaseSeconds,
                "restoreDrill.measuredSupervisedReleaseSeconds",
                { nullable: true }
            ),
            targetRtoSeconds: integer(
                restoreDrill.targetRtoSeconds,
                "restoreDrill.targetRtoSeconds",
                { minimum: 1 }
            )
        },
        portability: {
            nativeDumpRestore: boolean(
                portability.nativeDumpRestore,
                "portability.nativeDumpRestore"
            ),
            exportTested: boolean(portability.exportTested, "portability.exportTested"),
            extensionInventoryComplete: boolean(
                portability.extensionInventoryComplete,
                "portability.extensionInventoryComplete"
            ),
            proprietaryDependencies: safeReferenceList(
                portability.proprietaryDependencies,
                "portability.proprietaryDependencies"
            ),
            exitPlanReference: safeReference(
                portability.exitPlanReference,
                "portability.exitPlanReference"
            ),
            lockInRisk: choice(portability.lockInRisk, "portability.lockInRisk", [
                "LOW", "MEDIUM", "HIGH"
            ])
        },
        operations: {
            costEvidenceReference: safeReference(
                operations.costEvidenceReference,
                "operations.costEvidenceReference"
            ),
            currency: choice(operations.currency, "operations.currency", ["GBP", "EUR", "USD"]),
            monthlyEstimateMinor: integer(
                operations.monthlyEstimateMinor,
                "operations.monthlyEstimateMinor"
            ),
            supportEvidenceReference: safeReference(
                operations.supportEvidenceReference,
                "operations.supportEvidenceReference"
            ),
            supportLevel: text(operations.supportLevel, "operations.supportLevel"),
            supportResponseMinutes: integer(
                operations.supportResponseMinutes,
                "operations.supportResponseMinutes",
                { minimum: 1 }
            ),
            serviceLimitsReviewed: boolean(
                operations.serviceLimitsReviewed,
                "operations.serviceLimitsReviewed"
            ),
            incidentHistoryReviewed: boolean(
                operations.incidentHistoryReviewed,
                "operations.incidentHistoryReviewed"
            ),
            monitoringPlanReviewed: boolean(
                operations.monitoringPlanReviewed,
                "operations.monitoringPlanReviewed"
            )
        },
        governance: {
            ukRegionAvailable: boolean(governance.ukRegionAvailable, "governance.ukRegionAvailable"),
            dataTransferReviewed: boolean(
                governance.dataTransferReviewed,
                "governance.dataTransferReviewed"
            ),
            privacyAssessmentReference: safeReference(
                governance.privacyAssessmentReference,
                "governance.privacyAssessmentReference"
            ),
            welfareReviewReference: safeReference(
                governance.welfareReviewReference,
                "governance.welfareReviewReference"
            )
        },
        collection: {
            source: choice(collection.source, "collection.source", COLLECTION_SOURCES),
            collectorVersion: text(collection.collectorVersion, "collection.collectorVersion")
        }
    };
}

export function managedStagingAssessmentDigest(assessment) {
    if (Number(assessment?.assessmentVersion) !== MANAGED_STAGING_ASSESSMENT_VERSION) {
        fail(`Managed staging assessment version ${assessment?.assessmentVersion ?? "unknown"} is not supported.`);
    }
    return createHash("sha256").update(JSON.stringify(payload(assessment))).digest("hex");
}

export function createManagedStagingAssessment(input) {
    object(input, "assessment");
    rejectSecretShapedFields(input);
    if (Number(input.assessmentVersion) !== MANAGED_STAGING_ASSESSMENT_VERSION) {
        fail(`Managed staging assessment version ${input.assessmentVersion ?? "unknown"} is not supported.`);
    }
    const normalized = payload(input);
    const assessmentDigest = managedStagingAssessmentDigest(normalized);
    if (input.assessmentDigest && input.assessmentDigest !== assessmentDigest) {
        fail(
            "Managed staging assessment digest does not match its safe payload.",
            "MANAGED_STAGING_ASSESSMENT_DIGEST_MISMATCH"
        );
    }
    return Object.freeze({ ...normalized, assessmentDigest });
}

export function readManagedStagingAssessment(path) {
    try {
        return createManagedStagingAssessment(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
        if (error.code) {
            throw error;
        }
        fail(`Managed staging assessment could not be read: ${error.message}`);
    }
}

export function writeManagedStagingAssessment(directory, assessment) {
    const validated = createManagedStagingAssessment(assessment);
    const safeName = basename(validated.assessmentId).replaceAll(/[^a-zA-Z0-9._-]/g, "-");
    if (!safeName || safeName !== validated.assessmentId) {
        fail("assessmentId must be safe for use as an evidence filename.");
    }
    const path = resolve(directory, `${safeName}.managed-staging-assessment.json`);
    writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
    });
    return { assessment: validated, path };
}
