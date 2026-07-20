const commandStates = [
    "PENDING", "READY", "SENT", "ACKNOWLEDGED", "RETRY_SCHEDULED",
    "TIMED_OUT", "FAILED", "OUTCOME_UNKNOWN", "CANCELLED"
].map(value => `'${value}'`).join(", ");

const commandTypes = ["RING_BELL", "DISPENSE_FEED"]
    .map(value => `'${value}'`).join(", ");

const feederSafetyStates = [
    "ONLINE", "OFFLINE", "DEGRADED", "PAUSED", "MAINTENANCE",
    "EMERGENCY_STOPPED", "BLOCKED_OUTCOME_UNKNOWN", "UNKNOWN"
].map(value => `'${value}'`).join(", ");

const approvalStatuses = [
    "PENDING", "PARTIALLY_APPROVED", "APPROVED", "REJECTED", "EXPIRED",
    "CANCELLED", "EXECUTED", "EXECUTION_FAILED"
].map(value => `'${value}'`).join(", ");

export const migration007OperatorSafety = Object.freeze({
    version: 7,
    name: "operator_safety",
    requiresForeignKeysDisabled: true,
    up(database) {
        database.exec(`
            ALTER TABLE OperatorAuditRecords ADD COLUMN approvalId TEXT;
            ALTER TABLE Feeders
                ADD COLUMN safetyStatus TEXT NOT NULL DEFAULT 'ONLINE'
                CHECK (safetyStatus IN (${feederSafetyStates}));
            ALTER TABLE Feeders ADD COLUMN safetyReason TEXT;
            ALTER TABLE Feeders ADD COLUMN safetyUpdatedAt TEXT;
            ALTER TABLE Events ADD COLUMN safetyState TEXT;
            ALTER TABLE Events ADD COLUMN safetyUpdatedAt TEXT;

            CREATE TABLE EmergencyStops (
                emergencyStopSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                emergencyStopId TEXT NOT NULL UNIQUE,
                level TEXT NOT NULL CHECK (level IN ('PLATFORM', 'BARN', 'FEEDER')),
                barnId TEXT,
                feederId TEXT,
                status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CLEARED')),
                activatedBy TEXT NOT NULL,
                activatedRole TEXT NOT NULL,
                reason TEXT NOT NULL,
                requestId TEXT,
                activatedAt TEXT NOT NULL,
                clearedAt TEXT,
                clearanceApprovalRequestId TEXT,
                FOREIGN KEY (activatedBy)
                    REFERENCES Administrators(administratorId) ON DELETE RESTRICT,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT,
                FOREIGN KEY (feederId) REFERENCES Feeders(feederId) ON DELETE RESTRICT,
                CHECK (
                    (level = 'PLATFORM' AND barnId IS NULL AND feederId IS NULL)
                    OR (level = 'BARN' AND barnId IS NOT NULL AND feederId IS NULL)
                    OR (level = 'FEEDER' AND barnId IS NOT NULL AND feederId IS NOT NULL)
                )
            ) STRICT;

            CREATE TABLE ApprovalRequests (
                approvalRequestSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                approvalRequestId TEXT NOT NULL UNIQUE,
                actionType TEXT NOT NULL,
                requestedBy TEXT NOT NULL,
                targetType TEXT NOT NULL,
                targetId TEXT NOT NULL,
                barnId TEXT,
                feederId TEXT,
                reason TEXT NOT NULL,
                requiredAuthoritiesJson TEXT NOT NULL,
                actionPayloadJson TEXT NOT NULL DEFAULT 'null',
                status TEXT NOT NULL CHECK (status IN (${approvalStatuses})),
                createdAt TEXT NOT NULL,
                expiresAt TEXT NOT NULL,
                completedAt TEXT,
                FOREIGN KEY (requestedBy)
                    REFERENCES Administrators(administratorId) ON DELETE RESTRICT,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT,
                FOREIGN KEY (feederId) REFERENCES Feeders(feederId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE ApprovalDecisions (
                approvalDecisionSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                approvalDecisionId TEXT NOT NULL UNIQUE,
                approvalRequestId TEXT NOT NULL,
                administratorId TEXT NOT NULL,
                effectiveRole TEXT NOT NULL,
                authorityRepresented TEXT NOT NULL
                    CHECK (authorityRepresented IN ('WELFARE', 'HARDWARE', 'PLATFORM_ADMIN')),
                decision TEXT NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
                reason TEXT NOT NULL,
                authenticationStrength TEXT NOT NULL,
                decidedAt TEXT NOT NULL,
                FOREIGN KEY (approvalRequestId)
                    REFERENCES ApprovalRequests(approvalRequestId) ON DELETE RESTRICT,
                FOREIGN KEY (administratorId)
                    REFERENCES Administrators(administratorId) ON DELETE RESTRICT,
                UNIQUE (approvalRequestId, administratorId)
            ) STRICT;

            CREATE TABLE ApprovalRequestHistory (
                approvalHistorySequence INTEGER PRIMARY KEY AUTOINCREMENT,
                approvalRequestId TEXT NOT NULL,
                fromStatus TEXT,
                toStatus TEXT NOT NULL CHECK (toStatus IN (${approvalStatuses})),
                timestamp TEXT NOT NULL,
                detailsJson TEXT NOT NULL DEFAULT 'null',
                FOREIGN KEY (approvalRequestId)
                    REFERENCES ApprovalRequests(approvalRequestId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE OperatorResolutionCases (
                resolutionCaseSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                resolutionCaseId TEXT NOT NULL UNIQUE,
                eventId TEXT NOT NULL,
                commandId TEXT NOT NULL UNIQUE,
                barnId TEXT NOT NULL,
                feederId TEXT NOT NULL,
                deviceId TEXT NOT NULL,
                caseType TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED')),
                requestedResolution TEXT,
                reason TEXT NOT NULL,
                supportingNotes TEXT,
                createdBy TEXT,
                createdAt TEXT NOT NULL,
                approvalDeadline TEXT,
                approvalRequestId TEXT,
                resolvedAt TEXT,
                finalResolution TEXT,
                welfareImpactJson TEXT NOT NULL,
                replacementCommandId TEXT,
                FOREIGN KEY (eventId) REFERENCES Events(eventId) ON DELETE RESTRICT,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT,
                FOREIGN KEY (feederId) REFERENCES Feeders(feederId) ON DELETE RESTRICT,
                FOREIGN KEY (deviceId) REFERENCES Devices(deviceId) ON DELETE RESTRICT,
                FOREIGN KEY (createdBy)
                    REFERENCES Administrators(administratorId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE WelfareSafetyLedger (
                welfareEntrySequence INTEGER PRIMARY KEY AUTOINCREMENT,
                welfareEntryId TEXT NOT NULL UNIQUE,
                eventId TEXT NOT NULL,
                commandId TEXT NOT NULL,
                resolutionCaseId TEXT,
                feederId TEXT NOT NULL,
                entryType TEXT NOT NULL,
                quantity REAL NOT NULL CHECK (quantity > 0),
                unit TEXT NOT NULL,
                countsAsDispensed INTEGER NOT NULL CHECK (countsAsDispensed IN (0, 1)),
                recordedAt TEXT NOT NULL,
                detailsJson TEXT NOT NULL DEFAULT 'null',
                FOREIGN KEY (eventId) REFERENCES Events(eventId) ON DELETE RESTRICT,
                FOREIGN KEY (commandId)
                    REFERENCES DeviceCommands(commandId) ON DELETE RESTRICT,
                FOREIGN KEY (resolutionCaseId)
                    REFERENCES OperatorResolutionCases(resolutionCaseId) ON DELETE RESTRICT,
                FOREIGN KEY (feederId) REFERENCES Feeders(feederId) ON DELETE RESTRICT
            ) STRICT;

            DROP TRIGGER device_command_validate_resources_insert;
            DROP TRIGGER device_command_identity_immutable;
            DROP TRIGGER device_acknowledgement_validate_device;
            DROP TRIGGER simulated_execution_validate_command;

            CREATE TABLE DeviceCommands_v7 (
                commandSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                commandId TEXT NOT NULL UNIQUE,
                eventId TEXT NOT NULL,
                barnId TEXT NOT NULL,
                feederId TEXT NOT NULL,
                deviceId TEXT NOT NULL,
                commandType TEXT NOT NULL CHECK (commandType IN (${commandTypes})),
                commandPayloadJson TEXT NOT NULL DEFAULT 'null',
                idempotencyKey TEXT NOT NULL UNIQUE,
                fencingToken INTEGER NOT NULL CHECK (fencingToken > 0),
                status TEXT NOT NULL CHECK (status IN (${commandStates})),
                attemptCount INTEGER NOT NULL DEFAULT 0 CHECK (attemptCount >= 0),
                maximumAttempts INTEGER NOT NULL CHECK (maximumAttempts > 0),
                acknowledgementDeadline TEXT,
                nextAttemptAt TEXT,
                createdAt TEXT NOT NULL,
                sentAt TEXT,
                acknowledgedAt TEXT,
                completedAt TEXT,
                failedAt TEXT,
                lastError TEXT,
                updatedAt TEXT NOT NULL,
                replacementOfCommandId TEXT,
                resolutionCaseId TEXT,
                FOREIGN KEY (eventId) REFERENCES Events(eventId) ON DELETE CASCADE,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT,
                FOREIGN KEY (feederId) REFERENCES Feeders(feederId) ON DELETE RESTRICT,
                FOREIGN KEY (deviceId) REFERENCES Devices(deviceId) ON DELETE RESTRICT,
                FOREIGN KEY (replacementOfCommandId)
                    REFERENCES DeviceCommands_v7(commandId) ON DELETE RESTRICT,
                FOREIGN KEY (resolutionCaseId)
                    REFERENCES OperatorResolutionCases(resolutionCaseId) ON DELETE RESTRICT,
                UNIQUE (feederId, fencingToken)
            ) STRICT;

            INSERT INTO DeviceCommands_v7 (
                commandSequence, commandId, eventId, barnId, feederId, deviceId,
                commandType, commandPayloadJson, idempotencyKey, fencingToken,
                status, attemptCount, maximumAttempts, acknowledgementDeadline,
                nextAttemptAt, createdAt, sentAt, acknowledgedAt, completedAt,
                failedAt, lastError, updatedAt, replacementOfCommandId,
                resolutionCaseId
            )
            SELECT
                commandSequence, commandId, eventId, barnId, feederId, deviceId,
                commandType, commandPayloadJson, idempotencyKey, fencingToken,
                status, attemptCount, maximumAttempts, acknowledgementDeadline,
                nextAttemptAt, createdAt, sentAt, acknowledgedAt, completedAt,
                failedAt, lastError, updatedAt, NULL, NULL
            FROM DeviceCommands;

            DROP TABLE DeviceCommands;
            ALTER TABLE DeviceCommands_v7 RENAME TO DeviceCommands;

            CREATE INDEX idx_device_commands_ready
                ON DeviceCommands(status, nextAttemptAt, commandSequence);
            CREATE INDEX idx_device_commands_event
                ON DeviceCommands(eventId, commandType);
            CREATE INDEX idx_device_commands_feeder
                ON DeviceCommands(feederId, commandSequence);
            CREATE UNIQUE INDEX idx_device_commands_original_event_action
                ON DeviceCommands(eventId, commandType)
                WHERE replacementOfCommandId IS NULL;
            CREATE UNIQUE INDEX idx_device_commands_resolution_replacement
                ON DeviceCommands(resolutionCaseId)
                WHERE resolutionCaseId IS NOT NULL;

            CREATE TRIGGER device_command_validate_resources_insert
            BEFORE INSERT ON DeviceCommands
            WHEN NOT EXISTS (
                SELECT 1
                FROM Events AS event
                JOIN FeederDeviceAssignments AS assignment
                  ON assignment.feederId = NEW.feederId
                 AND assignment.deviceId = NEW.deviceId
                 AND assignment.barnId = NEW.barnId
                WHERE event.eventId = NEW.eventId
                  AND event.barnId = NEW.barnId
                  AND event.feederId = NEW.feederId
            )
            BEGIN
                SELECT RAISE(ABORT, 'DeviceCommand resources do not match its Event');
            END;

            CREATE TRIGGER device_command_identity_immutable
            BEFORE UPDATE OF commandId, eventId, barnId, feederId, deviceId,
                             commandType, idempotencyKey, fencingToken,
                             replacementOfCommandId, resolutionCaseId
            ON DeviceCommands
            BEGIN
                SELECT RAISE(ABORT, 'DeviceCommand identity is immutable');
            END;

            CREATE TRIGGER device_acknowledgement_validate_device
            BEFORE INSERT ON DeviceAcknowledgements
            WHEN NOT EXISTS (
                SELECT 1
                FROM DeviceCommands
                WHERE commandId = NEW.commandId
                  AND deviceId = NEW.deviceId
            )
            BEGIN
                SELECT RAISE(ABORT, 'DeviceAcknowledgement device does not match command');
            END;

            CREATE TRIGGER simulated_execution_validate_command
            BEFORE INSERT ON SimulatedDeviceExecutions
            WHEN NOT EXISTS (
                SELECT 1
                FROM DeviceCommands
                WHERE commandId = NEW.commandId
                  AND deviceId = NEW.deviceId
                  AND fencingToken = NEW.fencingToken
            )
            BEGIN
                SELECT RAISE(ABORT, 'Simulated execution does not match command fencing');
            END;

            CREATE UNIQUE INDEX idx_active_emergency_stop_scope
                ON EmergencyStops(
                    level,
                    COALESCE(barnId, ''),
                    COALESCE(feederId, '')
                ) WHERE status = 'ACTIVE';
            CREATE INDEX idx_emergency_stops_active
                ON EmergencyStops(status, level, barnId, feederId);
            CREATE INDEX idx_approval_requests_status
                ON ApprovalRequests(status, expiresAt, approvalRequestSequence);
            CREATE INDEX idx_approval_decisions_request
                ON ApprovalDecisions(approvalRequestId, approvalDecisionSequence);
            CREATE INDEX idx_resolution_cases_feeder
                ON OperatorResolutionCases(feederId, status, resolutionCaseSequence);
            CREATE INDEX idx_welfare_safety_feeder
                ON WelfareSafetyLedger(feederId, recordedAt, welfareEntrySequence);

            CREATE TRIGGER emergency_stop_identity_immutable
            BEFORE UPDATE OF emergencyStopId, level, barnId, feederId,
                             activatedBy, activatedAt ON EmergencyStops
            BEGIN
                SELECT RAISE(ABORT, 'EmergencyStop identity is immutable');
            END;
            CREATE TRIGGER emergency_stops_delete_forbidden
            BEFORE DELETE ON EmergencyStops
            BEGIN
                SELECT RAISE(ABORT, 'EmergencyStops cannot be deleted');
            END;

            CREATE TRIGGER approval_request_identity_immutable
            BEFORE UPDATE OF approvalRequestId, actionType, requestedBy,
                             targetType, targetId, barnId, feederId,
                             requiredAuthoritiesJson, actionPayloadJson,
                             createdAt, expiresAt ON ApprovalRequests
            BEGIN
                SELECT RAISE(ABORT, 'ApprovalRequest identity is immutable');
            END;
            CREATE TRIGGER approval_requests_delete_forbidden
            BEFORE DELETE ON ApprovalRequests
            BEGIN
                SELECT RAISE(ABORT, 'ApprovalRequests cannot be deleted');
            END;

            CREATE TRIGGER approval_decisions_append_only_update
            BEFORE UPDATE ON ApprovalDecisions
            BEGIN
                SELECT RAISE(ABORT, 'ApprovalDecisions are append-only');
            END;
            CREATE TRIGGER approval_decisions_append_only_delete
            BEFORE DELETE ON ApprovalDecisions
            BEGIN
                SELECT RAISE(ABORT, 'ApprovalDecisions are append-only');
            END;
            CREATE TRIGGER approval_history_append_only_update
            BEFORE UPDATE ON ApprovalRequestHistory
            BEGIN
                SELECT RAISE(ABORT, 'ApprovalRequestHistory is append-only');
            END;
            CREATE TRIGGER approval_history_append_only_delete
            BEFORE DELETE ON ApprovalRequestHistory
            BEGIN
                SELECT RAISE(ABORT, 'ApprovalRequestHistory is append-only');
            END;
            CREATE TRIGGER resolution_case_identity_immutable
            BEFORE UPDATE OF resolutionCaseId, eventId, commandId, barnId,
                             feederId, deviceId, caseType, createdAt
            ON OperatorResolutionCases
            BEGIN
                SELECT RAISE(ABORT, 'OperatorResolutionCase identity is immutable');
            END;
            CREATE TRIGGER resolution_cases_delete_forbidden
            BEFORE DELETE ON OperatorResolutionCases
            BEGIN
                SELECT RAISE(ABORT, 'OperatorResolutionCases cannot be deleted');
            END;
            CREATE TRIGGER welfare_safety_ledger_append_only_update
            BEFORE UPDATE ON WelfareSafetyLedger
            BEGIN
                SELECT RAISE(ABORT, 'WelfareSafetyLedger is append-only');
            END;
            CREATE TRIGGER welfare_safety_ledger_append_only_delete
            BEFORE DELETE ON WelfareSafetyLedger
            BEGIN
                SELECT RAISE(ABORT, 'WelfareSafetyLedger is append-only');
            END;
        `);
    }
});
