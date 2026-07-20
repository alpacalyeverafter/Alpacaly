import { BackupCatalogue } from "./backup-catalogue.js";

export class RecoveryDiagnosticsService {
    constructor({ recoverySafetyService, config = {}, clock = () => new Date() }) {
        this.recoverySafetyService = recoverySafetyService;
        this.config = config;
        this.catalogue = new BackupCatalogue({
            directory: config.backupCatalogueDirectory || null,
            clock
        });
    }

    getDiagnostics() {
        const catalogue = this.catalogue.getDiagnostics({
            maximumBackupAgeHours: this.config.backupMaximumAgeHours || 24,
            restoreDrillMaximumAgeDays:
                this.config.restoreDrillMaximumAgeDays || 30
        });
        return {
            ...this.recoverySafetyService.getDiagnostics(),
            backup: catalogue,
            derivedCounters: {
                expiredBackupIdentified: catalogue.expiredBackupCount,
                restoreDrillOverdue: catalogue.restoreDrillOverdue ? 1 : 0,
                backupOverdue: catalogue.backupOverdue ? 1 : 0
            },
            configuration: {
                ready: catalogue.configurationReady,
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
