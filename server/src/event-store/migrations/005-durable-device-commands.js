import {
    DEFAULT_DEVICE_ID,
    DEFAULT_RESOURCES,
    DEFAULT_RESOURCE_IDS
} from "../../domain/resources.js";

const commandStates = [
    "PENDING",
    "READY",
    "SENT",
    "ACKNOWLEDGED",
    "RETRY_SCHEDULED",
    "TIMED_OUT",
    "FAILED",
    "OUTCOME_UNKNOWN",
    "CANCELLED"
].map(value => `'${value}'`).join(", ");

const commandTypes = [
    "RING_BELL",
    "DISPENSE_FEED"
].map(value => `'${value}'`).join(", ");

const acknowledgementResults = [
    "ACCEPTED",
    "STARTED",
    "SUCCEEDED",
    "REJECTED",
    "FAILED"
].map(value => `'${value}'`).join(", ");

export const migration005DurableDeviceCommands = Object.freeze({
    version: 5,
    name: "durable_device_commands",
    up(database) {
        database.exec(`
            CREATE TABLE FeederDeviceAssignments (
                feederId TEXT PRIMARY KEY,
                barnId TEXT NOT NULL,
                deviceId TEXT NOT NULL UNIQUE,
                createdAt TEXT NOT NULL,
                FOREIGN KEY (feederId) REFERENCES Feeders(feederId) ON DELETE RESTRICT,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT,
                FOREIGN KEY (deviceId) REFERENCES Devices(deviceId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE DeviceCommands (
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
                FOREIGN KEY (eventId) REFERENCES Events(eventId) ON DELETE CASCADE,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT,
                FOREIGN KEY (feederId) REFERENCES Feeders(feederId) ON DELETE RESTRICT,
                FOREIGN KEY (deviceId) REFERENCES Devices(deviceId) ON DELETE RESTRICT,
                UNIQUE (eventId, commandType),
                UNIQUE (feederId, fencingToken)
            ) STRICT;

            CREATE TABLE DeviceCommandOutbox (
                outboxSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                commandId TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL
                    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED')),
                availableAt TEXT NOT NULL,
                claimedAt TEXT,
                completedAt TEXT,
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL,
                FOREIGN KEY (commandId)
                    REFERENCES DeviceCommands(commandId) ON DELETE CASCADE
            ) STRICT;

            CREATE TABLE DeviceAcknowledgements (
                acknowledgementSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                acknowledgementId TEXT NOT NULL UNIQUE,
                commandId TEXT NOT NULL,
                deviceId TEXT NOT NULL,
                acknowledgementType TEXT NOT NULL,
                receivedAt TEXT NOT NULL,
                deviceTimestamp TEXT NOT NULL,
                result TEXT NOT NULL CHECK (result IN (${acknowledgementResults})),
                measuredQuantity REAL,
                errorCode TEXT,
                errorMessage TEXT,
                metadataJson TEXT NOT NULL DEFAULT 'null',
                FOREIGN KEY (commandId)
                    REFERENCES DeviceCommands(commandId) ON DELETE CASCADE,
                FOREIGN KEY (deviceId) REFERENCES Devices(deviceId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE DeviceCommandHistory (
                historySequence INTEGER PRIMARY KEY AUTOINCREMENT,
                commandId TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                fromStatus TEXT,
                toStatus TEXT NOT NULL CHECK (toStatus IN (${commandStates})),
                timestamp TEXT NOT NULL,
                detailsJson TEXT NOT NULL DEFAULT 'null',
                FOREIGN KEY (commandId)
                    REFERENCES DeviceCommands(commandId) ON DELETE CASCADE,
                UNIQUE (commandId, ordinal)
            ) STRICT;

            CREATE TABLE DeviceCommandAuditRecords (
                auditSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                auditRecordId TEXT NOT NULL UNIQUE,
                commandId TEXT NOT NULL,
                acknowledgementId TEXT,
                action TEXT NOT NULL,
                occurredAt TEXT NOT NULL,
                detailsJson TEXT NOT NULL DEFAULT 'null',
                FOREIGN KEY (commandId)
                    REFERENCES DeviceCommands(commandId) ON DELETE CASCADE,
                FOREIGN KEY (acknowledgementId)
                    REFERENCES DeviceAcknowledgements(acknowledgementId) ON DELETE CASCADE
            ) STRICT;

            CREATE TABLE SimulatedDeviceExecutions (
                commandId TEXT PRIMARY KEY,
                deviceId TEXT NOT NULL,
                fencingToken INTEGER NOT NULL,
                performedAt TEXT NOT NULL,
                acknowledgementJson TEXT NOT NULL,
                actionCount INTEGER NOT NULL DEFAULT 1 CHECK (actionCount = 1),
                FOREIGN KEY (commandId)
                    REFERENCES DeviceCommands(commandId) ON DELETE CASCADE,
                FOREIGN KEY (deviceId) REFERENCES Devices(deviceId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE SimulatedDeviceFences (
                deviceId TEXT PRIMARY KEY,
                highestFencingToken INTEGER NOT NULL
                    CHECK (highestFencingToken > 0),
                updatedAt TEXT NOT NULL,
                FOREIGN KEY (deviceId) REFERENCES Devices(deviceId) ON DELETE RESTRICT
            ) STRICT;
        `);

        database.prepare(`
            INSERT OR IGNORE INTO Devices (deviceId, barnId, name, kind, createdAt)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            DEFAULT_RESOURCES.device.deviceId,
            DEFAULT_RESOURCES.device.barnId,
            DEFAULT_RESOURCES.device.name,
            DEFAULT_RESOURCES.device.kind,
            DEFAULT_RESOURCES.device.createdAt
        );

        database.prepare(`
            INSERT OR IGNORE INTO Devices (deviceId, barnId, name, kind, createdAt)
            SELECT
                CASE
                    WHEN feederId = ? THEN ?
                    ELSE 'device_simulated_' || feederId
                END,
                barnId,
                'Simulated controller for ' || name,
                'SIMULATED_FEEDER_CONTROLLER',
                createdAt
            FROM Feeders
        `).run(
            DEFAULT_RESOURCE_IDS.feederId,
            DEFAULT_DEVICE_ID
        );

        database.prepare(`
            INSERT INTO FeederDeviceAssignments (
                feederId,
                barnId,
                deviceId,
                createdAt
            )
            SELECT
                feederId,
                barnId,
                CASE
                    WHEN feederId = ? THEN ?
                    ELSE 'device_simulated_' || feederId
                END,
                createdAt
            FROM Feeders
        `).run(
            DEFAULT_RESOURCE_IDS.feederId,
            DEFAULT_DEVICE_ID
        );

        database.exec(`
            CREATE INDEX idx_device_commands_ready
                ON DeviceCommands(status, nextAttemptAt, commandSequence);
            CREATE INDEX idx_device_commands_event
                ON DeviceCommands(eventId, commandType);
            CREATE INDEX idx_device_commands_feeder
                ON DeviceCommands(feederId, commandSequence);
            CREATE INDEX idx_device_command_outbox_ready
                ON DeviceCommandOutbox(status, availableAt, outboxSequence);
            CREATE INDEX idx_device_acknowledgements_command
                ON DeviceAcknowledgements(commandId, acknowledgementSequence);
            CREATE INDEX idx_device_command_history_command
                ON DeviceCommandHistory(commandId, ordinal);
            CREATE INDEX idx_device_command_audit_command
                ON DeviceCommandAuditRecords(commandId, auditSequence);

            CREATE TRIGGER feeder_device_assignment_validate_insert
            BEFORE INSERT ON FeederDeviceAssignments
            WHEN NOT EXISTS (
                SELECT 1
                FROM Feeders AS feeder
                JOIN Devices AS device ON device.deviceId = NEW.deviceId
                WHERE feeder.feederId = NEW.feederId
                  AND feeder.barnId = NEW.barnId
                  AND device.barnId = NEW.barnId
            )
            BEGIN
                SELECT RAISE(ABORT, 'Feeder and Device must belong to the same Barn');
            END;

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
                             commandType, idempotencyKey, fencingToken
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
        `);
    }
});
