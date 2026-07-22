import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const BACKUP_MANIFEST_VERSION = 1;
export const BACKUP_FORMAT = "POSTGRES_CUSTOM";

const RESTORE_TEST_STATUSES = Object.freeze([
    "NOT_TESTED",
    "PASS",
    "WARNING",
    "BLOCKED",
    "FAILED"
]);
const ENCRYPTION_STATUSES = Object.freeze([
    "NONE",
    "MANAGED_PROVIDER",
    "ENCRYPTED_OBJECT_STORAGE",
    "EXTERNAL_KEY_MANAGEMENT",
    "LOCAL_TEST_EXTERNAL"
]);

function requireText(value, name) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        throw new Error(`${name} is required.`);
    }
    return normalized;
}

function requireTimestamp(value, name, { nullable = false } = {}) {
    if ((value === null || value === undefined) && nullable) {
        return null;
    }
    const normalized = requireText(value, name);
    if (Number.isNaN(Date.parse(normalized))) {
        throw new Error(`${name} must be an ISO-compatible timestamp.`);
    }
    return normalized;
}

function requireNonNegativeInteger(value, name) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative safe integer.`);
    }
    return parsed;
}

function requireSha256(value, name) {
    const normalized = requireText(value, name).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
        throw new Error(`${name} must be a SHA-256 digest.`);
    }
    return normalized;
}

export function safeDatabaseIdentity(connectionString) {
    let parsed;
    try {
        parsed = new URL(connectionString);
    } catch {
        throw new Error("The PostgreSQL connection string is invalid.");
    }
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
        throw new Error("The database connection must use PostgreSQL.");
    }
    const databaseName = decodeURIComponent(parsed.pathname.slice(1));
    if (!databaseName) {
        throw new Error("The PostgreSQL database name is required.");
    }
    const identity = `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}/${databaseName}`;
    return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

export function databaseName(connectionString) {
    try {
        const parsed = new URL(connectionString);
        return decodeURIComponent(parsed.pathname.slice(1));
    } catch {
        throw new Error("The PostgreSQL connection string is invalid.");
    }
}

export function isSameDatabase(left, right) {
    if (!left || !right) {
        return false;
    }
    return safeDatabaseIdentity(left) === safeDatabaseIdentity(right);
}

export function createBackupManifest(input) {
    const fileName = basename(requireText(input?.artifact?.fileName, "artifact.fileName"));
    if (fileName !== input.artifact.fileName) {
        throw new Error("artifact.fileName must not contain a directory path.");
    }
    const restoreTestStatus = String(
        input?.restoreTest?.status || "NOT_TESTED"
    ).trim().toUpperCase();
    if (!RESTORE_TEST_STATUSES.includes(restoreTestStatus)) {
        throw new Error("restoreTest.status is not supported.");
    }
    const encryptionStatus = String(input?.encryption?.status || "NONE")
        .trim().toUpperCase();
    if (!ENCRYPTION_STATUSES.includes(encryptionStatus)) {
        throw new Error("encryption.status is not supported.");
    }
    const environment = requireText(input.environment, "environment").toLowerCase();
    if (!["test", "staging", "production"].includes(environment)) {
        throw new Error("environment must be test, staging or production.");
    }
    const format = requireText(input.artifact.format, "artifact.format").toUpperCase();
    if (format !== BACKUP_FORMAT) {
        throw new Error(`artifact.format must be ${BACKUP_FORMAT}.`);
    }
    const migrationVersion = Number(input.migrationVersion);
    if (!Number.isSafeInteger(migrationVersion) || migrationVersion < 1) {
        throw new Error("migrationVersion must be a positive safe integer.");
    }
    const sourceDatabaseIdentity = requireText(
        input.sourceDatabaseIdentity,
        "sourceDatabaseIdentity"
    );
    if (!/^sha256:[a-f0-9]{64}$/.test(sourceDatabaseIdentity)) {
        throw new Error("sourceDatabaseIdentity must be a sanitized SHA-256 identity.");
    }

    return Object.freeze({
        manifestVersion: BACKUP_MANIFEST_VERSION,
        backupId: requireText(input.backupId, "backupId"),
        createdAt: requireTimestamp(input.createdAt, "createdAt"),
        environment,
        sourceDatabaseIdentity,
        migrationVersion,
        applicationVersion: requireText(input.applicationVersion, "applicationVersion"),
        postgresVersion: requireText(input.postgresVersion, "postgresVersion"),
        artifact: Object.freeze({
            fileName,
            format,
            compression: requireText(input.artifact.compression, "artifact.compression"),
            sizeBytes: requireNonNegativeInteger(
                input.artifact.sizeBytes,
                "artifact.sizeBytes"
            ),
            checksumAlgorithm: "SHA-256",
            checksum: requireSha256(input.artifact.checksum, "artifact.checksum")
        }),
        encryption: Object.freeze({
            status: encryptionStatus,
            provider: input?.encryption?.provider
                ? String(input.encryption.provider).trim() : null,
            verifiedByBackupTool: false
        }),
        retentionExpiresAt: requireTimestamp(
            input.retentionExpiresAt,
            "retentionExpiresAt",
            { nullable: true }
        ),
        legalOrIncidentHold: input.legalOrIncidentHold === true,
        restoreTest: Object.freeze({
            status: restoreTestStatus,
            lastTestedAt: requireTimestamp(
                input?.restoreTest?.lastTestedAt,
                "restoreTest.lastTestedAt",
                { nullable: true }
            ),
            mostRecentSuccessfulAt: requireTimestamp(
                input?.restoreTest?.mostRecentSuccessfulAt,
                "restoreTest.mostRecentSuccessfulAt",
                { nullable: true }
            ),
            reportId: input?.restoreTest?.reportId
                ? String(input.restoreTest.reportId).trim() : null
        }),
        notes: input.notes ? String(input.notes).trim().slice(0, 2000) : null
    });
}

export function readBackupManifest(manifestPath) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
        throw new Error(`Backup manifest could not be read: ${error.message}`);
    }
    if (Number(parsed?.manifestVersion) !== BACKUP_MANIFEST_VERSION) {
        throw new Error(
            `Backup manifest version ${parsed?.manifestVersion ?? "unknown"} is not supported.`
        );
    }
    return createBackupManifest(parsed);
}

export function writeBackupManifest(manifestPath, manifest, { overwrite = false } = {}) {
    const validated = createBackupManifest(manifest);
    writeFileSync(
        manifestPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        { encoding: "utf8", flag: overwrite ? "w" : "wx", mode: 0o600 }
    );
    return validated;
}

export function resolveBackupArtifactPath(manifestPath, manifest) {
    return join(dirname(manifestPath), manifest.artifact.fileName);
}

export function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(filePath);
        stream.on("error", reject);
        stream.on("data", chunk => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

export async function verifyBackupChecksum(manifestPath, manifest = null) {
    const validated = manifest || readBackupManifest(manifestPath);
    const artifactPath = resolveBackupArtifactPath(manifestPath, validated);
    const actual = await sha256File(artifactPath);
    return Object.freeze({
        valid: actual === validated.artifact.checksum,
        algorithm: "SHA-256",
        expected: validated.artifact.checksum,
        actual
    });
}
