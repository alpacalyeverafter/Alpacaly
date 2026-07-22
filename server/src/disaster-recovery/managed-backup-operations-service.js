import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { BackupCatalogue } from "./backup-catalogue.js";
import {
    createManagedBackupEvidence,
    writeManagedBackupEvidence
} from "./managed-backup-evidence.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function requirePositiveInteger(value, name) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive safe integer.`);
    }
    return parsed;
}

function ageSeconds(now, timestamp) {
    if (!timestamp) {
        return null;
    }
    return Math.max(0, Math.floor((now.getTime() - Date.parse(timestamp)) / 1000));
}

function addAlert(alerts, code, message, severity = "CRITICAL") {
    alerts.push(Object.freeze({ code, severity, message }));
}

function safeEvidenceDirectory(directory) {
    if (!directory || !isAbsolute(directory)) {
        throw new Error("Managed backup evidence directory must be an absolute path.");
    }
    const resolved = resolve(directory);
    if ([resolve("/"), resolve(homedir())].includes(resolved)) {
        throw new Error("Managed backup evidence directory is too broad to use safely.");
    }
    const repositoryRelative = relative(REPOSITORY_ROOT, resolved);
    const insideRepository = repositoryRelative === ""
        || (!repositoryRelative.startsWith(`..${sep}`) && repositoryRelative !== "..");
    if (insideRepository) {
        throw new Error("Managed backup evidence must be stored outside the repository.");
    }
    return resolved;
}

