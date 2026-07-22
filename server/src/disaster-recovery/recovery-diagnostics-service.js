import { BackupCatalogue } from "./backup-catalogue.js";
import { ManagedBackupOperationsService } from "./managed-backup-operations-service.js";

export class RecoveryDiagnosticsService {
    constructor({ recoverySafetyService, config = {}, clock = () => new Date() }) {
        this.recoverySafetyService = recoverySafetyService;
        this.config = config;
        this.catalogue = new BackupCatalogue({
            directory: config.backupCatalogueDirectory || null,
            clock
        });
        this.managedBackupOperations = config.managedBackupOperationsEnabled
            && config.managedBackupEvidenceDirectory
            ? new ManagedBackupOperationsService({
                directory: config.managedBackupEvidenceDirectory,
                restoreCatalogueDirectory: config.backupCatalogueDirectory
                    || config.managedBackupEvidenceDirectory,
                expectedEnvironment: config.managedBackupExpectedEnvironment,
                expectedDatabaseIdentity:
                    config.managedBackupExpectedDatabaseIdentity,
                expectedRegion: config.managedBackupExpectedRegion,
                maximumEvidenceAgeMinutes:
                    config.managedBackupMaximumEvidenceAgeMinutes,
                maximumBackupAgeHours: config.backupMaximumAgeHours,
                recoveryPointObjectiveMinutes:
                    config.managedBackupRecoveryPointObjectiveMinutes,
                minimumRetentionDays: config.managedBackupMinimumRetentionDays,
                restoreDrillMaximumAgeDays: config.restoreDrillMaximumAgeDays,
                clock
            })
            : null;
    }

    getDiagnostics() {
        const catalogue = this.catalogue.getDiagnostics({
            maximumBackupAgeHours: this.config.backupMaximumAgeHours || 24,
            restoreDrillMaximumAgeDays:
                this.config.restoreDrillMaximumAgeDays || 30
        });
        const managedBackup = this.managedBackupOperations?.evaluate() || null;
        return {
            ...this.recoverySafetyService.getDiagnostics(),
            backup: catalogue,
            managedBackup,
            derivedCounters: {
                expiredBackupIdentified: catalogue.expiredBackupCount,
                activeBackupHolds: catalogue.activeHoldCount,
                restoreDrillOverdue: catalogue.restoreDrillOverdue ? 1 : 0,
                backupOverdue: catalogue.backupOverdue ? 1 : 0,
                managedBackupBlocked: managedBackup?.status === "BLOCKED" ? 1 : 0
            },
            configuration: {
                ready: catalogue.configurationReady,
                managedOperationsEnabled: Boolean(this.managedBackupOperations),
                retention: {
                    dailyDays: this.config.backupRetentionDailyDays || 14,
                    weeklyWeeks: this.config.backupRetentionWeeklyWeeks || 8,
                    monthlyMonths: this.config.backupRetentionMonthlyMonths || 12,
                    minimumDays: this.config.backupMinimumRetentionDays || 7
                },
                automaticProductionDeletionEnabled: false
            }
        };
    }
}
