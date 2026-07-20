import { randomUUID } from "node:crypto";
import {
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
    BACKUP_FORMAT,
    createBackupManifest,
    safeDatabaseIdentity,
    sha256File,
    writeBackupManifest
} from "./backup-manifest.js";
import { calculateRetentionExpiry } from "./retention-policy.js";
import {
    assertPostgresToolAvailable,
    createPostgresClient,
    runPostgresTool
} from "./postgres-tools.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PACKAGE_PATH = resolve(REPOSITORY_ROOT, "server/package.json");

function isWithin(parent, candidate) {
    const path = relative(parent, candidate);
    return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function assertSafeOutputDirectory(outputDirectory, repositoryRoot = REPOSITORY_ROOT) {
    if (!isAbsolute(outputDirectory)) {
        throw new Error("The backup output directory must be an absolute path.");
    }
    const resolved = resolve(outputDirectory);
    if ([resolve("/"), resolve(homedir())].includes(resolved)) {
        throw new Error("The backup output directory is too broad to use safely.");
    }
    if (isWithin(repositoryRoot, resolved)) {
        throw new Error("Backup artifacts must be written outside the repository.");
    }
    return resolved;
}

function writeOperationRecord(directory, record) {
    const eventName = String(record.event).toLowerCase().replaceAll("_", "-");
    const path = resolve(
        directory,
        `${record.operationId}.${eventName}.backup-operation.json`
    );
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
    });
}

function applicationVersion() {
    return JSON.parse(readFileSync(PACKAGE_PATH, "utf8")).version;
}

export async function createPostgresBackup({
    config,
    outputDirectory,
    environment = config?.nodeEnv,
    cadence = "daily",
    compressionLevel = 9,
    encryption = { status: "NONE", provider: null },
    legalOrIncidentHold = false,
    notes = null,
    clock = () => new Date(),
    idGenerator = randomUUID,
    commandRunner = runPostgresTool,
    pgDumpBinary = "pg_dump",
    logger = null,
    repositoryRoot = REPOSITORY_ROOT
}) {
    if (config?.centralDatabaseType !== "postgres" || !config?.postgresUrl) {
        throw new Error("PostgreSQL central persistence is required for backup.");
    }
    const normalizedEnvironment = String(environment || "").trim().toLowerCase();
    if (!["test", "staging"].includes(normalizedEnvironment)) {
        throw new Error(
            "This phase permits backup execution only in test or staging environments."
        );
    }
    const compression = Number(compressionLevel);
    if (!Number.isInteger(compression) || compression < 0 || compression > 9) {
        throw new Error("compressionLevel must be an integer from 0 to 9.");
    }
    const safeDirectory = assertSafeOutputDirectory(outputDirectory, repositoryRoot);
    mkdirSync(safeDirectory, { recursive: true, mode: 0o700 });
    await assertPostgresToolAvailable(pgDumpBinary, commandRunner);

    const createdAt = clock().toISOString();
    const backupId = `backup-${createdAt.replaceAll(/[:.]/g, "-")}-${idGenerator()}`;
    const operationId = `backup-operation-${idGenerator()}`;
    const artifactFileName = `${backupId}.dump`;
    const artifactPath = resolve(safeDirectory, artifactFileName);
    const partialPath = `${artifactPath}.partial`;
    const manifestPath = resolve(safeDirectory, `${backupId}.manifest.json`);
    const operation = {
        operationVersion: 1,
        operationId,
        event: "BACKUP_STARTED",
        backupId,
        startedAt: createdAt,
        environment: normalizedEnvironment
    };
    writeOperationRecord(safeDirectory, operation);
    logger?.info?.({ event: "backup_started", backupId }, "PostgreSQL backup started");

    let client;
    try {
        client = createPostgresClient(config.postgresUrl, {
            sslMode: config.postgresSslMode,
            tlsCaPath: config.postgresTlsCaPath
        });
        await client.connect();
        const migration = await client.query(`
            SELECT COALESCE(MAX(version), 0)::integer AS version
            FROM AlpacalySchemaMigrations
        `);
        const serverVersion = await client.query("SHOW server_version");
        await client.end();
        client = null;
        const migrationVersion = Number(migration.rows[0].version);
        if (!Number.isSafeInteger(migrationVersion) || migrationVersion < 1) {
            throw new Error("The source database has no supported migration version.");
        }

        await commandRunner(pgDumpBinary, [
            "--format=custom",
            `--compress=${compression}`,
            "--no-owner",
            "--no-privileges",
            "--serializable-deferrable",
            `--file=${partialPath}`
        ], {
            connectionString: config.postgresUrl
        });
        renameSync(partialPath, artifactPath);
        const checksum = await sha256File(artifactPath);
        const sizeBytes = statSync(artifactPath).size;
        const retentionExpiresAt = calculateRetentionExpiry({
            createdAt,
            cadence,
            legalOrIncidentHold,
            policy: {
                dailyDays: config.backupRetentionDailyDays,
                weeklyWeeks: config.backupRetentionWeeklyWeeks,
                monthlyMonths: config.backupRetentionMonthlyMonths,
                minimumDays: config.backupMinimumRetentionDays
            }
        });
        const manifest = createBackupManifest({
            backupId,
            createdAt,
            environment: normalizedEnvironment,
            sourceDatabaseIdentity: safeDatabaseIdentity(config.postgresUrl),
            migrationVersion,
            applicationVersion: applicationVersion(),
            postgresVersion: serverVersion.rows[0].server_version,
            artifact: {
                fileName: artifactFileName,
                format: BACKUP_FORMAT,
                compression: `pg_dump custom level ${compression}`,
                sizeBytes,
                checksum
            },
            encryption,
            retentionExpiresAt,
            legalOrIncidentHold,
            restoreTest: { status: "NOT_TESTED" },
            notes
        });
        writeBackupManifest(manifestPath, manifest);
        writeOperationRecord(safeDirectory, {
            ...operation,
            event: "BACKUP_COMPLETED",
            completedAt: clock().toISOString(),
            manifestFileName: `${backupId}.manifest.json`
        });
        logger?.info?.({
            event: "backup_completed",
            backupId,
            sizeBytes,
            checksumRecorded: true
        }, "PostgreSQL backup completed; recoverability is not yet proven");
        return { manifest, manifestPath, artifactPath };
    } catch (error) {
        await client?.end().catch(() => {});
        try {
            unlinkSync(partialPath);
        } catch {}
        writeOperationRecord(safeDirectory, {
            ...operation,
            event: "BACKUP_FAILED",
            failedAt: clock().toISOString(),
            failureCode: error.code || "BACKUP_FAILED"
        });
        logger?.error?.({
            event: "backup_failed",
            backupId,
            failureCode: error.code || "BACKUP_FAILED"
        }, "PostgreSQL backup failed");
        throw error;
    }
}
