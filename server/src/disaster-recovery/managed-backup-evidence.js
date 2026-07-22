import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export const MANAGED_BACKUP_EVIDENCE_VERSION = 1;

const BACKUP_STATUSES = Object.freeze(["AVAILABLE", "CREATING", "FAILED"]);
const ENCRYPTION_KEY_MANAGEMENT = Object.freeze([
    "PROVIDER_MANAGED",
    "CUSTOMER_MANAGED"
]);
const COLLECTION_SOURCES = Object.freeze(["PROVIDER_API", "PROVIDER_EXPORT"]);
const SECRET_KEY_PATTERN = /(?:password|secret|token|credential|private.?key|connection.?string|database.?url)/i;

function fail(message, code = "MANAGED_BACKUP_EVIDENCE_INVALID") {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function requireObject(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(`${name} must be an object.`);
    }
    return value;
}

function requireText(value, name, { maximumLength = 200 } = {}) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        fail(`${name} is required.`);
    }
    if (normalized.length > maximumLength) {
        fail(`${name} must not exceed ${maximumLength} characters.`);
    }
    return normalized;
}

function optionalText(value, name, options) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    return requireText(value, name, options);
}

function optionalSafeReference(value, name) {
    const normalized = optionalText(value, name);
    if (normalized && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(normalized)) {
        fail(`${name} contains unsupported characters.`);
    }
    return normalized;
}

function requireSafeIdentifier(value, name) {
    const normalized = requireText(value, name);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) {
        fail(`${name} contains unsupported characters.`);
    }
    return normalized;
}

function requireTimestamp(value, name, { nullable = false } = {}) {
    if ((value === null || value === undefined) && nullable) {
        return null;
    }
    const normalized = requireText(value, name);
    if (Number.isNaN(Date.parse(normalized))) {
        fail(`${name} must be an ISO-compatible timestamp.`);
    }
    return normalized;
}

function requireBoolean(value, name) {
    if (typeof value !== "boolean") {
        fail(`${name} must be a boolean.`);
    }
    return value;
}

function requireInteger(value, name, { minimum = 0 } = {}) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        fail(`${name} must be a safe integer of at least ${minimum}.`);
    }
    return parsed;
}

function requireChoice(value, name, choices) {
    const normalized = requireText(value, name).toUpperCase();
    if (!choices.includes(normalized)) {
        fail(`${name} must be one of: ${choices.join(", ")}.`);
    }
    return normalized;
}

function requireEnvironment(value) {
    const environment = requireText(value, "environment").toLowerCase();
    if (!["staging", "production"].includes(environment)) {
        fail("environment must be staging or production.");
    }
    return environment;
}

function requireSafeIdentity(value, name) {
    const normalized = requireText(value, name);
    if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
        fail(`${name} must be a sanitized SHA-256 identity.`);
    }
    return normalized;
}

function assertNoSecretShapedFields(value, path = "evidence") {
    if (!value || typeof value !== "object") {
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        if (SECRET_KEY_PATTERN.test(key)) {
            fail(
                `${path}.${key} is not permitted in managed backup evidence.`,
                "MANAGED_BACKUP_EVIDENCE_SECRET_FIELD"
            );
        }
        assertNoSecretShapedFields(child, `${path}.${key}`);
    }
}

function assertAllowedKeys(value, allowed, name) {
    const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
    if (unexpected.length > 0) {
        fail(`${name} contains unsupported fields: ${unexpected.join(", ")}.`);
    }
}

