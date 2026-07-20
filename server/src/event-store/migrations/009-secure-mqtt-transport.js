export const migration009SecureMqttTransport = Object.freeze({
    version: 9,
    name: "secure_mqtt_transport",
    up(database) {
        database.exec(`
            ALTER TABLE SimulatedControllers ADD COLUMN controllerBootId TEXT;
            ALTER TABLE SimulatedControllers
                ADD COLUMN bootCounter INTEGER NOT NULL DEFAULT 0
                CHECK (bootCounter >= 0);
            ALTER TABLE SimulatedControllers ADD COLUMN lastHeartbeatReceivedAt TEXT;
            ALTER TABLE SimulatedControllers ADD COLUMN statusExpiresAt TEXT;
            ALTER TABLE SimulatedControllers ADD COLUMN revokedAt TEXT;
            ALTER TABLE SimulatedControllers
                ADD COLUMN lastControllerSequence INTEGER NOT NULL DEFAULT 0
                CHECK (lastControllerSequence >= 0);

            ALTER TABLE SimulatedControllerFeederAssignments
                ADD COLUMN assignmentGeneration INTEGER NOT NULL DEFAULT 1
                CHECK (assignmentGeneration > 0);
            ALTER TABLE SimulatedControllerFeederAssignments
                ADD COLUMN authorityLeaseExpiresAt TEXT;
            ALTER TABLE SimulatedControllerFeederAssignments ADD COLUMN updatedAt TEXT;

            UPDATE SimulatedControllerFeederAssignments
            SET authorityLeaseExpiresAt = datetime(createdAt, '+1 day'),
                updatedAt = createdAt
            WHERE authorityLeaseExpiresAt IS NULL;

            ALTER TABLE SimulatedControllerCommandJournal
                ADD COLUMN assignmentGeneration INTEGER NOT NULL DEFAULT 1
                CHECK (assignmentGeneration > 0);
            ALTER TABLE SimulatedControllerCommandJournal
                ADD COLUMN acknowledgementDeliverySucceeded INTEGER
                CHECK (acknowledgementDeliverySucceeded IN (0, 1));
            ALTER TABLE SimulatedControllerCommandJournal
                ADD COLUMN reconciliationState TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (reconciliationState IN (
                    'PENDING', 'DELIVERED', 'RECONCILED', 'OUTCOME_UNKNOWN'
                ));
            ALTER TABLE SimulatedControllerCommandJournal ADD COLUMN commandAction TEXT;
            ALTER TABLE SimulatedControllerCommandJournal
                ADD COLUMN commandParametersJson TEXT NOT NULL DEFAULT 'null';
            ALTER TABLE SimulatedControllerCommandJournal ADD COLUMN evidenceAt TEXT;
            ALTER TABLE SimulatedControllerCommandJournal ADD COLUMN controllerBootId TEXT;

            CREATE TABLE ControllerAssignmentHistory (
                assignmentHistorySequence INTEGER PRIMARY KEY AUTOINCREMENT,
                controllerId TEXT NOT NULL,
                barnId TEXT NOT NULL,
                feederId TEXT NOT NULL,
                assignmentGeneration INTEGER NOT NULL CHECK (assignmentGeneration > 0),
                assignmentStatus TEXT NOT NULL
                    CHECK (assignmentStatus IN ('ACTIVE', 'DISABLED', 'REPLACED')),
                authorityLeaseExpiresAt TEXT,
                reason TEXT NOT NULL,
                approvalRequestId TEXT,
                occurredAt TEXT NOT NULL,
                FOREIGN KEY (controllerId)
                    REFERENCES SimulatedControllers(controllerId) ON DELETE RESTRICT,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT,
                FOREIGN KEY (feederId) REFERENCES Feeders(feederId) ON DELETE RESTRICT
            ) STRICT;

            INSERT INTO ControllerAssignmentHistory (
                controllerId, barnId, feederId, assignmentGeneration,
                assignmentStatus, authorityLeaseExpiresAt, reason, occurredAt
            )
            SELECT controllerId, barnId, feederId, assignmentGeneration,
                   'ACTIVE', authorityLeaseExpiresAt, 'MIGRATED_PHASE_7C_ASSIGNMENT',
                   COALESCE(updatedAt, createdAt)
            FROM SimulatedControllerFeederAssignments;

            CREATE TABLE MqttOutboundDeliveries (
                deliverySequence INTEGER PRIMARY KEY AUTOINCREMENT,
                deliveryId TEXT NOT NULL UNIQUE,
                commandId TEXT NOT NULL,
                controllerId TEXT NOT NULL,
                assignmentGeneration INTEGER NOT NULL CHECK (assignmentGeneration > 0),
                topic TEXT NOT NULL,
                publishedAt TEXT NOT NULL,
                brokerAcknowledgedAt TEXT,
                state TEXT NOT NULL
                    CHECK (state IN ('PUBLISHING', 'BROKER_ACKNOWLEDGED', 'FAILED')),
                failureCode TEXT,
                FOREIGN KEY (commandId)
                    REFERENCES DeviceCommands(commandId) ON DELETE RESTRICT,
                FOREIGN KEY (controllerId)
                    REFERENCES SimulatedControllers(controllerId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE MqttInboundMessages (
                inboundSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                controllerId TEXT NOT NULL,
                messageType TEXT NOT NULL,
                messageId TEXT NOT NULL,
                controllerBootId TEXT,
                controllerSequence INTEGER,
                receivedAt TEXT NOT NULL,
                duplicateCount INTEGER NOT NULL DEFAULT 0 CHECK (duplicateCount >= 0),
                UNIQUE (controllerId, messageType, messageId),
                FOREIGN KEY (controllerId)
                    REFERENCES SimulatedControllers(controllerId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE MqttProtocolEvents (
                protocolEventSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR')),
                eventType TEXT NOT NULL,
                code TEXT,
                controllerId TEXT,
                commandId TEXT,
                topic TEXT,
                occurredAt TEXT NOT NULL,
                detailsJson TEXT NOT NULL DEFAULT 'null'
            ) STRICT;

            CREATE TABLE MqttSafetyStates (
                scopeKey TEXT PRIMARY KEY,
                level TEXT NOT NULL CHECK (level IN ('PLATFORM', 'BARN', 'FEEDER')),
                barnId TEXT,
                feederId TEXT,
                generation INTEGER NOT NULL CHECK (generation > 0),
                active INTEGER NOT NULL CHECK (active IN (0, 1)),
                reason TEXT,
                updatedAt TEXT NOT NULL,
                CHECK (
                    (level = 'PLATFORM' AND barnId IS NULL AND feederId IS NULL)
                    OR (level = 'BARN' AND barnId IS NOT NULL AND feederId IS NULL)
                    OR (level = 'FEEDER' AND feederId IS NOT NULL)
                )
            ) STRICT, WITHOUT ROWID;

            CREATE INDEX idx_assignment_history_feeder
                ON ControllerAssignmentHistory(feederId, assignmentGeneration DESC);
            CREATE INDEX idx_mqtt_deliveries_command
                ON MqttOutboundDeliveries(commandId, deliverySequence DESC);
            CREATE INDEX idx_mqtt_protocol_events_recent
                ON MqttProtocolEvents(protocolEventSequence DESC);
            CREATE INDEX idx_mqtt_inbound_controller
                ON MqttInboundMessages(controllerId, inboundSequence DESC);

            CREATE TRIGGER controller_assignment_validate_update
            BEFORE UPDATE OF controllerId, barnId, feederId
            ON SimulatedControllerFeederAssignments
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

            CREATE TRIGGER assignment_history_append_only_update
            BEFORE UPDATE ON ControllerAssignmentHistory
            BEGIN
                SELECT RAISE(ABORT, 'Controller assignment history is append-only');
            END;
            CREATE TRIGGER assignment_history_append_only_delete
            BEFORE DELETE ON ControllerAssignmentHistory
            BEGIN
                SELECT RAISE(ABORT, 'Controller assignment history is append-only');
            END;
            CREATE TRIGGER mqtt_protocol_events_append_only_update
            BEFORE UPDATE ON MqttProtocolEvents
            BEGIN
                SELECT RAISE(ABORT, 'MQTT protocol events are append-only');
            END;
            CREATE TRIGGER mqtt_protocol_events_append_only_delete
            BEFORE DELETE ON MqttProtocolEvents
            BEGIN
                SELECT RAISE(ABORT, 'MQTT protocol events are append-only');
            END;
        `);
    }
});
