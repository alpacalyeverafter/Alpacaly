import { DEFAULT_SIMULATED_CONTROLLER_ID } from "../../domain/device-controllers.js";
import { DEFAULT_RESOURCE_IDS } from "../../domain/resources.js";

const executionStates = [
    "RECEIVED", "ACCEPTED", "STARTED", "COMPLETED",
    "REJECTED", "FAILED", "OUTCOME_UNKNOWN"
].map(value => `'${value}'`).join(", ");

export const migration008SimulatedDeviceControllers = Object.freeze({
    version: 8,
    name: "simulated_device_controllers",
    up(database) {
        database.exec(`
            CREATE TABLE SimulatedControllers (
                controllerSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                controllerId TEXT NOT NULL UNIQUE,
                barnId TEXT NOT NULL,
                name TEXT NOT NULL,
                enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                softwareVersion TEXT NOT NULL,
                protocolVersion TEXT NOT NULL,
                lastSeenAt TEXT,
                connectionState TEXT NOT NULL
                    CHECK (connectionState IN ('ONLINE', 'OFFLINE')),
                simulationBehaviourJson TEXT NOT NULL DEFAULT
                    '{"mode":"NORMAL","acknowledgementDelayMs":0,"completionDelayMs":0}',
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE SimulatedControllerFeederAssignments (
                controllerId TEXT NOT NULL,
                barnId TEXT NOT NULL,
                feederId TEXT NOT NULL UNIQUE,
                createdAt TEXT NOT NULL,
                PRIMARY KEY (controllerId, feederId),
                FOREIGN KEY (controllerId)
                    REFERENCES SimulatedControllers(controllerId) ON DELETE RESTRICT,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT,
                FOREIGN KEY (feederId) REFERENCES Feeders(feederId) ON DELETE RESTRICT
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE SimulatedControllerCommandJournal (
                journalSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                journalId TEXT NOT NULL UNIQUE,
                controllerId TEXT NOT NULL,
                commandId TEXT NOT NULL UNIQUE,
                barnId TEXT NOT NULL,
                feederId TEXT NOT NULL,
                deviceId TEXT NOT NULL,
                fencingToken INTEGER NOT NULL CHECK (fencingToken > 0),
                executionState TEXT NOT NULL CHECK (executionState IN (${executionStates})),
                dispensePerformed INTEGER NOT NULL DEFAULT 0
                    CHECK (dispensePerformed IN (0, 1)),
                receivedAt TEXT NOT NULL,
                acceptedAt TEXT,
                startedAt TEXT,
                completedAt TEXT,
                updatedAt TEXT NOT NULL,
                finalAcknowledgementJson TEXT,
                failureReason TEXT,
                FOREIGN KEY (controllerId)
                    REFERENCES SimulatedControllers(controllerId) ON DELETE RESTRICT,
                FOREIGN KEY (commandId)
                    REFERENCES DeviceCommands(commandId) ON DELETE RESTRICT,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT,
                FOREIGN KEY (feederId) REFERENCES Feeders(feederId) ON DELETE RESTRICT,
                FOREIGN KEY (deviceId) REFERENCES Devices(deviceId) ON DELETE RESTRICT,
                UNIQUE (controllerId, feederId, fencingToken)
            ) STRICT;

            CREATE TABLE SimulatedControllerJournalHistory (
                historySequence INTEGER PRIMARY KEY AUTOINCREMENT,
                journalId TEXT NOT NULL,
                fromState TEXT,
                toState TEXT NOT NULL CHECK (toState IN (${executionStates})),
                timestamp TEXT NOT NULL,
                detailsJson TEXT NOT NULL DEFAULT 'null',
                FOREIGN KEY (journalId)
                    REFERENCES SimulatedControllerCommandJournal(journalId)
                    ON DELETE RESTRICT
            ) STRICT;

            CREATE INDEX idx_simulated_controllers_barn
                ON SimulatedControllers(barnId, enabled, connectionState);
            CREATE INDEX idx_controller_assignments_controller
                ON SimulatedControllerFeederAssignments(controllerId, feederId);
            CREATE INDEX idx_controller_journal_recent
                ON SimulatedControllerCommandJournal(
                    controllerId, journalSequence DESC
                );

            CREATE TRIGGER simulated_controller_identity_immutable
            BEFORE UPDATE OF controllerId, barnId, createdAt
            ON SimulatedControllers
            BEGIN
                SELECT RAISE(ABORT, 'SimulatedController identity is immutable');
            END;

            CREATE TRIGGER controller_assignment_validate_barn
            BEFORE INSERT ON SimulatedControllerFeederAssignments
            WHEN NOT EXISTS (
                SELECT 1
                FROM SimulatedControllers AS controller
                JOIN Feeders AS feeder ON feeder.feederId = NEW.feederId
                WHERE controller.controllerId = NEW.controllerId
                  AND controller.barnId = NEW.barnId
                  AND feeder.barnId = NEW.barnId
            )
            BEGIN
                SELECT RAISE(ABORT, 'Controller and Feeder must belong to the same Barn');
            END;

            CREATE TRIGGER controller_journal_validate_command
            BEFORE INSERT ON SimulatedControllerCommandJournal
            WHEN NOT EXISTS (
                SELECT 1
                FROM DeviceCommands AS command
                JOIN SimulatedControllerFeederAssignments AS assignment
                  ON assignment.controllerId = NEW.controllerId
                 AND assignment.barnId = NEW.barnId
                 AND assignment.feederId = NEW.feederId
                WHERE command.commandId = NEW.commandId
                  AND command.barnId = NEW.barnId
                  AND command.feederId = NEW.feederId
                  AND command.deviceId = NEW.deviceId
                  AND command.fencingToken = NEW.fencingToken
            )
            BEGIN
                SELECT RAISE(ABORT, 'Controller journal does not match command resources');
            END;

            CREATE TRIGGER controller_journal_identity_immutable
            BEFORE UPDATE OF journalId, controllerId, commandId, barnId,
                             feederId, deviceId, fencingToken, receivedAt
            ON SimulatedControllerCommandJournal
            BEGIN
                SELECT RAISE(ABORT, 'Controller journal identity is immutable');
            END;

            CREATE TRIGGER controller_journal_history_append_only_update
            BEFORE UPDATE ON SimulatedControllerJournalHistory
            BEGIN
                SELECT RAISE(ABORT, 'Controller journal history is append-only');
            END;

        `);

        const createdAt = "2026-07-20T00:00:00.000Z";
        database.prepare(`
            INSERT OR IGNORE INTO SimulatedControllers (
                controllerId, barnId, name, enabled, softwareVersion,
                protocolVersion, lastSeenAt, connectionState,
                simulationBehaviourJson, createdAt, updatedAt
            ) VALUES (?, ?, ?, 1, ?, ?, ?, 'ONLINE', ?, ?, ?)
        `).run(
            DEFAULT_SIMULATED_CONTROLLER_ID,
            DEFAULT_RESOURCE_IDS.barnId,
            "Default Barn Simulated Controller",
            "phase-7c-simulator",
            "1.0",
            createdAt,
            JSON.stringify({
                mode: "NORMAL",
                acknowledgementDelayMs: 0,
                completionDelayMs: 0
            }),
            createdAt,
            createdAt
        );
        database.prepare(`
            INSERT OR IGNORE INTO SimulatedControllerFeederAssignments (
                controllerId, barnId, feederId, createdAt
            ) VALUES (?, ?, ?, ?)
        `).run(
            DEFAULT_SIMULATED_CONTROLLER_ID,
            DEFAULT_RESOURCE_IDS.barnId,
            DEFAULT_RESOURCE_IDS.feederId,
            createdAt
        );
    }
});