function evidencePayload(input) {
    const provider = requireObject(input.provider, "provider");
    const database = requireObject(input.database, "database");
    const backup = requireObject(input.backup, "backup");
    const pitr = requireObject(input.pitr, "pitr");
    const access = requireObject(input.access, "access");
    const collection = requireObject(input.collection, "collection");
    assertAllowedKeys(input, [
        "evidenceVersion",
        "evidenceId",
        "evidenceDigest",
        "collectedAt",
        "environment",
        "provider",
        "database",
        "backup",
        "pitr",
        "access",
        "collection"
    ], "evidence");
    assertAllowedKeys(provider, [
        "name", "service", "region", "backupReference"
    ], "provider");
    assertAllowedKeys(database, ["identity", "postgresVersion"], "database");
    assertAllowedKeys(backup, [
        "status",
        "latestSuccessfulAt",
        "encrypted",
        "encryptionKeyManagement",
        "restorable",
        "retentionDays"
    ], "backup");
    assertAllowedKeys(pitr, [
        "enabled",
        "continuous",
        "earliestRecoveryAt",
        "latestRecoveryAt",
        "latestWalAt",
        "gapDetected"
    ], "pitr");
    assertAllowedKeys(access, [
        "applicationRoleSeparated",
        "backupRoleSeparated",
        "restoreRoleSeparated",
        "humanMfaRequired",
        "administrativeAuditLogging"
    ], "access");
    assertAllowedKeys(collection, ["source", "exporterVersion"], "collection");
    const latestSuccessfulAt = requireTimestamp(
        backup.latestSuccessfulAt,
        "backup.latestSuccessfulAt",
        { nullable: true }
    );
    const earliestRecoveryAt = requireTimestamp(
        pitr.earliestRecoveryAt,
        "pitr.earliestRecoveryAt",
        { nullable: true }
    );
    const latestRecoveryAt = requireTimestamp(
        pitr.latestRecoveryAt,
        "pitr.latestRecoveryAt",
        { nullable: true }
    );
    const latestWalAt = requireTimestamp(
        pitr.latestWalAt,
        "pitr.latestWalAt",
        { nullable: true }
    );

    return {
        evidenceVersion: MANAGED_BACKUP_EVIDENCE_VERSION,
        evidenceId: requireSafeIdentifier(input.evidenceId, "evidenceId"),
        collectedAt: requireTimestamp(input.collectedAt, "collectedAt"),
        environment: requireEnvironment(input.environment),
        provider: {
            name: requireText(provider.name, "provider.name"),
            service: requireText(provider.service, "provider.service"),
            region: requireText(provider.region, "provider.region"),
            backupReference: optionalSafeReference(
                provider.backupReference,
                "provider.backupReference"
            )
        },
        database: {
            identity: requireSafeIdentity(database.identity, "database.identity"),
            postgresVersion: requireText(
                database.postgresVersion,
                "database.postgresVersion"
            )
        },
        backup: {
            status: requireChoice(backup.status, "backup.status", BACKUP_STATUSES),
            latestSuccessfulAt,
            encrypted: requireBoolean(backup.encrypted, "backup.encrypted"),
            encryptionKeyManagement: requireChoice(
                backup.encryptionKeyManagement,
                "backup.encryptionKeyManagement",
                ENCRYPTION_KEY_MANAGEMENT
            ),
            restorable: requireBoolean(backup.restorable, "backup.restorable"),
            retentionDays: requireInteger(
                backup.retentionDays,
                "backup.retentionDays",
                { minimum: 1 }
            )
        },
        pitr: {
            enabled: requireBoolean(pitr.enabled, "pitr.enabled"),
            continuous: requireBoolean(pitr.continuous, "pitr.continuous"),
            earliestRecoveryAt,
            latestRecoveryAt,
            latestWalAt,
            gapDetected: requireBoolean(pitr.gapDetected, "pitr.gapDetected")
        },
        access: {
            applicationRoleSeparated: requireBoolean(
                access.applicationRoleSeparated,
                "access.applicationRoleSeparated"
            ),
            backupRoleSeparated: requireBoolean(
                access.backupRoleSeparated,
                "access.backupRoleSeparated"
            ),
            restoreRoleSeparated: requireBoolean(
                access.restoreRoleSeparated,
                "access.restoreRoleSeparated"
            ),
            humanMfaRequired: requireBoolean(
                access.humanMfaRequired,
                "access.humanMfaRequired"
            ),
            administrativeAuditLogging: requireBoolean(
                access.administrativeAuditLogging,
                "access.administrativeAuditLogging"
            )
        },
        collection: {
            source: requireChoice(
                collection.source,
                "collection.source",
                COLLECTION_SOURCES
            ),
            exporterVersion: requireText(
                collection.exporterVersion,
                "collection.exporterVersion"
            )
        }
    };
}

export function managedBackupEvidenceDigest(evidence) {
    if (Number(evidence?.evidenceVersion) !== MANAGED_BACKUP_EVIDENCE_VERSION) {
        fail(`Managed backup evidence version ${evidence?.evidenceVersion ?? "unknown"} is not supported.`);
    }
    const payload = evidencePayload(evidence);
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function createManagedBackupEvidence(input) {
    requireObject(input, "evidence");
    assertNoSecretShapedFields(input);
    const payload = evidencePayload(input);
    const suppliedVersion = Number(input.evidenceVersion);
    if (suppliedVersion !== MANAGED_BACKUP_EVIDENCE_VERSION) {
        fail(`Managed backup evidence version ${input.evidenceVersion ?? "unknown"} is not supported.`);
    }
    const evidenceDigest = managedBackupEvidenceDigest(payload);
    if (input.evidenceDigest && input.evidenceDigest !== evidenceDigest) {
        fail(
            "Managed backup evidence digest does not match its safe payload.",
            "MANAGED_BACKUP_EVIDENCE_DIGEST_MISMATCH"
        );
    }
    return Object.freeze({
        ...payload,
        evidenceDigest
    });
}

export function readManagedBackupEvidence(evidencePath) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(evidencePath, "utf8"));
    } catch (error) {
        fail(`Managed backup evidence could not be read: ${error.message}`);
    }
    return createManagedBackupEvidence(parsed);
}

export function writeManagedBackupEvidence(directory, evidence) {
    const validated = createManagedBackupEvidence(evidence);
    const safeName = basename(validated.evidenceId).replaceAll(/[^a-zA-Z0-9._-]/g, "-");
    if (!safeName || safeName !== validated.evidenceId) {
        fail("evidenceId must be safe for use as an evidence filename.");
    }
    const path = resolve(directory, `${safeName}.managed-backup-evidence.json`);
    writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
    });
    return { evidence: validated, path };
}
