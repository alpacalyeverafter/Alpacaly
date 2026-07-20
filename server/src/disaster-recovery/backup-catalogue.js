import {
    existsSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync
} from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
    readBackupManifest,
    resolveBackupArtifactPath,
    writeBackupManifest
} from "./backup-manifest.js";
import { isBackupExpired } from "./retention-policy.js";

export class BackupCatalogue {
    constructor({ directory = null, clock = () => new Date(), idGenerator = randomUUID } = {}) {
        this.directory = directory;
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    list() {
        if (!this.directory) {
            return [];
        }
        let names;
        try {
            names = readdirSync(this.directory);
        } catch {
            return [];
        }
        return names
            .filter(name => name.endsWith(".manifest.json"))
            .map(name => {
                const manifestPath = join(this.directory, name);
                try {
                    return { manifestPath, manifest: readBackupManifest(manifestPath) };
                } catch {
                    return null;
                }
            })
            .filter(Boolean)
            .sort((left, right) => (
                Date.parse(right.manifest.createdAt) - Date.parse(left.manifest.createdAt)
            ));
    }

    operationRecords() {
        if (!this.directory) {
            return [];
        }
        let names;
        try {
            names = readdirSync(this.directory);
        } catch {
            return [];
        }
        return names
            .filter(name => name.endsWith(".backup-operation.json"))
            .map(name => {
                try {
                    return JSON.parse(readFileSync(join(this.directory, name), "utf8"));
                } catch {
                    return null;
                }
            })
            .filter(Boolean)
            .sort((left, right) => Date.parse(
                right.completedAt || right.failedAt || right.startedAt
            ) - Date.parse(left.completedAt || left.failedAt || left.startedAt));
    }

    restoreReports() {
        if (!this.directory) {
            return [];
        }
        let names;
        try {
            names = readdirSync(this.directory);
        } catch {
            return [];
        }
        return names
            .filter(name => name.endsWith(".restore-report.json"))
            .map(name => {
                try {
                    return JSON.parse(readFileSync(join(this.directory, name), "utf8"));
                } catch {
                    return null;
                }
            })
            .filter(Boolean)
            .sort((left, right) => Date.parse(
                right.completedAt || right.failedAt || right.startedAt
            ) - Date.parse(left.completedAt || left.failedAt || left.startedAt));
    }

    get(backupId) {
        return this.list().find(item => item.manifest.backupId === backupId) || null;
    }

    identifyExpired(now = this.clock()) {
        return this.list().filter(item => isBackupExpired(item.manifest, now));
    }

    recordRestoreTest(manifestPath, {
        status,
        reportId,
        testedAt = this.clock().toISOString()
    }) {
        const current = readBackupManifest(manifestPath);
        const normalizedStatus = String(status).trim().toUpperCase();
        const updated = {
            ...current,
            restoreTest: {
                status: normalizedStatus,
                lastTestedAt: testedAt,
                mostRecentSuccessfulAt: ["PASS", "WARNING"].includes(normalizedStatus)
                    ? testedAt
                    : current.restoreTest.mostRecentSuccessfulAt,
                reportId
            }
        };
        return writeBackupManifest(manifestPath, updated, { overwrite: true });
    }

    deleteExpiredTestBackups({ approved = false, now = this.clock() } = {}) {
        if (!approved) {
            throw new Error("Expired test backup deletion requires explicit approval.");
        }
        const expired = this.identifyExpired(now);
        if (expired.some(item => item.manifest.environment !== "test")) {
            throw new Error("This phase only permits deletion of expired test backups.");
        }
        const deleted = [];
        expired.forEach(({ manifestPath, manifest }) => {
            const artifactPath = resolveBackupArtifactPath(manifestPath, manifest);
            unlinkSync(artifactPath);
            unlinkSync(manifestPath);
            deleted.push({
                backupId: manifest.backupId,
                artifactFileName: basename(artifactPath)
            });
        });
        if (deleted.length > 0) {
            const evidence = {
                deletionAuditId: `backup-deletion-${this.idGenerator()}`,
                event: "EXPIRED_TEST_BACKUPS_DELETED",
                occurredAt: now.toISOString(),
                deleted
            };
            writeFileSync(
                join(this.directory, `${evidence.deletionAuditId}.deletion-audit.json`),
                `${JSON.stringify(evidence, null, 2)}\n`,
                { encoding: "utf8", flag: "wx", mode: 0o600 }
            );
        }
        return deleted;
    }

    getDiagnostics({ maximumBackupAgeHours = 24, restoreDrillMaximumAgeDays = 30 } = {}) {
        const entries = this.list();
        const latestOperation = this.operationRecords()[0] || null;
        const latestRestoreReport = this.restoreReports()[0] || null;
        const latest = entries[0]?.manifest || null;
        const successfulRestore = entries
            .map(item => item.manifest)
            .filter(manifest => manifest.restoreTest.mostRecentSuccessfulAt)
            .sort((left, right) => Date.parse(
                right.restoreTest.mostRecentSuccessfulAt
            ) - Date.parse(left.restoreTest.mostRecentSuccessfulAt))[0] || null;
        const now = this.clock().getTime();
        const backupAgeSeconds = latest
            ? Math.max(0, Math.floor((now - Date.parse(latest.createdAt)) / 1000))
            : null;
        const restoreAgeSeconds = successfulRestore
            ? Math.max(0, Math.floor((
                now - Date.parse(successfulRestore.restoreTest.mostRecentSuccessfulAt)
            ) / 1000))
            : null;
        return {
            configurationReady: Boolean(this.directory && existsSync(this.directory)),
            latestBackupResult: latestOperation ? {
                backupId: latestOperation.backupId,
                result: latestOperation.event,
                occurredAt: latestOperation.completedAt
                    || latestOperation.failedAt
                    || latestOperation.startedAt,
                failureCode: latestOperation.failureCode || null
            } : null,
            latestBackup: latest ? {
                backupId: latest.backupId,
                createdAt: latest.createdAt,
                ageSeconds: backupAgeSeconds,
                checksumStatus: "RECORDED",
                restoreTestStatus: latest.restoreTest.status
            } : null,
            latestSuccessfulRestoreTest: successfulRestore ? {
                backupId: successfulRestore.backupId,
                testedAt: successfulRestore.restoreTest.mostRecentSuccessfulAt,
                ageSeconds: restoreAgeSeconds
            } : null,
            latestRestoreTestResult: latestRestoreReport ? {
                reportId: latestRestoreReport.reportId,
                backupId: latestRestoreReport.backupId,
                result: latestRestoreReport.status,
                occurredAt: latestRestoreReport.completedAt
                    || latestRestoreReport.failedAt
                    || latestRestoreReport.startedAt,
                failureCode: latestRestoreReport.failureCode || null
            } : null,
            backupOverdue: backupAgeSeconds === null
                || backupAgeSeconds > maximumBackupAgeHours * 60 * 60,
            restoreDrillOverdue: restoreAgeSeconds === null
                || restoreAgeSeconds > restoreDrillMaximumAgeDays * 24 * 60 * 60,
            expiredBackupCount: this.identifyExpired().length
        };
    }
}
