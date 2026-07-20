export const migration012DisasterRecoverySafety = Object.freeze({
    version: 12,
    name: "disaster_recovery_safety",
    up(database) {
        database.exec(`
            CREATE TABLE RecoverySafetyState (
                recoveryStateId TEXT PRIMARY KEY
                    CHECK (recoveryStateId = 'central'),
                mode TEXT NOT NULL CHECK (mode IN ('NORMAL', 'BLOCKED')),
                sourceBackupId TEXT,
                restoredAt TEXT,
                reconciliationStatus TEXT NOT NULL CHECK (reconciliationStatus IN (
                    'NOT_RUN', 'PASS', 'WARNING', 'BLOCKED'
                )),
                reconciliationRunAt TEXT,
                releasedAt TEXT,
                releaseDecisionId TEXT,
                unresolvedClaimCount INTEGER NOT NULL DEFAULT 0
                    CHECK (unresolvedClaimCount >= 0),
                unresolvedCommandCount INTEGER NOT NULL DEFAULT 0
                    CHECK (unresolvedCommandCount >= 0),
                lastReportJson TEXT NOT NULL DEFAULT 'null',
                updatedAt TEXT NOT NULL
            ) STRICT, WITHOUT ROWID;

            INSERT INTO RecoverySafetyState (
                recoveryStateId, mode, reconciliationStatus, updatedAt
            ) VALUES (
                'central', 'NORMAL', 'NOT_RUN', CURRENT_TIMESTAMP
            );

            CREATE TABLE RestoredCommandReviews (
                commandId TEXT PRIMARY KEY,
                sourceBackupId TEXT NOT NULL,
                originalStatus TEXT NOT NULL,
                classification TEXT NOT NULL CHECK (classification IN (
                    'PROVEN_NOT_SENT', 'UNCERTAIN', 'COMPLETED', 'OUTCOME_UNKNOWN'
                )),
                reviewStatus TEXT NOT NULL CHECK (reviewStatus IN (
                    'REVIEW_REQUIRED', 'SAFE_WORK_RELEASED', 'CLOSED'
                )),
                createdAt TEXT NOT NULL,
                reviewedAt TEXT,
                reviewDecisionId TEXT,
                detailsJson TEXT NOT NULL DEFAULT 'null',
                FOREIGN KEY (commandId)
                    REFERENCES DeviceCommands(commandId) ON DELETE RESTRICT
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE DisasterRecoveryEvents (
                recoveryEventSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                eventType TEXT NOT NULL,
                backupId TEXT,
                occurredAt TEXT NOT NULL,
                detailsJson TEXT NOT NULL DEFAULT 'null'
            ) STRICT;

            CREATE INDEX restored_command_reviews_status
                ON RestoredCommandReviews(reviewStatus, classification);
            CREATE INDEX disaster_recovery_events_type
                ON DisasterRecoveryEvents(eventType, occurredAt);

            CREATE TRIGGER disaster_recovery_events_append_only_update
            BEFORE UPDATE ON DisasterRecoveryEvents
            BEGIN SELECT RAISE(ABORT, 'Disaster Recovery events are append-only'); END;
            CREATE TRIGGER disaster_recovery_events_append_only_delete
            BEFORE DELETE ON DisasterRecoveryEvents
            BEGIN SELECT RAISE(ABORT, 'Disaster Recovery events are append-only'); END;
        `);
    }
});