export class ManagedBackupOperationsService {
    constructor({
        directory,
        restoreCatalogueDirectory = directory,
        expectedEnvironment,
        expectedDatabaseIdentity,
        expectedRegion,
        maximumEvidenceAgeMinutes = 30,
        maximumBackupAgeHours = 24,
        recoveryPointObjectiveMinutes = 15,
        minimumRetentionDays = 14,
        restoreDrillMaximumAgeDays = 30,
        clock = () => new Date(),
        idGenerator = randomUUID
    } = {}) {
        this.directory = safeEvidenceDirectory(directory);
        if (restoreCatalogueDirectory && !isAbsolute(restoreCatalogueDirectory)) {
            throw new Error("Restore catalogue directory must be an absolute path.");
        }
        this.restoreCatalogueDirectory = restoreCatalogueDirectory
            ? resolve(restoreCatalogueDirectory) : null;
        this.expectedEnvironment = String(expectedEnvironment || "").trim().toLowerCase();
        if (!["staging", "production"].includes(this.expectedEnvironment)) {
            throw new Error("Managed backup expected environment must be staging or production.");
        }
        this.expectedDatabaseIdentity = String(expectedDatabaseIdentity || "").trim();
        if (!/^sha256:[a-f0-9]{64}$/.test(this.expectedDatabaseIdentity)) {
            throw new Error(
                "Managed backup expected database identity must be a sanitized SHA-256 identity."
            );
        }
        this.expectedRegion = String(expectedRegion || "").trim().toLowerCase();
        if (!this.expectedRegion) {
            throw new Error("Managed backup expected region is required.");
        }
        this.maximumEvidenceAgeMinutes = requirePositiveInteger(
            maximumEvidenceAgeMinutes,
            "maximumEvidenceAgeMinutes"
        );
        this.maximumBackupAgeHours = requirePositiveInteger(
            maximumBackupAgeHours,
            "maximumBackupAgeHours"
        );
        this.recoveryPointObjectiveMinutes = requirePositiveInteger(
            recoveryPointObjectiveMinutes,
            "recoveryPointObjectiveMinutes"
        );
        this.minimumRetentionDays = requirePositiveInteger(
            minimumRetentionDays,
            "minimumRetentionDays"
        );
        this.restoreDrillMaximumAgeDays = requirePositiveInteger(
            restoreDrillMaximumAgeDays,
            "restoreDrillMaximumAgeDays"
        );
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    listEvidence() {
        let names;
        try {
            names = readdirSync(this.directory);
        } catch (error) {
            if (error.code === "ENOENT") {
                return [];
            }
            const catalogueError = new Error(
                "Managed backup evidence catalogue cannot be read."
            );
            catalogueError.code = "MANAGED_BACKUP_EVIDENCE_CATALOGUE_INVALID";
            throw catalogueError;
        }
        return names
            .filter(name => name.endsWith(".managed-backup-evidence.json"))
            .map(name => {
                try {
                    return createManagedBackupEvidence(JSON.parse(
                        readFileSync(resolve(this.directory, name), "utf8")
                    ));
                } catch (error) {
                    const catalogueError = new Error(
                        `Managed backup evidence catalogue is invalid: ${error.message}`
                    );
                    catalogueError.code = "MANAGED_BACKUP_EVIDENCE_CATALOGUE_INVALID";
                    throw catalogueError;
                }
            })
            .sort((left, right) => Date.parse(right.collectedAt) - Date.parse(left.collectedAt));
    }

    latestEvidence() {
        return this.listEvidence()[0] || null;
    }

    recordEvidence(input) {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const result = writeManagedBackupEvidence(this.directory, input);
        return {
            ...result,
            report: this.evaluate()
        };
    }

    evaluate(input = undefined) {
        const now = this.clock();
        let candidate = input;
        if (candidate === undefined) {
            try {
                candidate = this.latestEvidence();
            } catch {
                const alerts = [];
                addAlert(
                    alerts,
                    "MANAGED_BACKUP_EVIDENCE_CATALOGUE_INVALID",
                    "Managed backup evidence is unreadable, invalid, or has a digest mismatch."
                );
                return this.#report({ evidence: null, alerts, now });
            }
        }
        const evidence = candidate ? createManagedBackupEvidence(candidate) : null;
        const alerts = [];
        if (!evidence) {
            addAlert(
                alerts,
                "MANAGED_BACKUP_EVIDENCE_MISSING",
                "No managed backup provider evidence has been recorded."
            );
            return this.#report({ evidence: null, alerts, now });
        }

        const collectedTime = Date.parse(evidence.collectedAt);
        if (collectedTime > now.getTime() + 5 * MINUTE_MS) {
            addAlert(
                alerts,
                "MANAGED_BACKUP_EVIDENCE_FROM_FUTURE",
                "Managed backup evidence has an invalid future collection time."
            );
        }
        if (now.getTime() - collectedTime > this.maximumEvidenceAgeMinutes * MINUTE_MS) {
            addAlert(
                alerts,
                "MANAGED_BACKUP_EVIDENCE_STALE",
                "Managed backup provider evidence is older than the configured collection limit."
            );
        }
        if (evidence.environment !== this.expectedEnvironment) {
            addAlert(
                alerts,
                "MANAGED_BACKUP_ENVIRONMENT_MISMATCH",
                "Managed backup evidence is for a different environment."
            );
        }
        if (evidence.database.identity !== this.expectedDatabaseIdentity) {
            addAlert(
                alerts,
                "MANAGED_BACKUP_DATABASE_MISMATCH",
                "Managed backup evidence is for a different database identity."
            );
        }
        if (evidence.provider.region.toLowerCase() !== this.expectedRegion) {
            addAlert(
                alerts,
                "MANAGED_BACKUP_REGION_MISMATCH",
                "Managed backup evidence is for a different provider region."
            );
        }
        const postgresVersionMatch = /^(\d+)(?:\.|$)/
            .exec(evidence.database.postgresVersion);
        const postgresMajor = Number(postgresVersionMatch?.[1]);
        if (!Number.isSafeInteger(postgresMajor) || postgresMajor < 16) {
            addAlert(
                alerts,
                "MANAGED_POSTGRES_VERSION_UNSUPPORTED",
                "Managed backup evidence does not report PostgreSQL 16 or newer."
            );
        }
        if (evidence.backup.status !== "AVAILABLE") {
            addAlert(
                alerts,
                "MANAGED_BACKUP_NOT_AVAILABLE",
                "The provider does not report the latest backup as available."
            );
        }
        if (!evidence.backup.latestSuccessfulAt) {
            addAlert(
                alerts,
                "MANAGED_BACKUP_SUCCESS_MISSING",
                "The provider reports no successful managed backup."
            );
        } else {
            const backupTime = Date.parse(evidence.backup.latestSuccessfulAt);
            if (backupTime > collectedTime + 5 * MINUTE_MS) {
                addAlert(
                    alerts,
                    "MANAGED_BACKUP_TIME_INVALID",
                    "The latest backup time is later than the provider evidence collection time."
                );
            }
            if (now.getTime() - backupTime > this.maximumBackupAgeHours * HOUR_MS) {
                addAlert(
                    alerts,
                    "MANAGED_BACKUP_OVERDUE",
                    "The latest successful managed backup is too old."
                );
            }
        }
        if (!evidence.backup.encrypted) {
            addAlert(
                alerts,
                "MANAGED_BACKUP_ENCRYPTION_DISABLED",
                "The provider reports that managed backups are not encrypted."
            );
        }
        if (!evidence.backup.restorable) {
            addAlert(
                alerts,
                "MANAGED_BACKUP_NOT_RESTORABLE",
                "The provider does not report the managed backup as restorable."
            );
        }
        if (evidence.backup.retentionDays < this.minimumRetentionDays) {
            addAlert(
                alerts,
                "MANAGED_BACKUP_RETENTION_TOO_SHORT",
                "Managed backup retention is shorter than the configured minimum."
            );
        }

        if (!evidence.pitr.enabled) {
            addAlert(alerts, "MANAGED_PITR_DISABLED", "Point-in-time recovery is disabled.");
        }
        if (!evidence.pitr.continuous) {
            addAlert(
                alerts,
                "MANAGED_PITR_NOT_CONTINUOUS",
                "The provider does not report continuous point-in-time recovery coverage."
            );
        }
        if (evidence.pitr.gapDetected) {
            addAlert(
                alerts,
                "MANAGED_PITR_GAP_DETECTED",
                "The provider reports a WAL or point-in-time recovery coverage gap."
            );
        }
        if (!evidence.pitr.latestRecoveryAt || !evidence.pitr.latestWalAt) {
            addAlert(
                alerts,
                "MANAGED_PITR_RECOVERY_POINT_MISSING",
                "The latest recoverable point or WAL timestamp is unavailable."
            );
        } else {
            const recoveryPointTime = Math.min(
                Date.parse(evidence.pitr.latestRecoveryAt),
                Date.parse(evidence.pitr.latestWalAt)
            );
            if ([evidence.pitr.latestRecoveryAt, evidence.pitr.latestWalAt].some(
                value => Date.parse(value) > collectedTime + 5 * MINUTE_MS
            )) {
                addAlert(
                    alerts,
                    "MANAGED_PITR_TIME_INVALID",
                    "The latest recovery point is later than the evidence collection time."
                );
            }
            if (now.getTime() - recoveryPointTime
                > this.recoveryPointObjectiveMinutes * MINUTE_MS) {
                addAlert(
                    alerts,
                    "MANAGED_PITR_RPO_EXCEEDED",
                    "The latest recoverable point is older than the proposed RPO threshold."
                );
            }
        }
        if (!evidence.pitr.earliestRecoveryAt) {
            addAlert(
                alerts,
                "MANAGED_PITR_WINDOW_MISSING",
                "The earliest available point-in-time recovery timestamp is unavailable."
            );
        } else if (
            evidence.pitr.latestRecoveryAt
            && Date.parse(evidence.pitr.earliestRecoveryAt)
                > Date.parse(evidence.pitr.latestRecoveryAt)
        ) {
            addAlert(
                alerts,
                "MANAGED_PITR_WINDOW_INVALID",
                "The earliest recovery timestamp is later than the latest recovery timestamp."
            );
        }

        const accessChecks = [
            ["applicationRoleSeparated", "MANAGED_APPLICATION_ROLE_NOT_SEPARATED"],
            ["backupRoleSeparated", "MANAGED_BACKUP_ROLE_NOT_SEPARATED"],
            ["restoreRoleSeparated", "MANAGED_RESTORE_ROLE_NOT_SEPARATED"],
            ["humanMfaRequired", "MANAGED_HUMAN_MFA_NOT_REQUIRED"],
            ["administrativeAuditLogging", "MANAGED_ADMIN_AUDIT_LOGGING_DISABLED"]
        ];
        for (const [field, code] of accessChecks) {
            if (!evidence.access[field]) {
                addAlert(
                    alerts,
                    code,
                    "A required managed backup access-control safeguard is not reported as active."
                );
            }
        }

        const restoreCatalogue = new BackupCatalogue({
            directory: this.restoreCatalogueDirectory,
            clock: this.clock
        });
        let restoreDiagnostics = null;
        try {
            restoreDiagnostics = restoreCatalogue.getDiagnostics({
                maximumBackupAgeHours: this.maximumBackupAgeHours,
                restoreDrillMaximumAgeDays: this.restoreDrillMaximumAgeDays,
                environment: evidence.environment
            });
        } catch {
            addAlert(
                alerts,
                "MANAGED_RESTORE_CATALOGUE_INVALID",
                "Restore or backup-hold evidence is unreadable, invalid, or incomplete."
            );
        }
        if (restoreDiagnostics?.restoreDrillOverdue) {
            addAlert(
                alerts,
                "MANAGED_RESTORE_DRILL_OVERDUE",
                "No recent successful isolated restore drill is recorded."
            );
        }
        if (
            restoreDiagnostics?.latestSuccessfulRestoreTest
            && Date.parse(restoreDiagnostics.latestSuccessfulRestoreTest.testedAt)
                > now.getTime() + 5 * MINUTE_MS
        ) {
            addAlert(
                alerts,
                "MANAGED_RESTORE_DRILL_TIME_INVALID",
                "The latest successful restore drill has an invalid future completion time."
            );
        }

        return this.#report({ evidence, alerts, now, restoreDiagnostics });
    }

    recordCheck(input = undefined) {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const report = this.evaluate(input);
        const checkId = `managed-backup-check-${this.idGenerator()}`;
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(checkId)) {
            throw new Error("Managed backup check identity is unsafe.");
        }
        const path = resolve(this.directory, `${checkId}.managed-backup-check.json`);
        const record = {
            checkVersion: 1,
            checkId,
            ...report
        };
        writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600
        });
        return { record, path };
    }

    #report({ evidence, alerts, now, restoreDiagnostics = null }) {
        const status = alerts.some(alert => alert.severity === "CRITICAL")
            ? "BLOCKED"
            : alerts.length > 0 ? "WARNING" : "PASS";
        return Object.freeze({
            status,
            checkedAt: now.toISOString(),
            evidence: evidence ? {
                evidenceId: evidence.evidenceId,
                evidenceDigest: evidence.evidenceDigest,
                collectedAt: evidence.collectedAt,
                environment: evidence.environment,
                provider: evidence.provider.name,
                service: evidence.provider.service,
                region: evidence.provider.region,
                databaseIdentity: evidence.database.identity,
                backupAgeSeconds: ageSeconds(now, evidence.backup.latestSuccessfulAt),
                recoveryPointAgeSeconds: ageSeconds(now, evidence.pitr.latestRecoveryAt),
                walAgeSeconds: ageSeconds(now, evidence.pitr.latestWalAt)
            } : null,
            restoreDrill: restoreDiagnostics?.latestSuccessfulRestoreTest || null,
            thresholds: {
                maximumEvidenceAgeMinutes: this.maximumEvidenceAgeMinutes,
                maximumBackupAgeHours: this.maximumBackupAgeHours,
                recoveryPointObjectiveMinutes: this.recoveryPointObjectiveMinutes,
                minimumRetentionDays: this.minimumRetentionDays,
                restoreDrillMaximumAgeDays: this.restoreDrillMaximumAgeDays
            },
            alerts
        });
    }
}
