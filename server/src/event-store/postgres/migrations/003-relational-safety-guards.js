export const migration003RelationalSafetyGuards = Object.freeze({
    version: 3,
    name: "relational_safety_guards",
    sql: `
        ALTER TABLE OperatorResolutionCases
            ADD CONSTRAINT resolution_case_command_fk
            FOREIGN KEY (commandId) REFERENCES DeviceCommands(commandId)
            ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
        ALTER TABLE OperatorResolutionCases
            ADD CONSTRAINT resolution_case_replacement_command_fk
            FOREIGN KEY (replacementCommandId) REFERENCES DeviceCommands(commandId)
            ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
        ALTER TABLE OperatorResolutionCases
            ADD CONSTRAINT resolution_case_approval_fk
            FOREIGN KEY (approvalRequestId) REFERENCES ApprovalRequests(approvalRequestId)
            ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
        ALTER TABLE EmergencyStops
            ADD CONSTRAINT emergency_stop_clearance_approval_fk
            FOREIGN KEY (clearanceApprovalRequestId)
            REFERENCES ApprovalRequests(approvalRequestId)
            ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
        ALTER TABLE ControllerAssignmentHistory
            ADD CONSTRAINT controller_assignment_approval_fk
            FOREIGN KEY (approvalRequestId) REFERENCES ApprovalRequests(approvalRequestId)
            ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

        CREATE OR REPLACE FUNCTION alpacaly_validate_event()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM Queues q
                WHERE q.queueId = NEW.queueId
                  AND q.barnId = NEW.barnId
                  AND q.feederId = NEW.feederId
            ) THEN
                RAISE EXCEPTION 'Event resources do not belong together'
                    USING ERRCODE = 'foreign_key_violation';
            END IF;
            IF NOT EXISTS (
                SELECT 1
                FROM Contributions c
                JOIN ProviderEvents p ON p.providerEventId = c.providerEventId
                WHERE c.contributionId = NEW.contributionId
                  AND c.eligibilityStatus = 'ELIGIBLE'
                  AND c.feedQuantity > 0
                  AND p.verificationStatus = 'VERIFIED'
            ) THEN
                RAISE EXCEPTION 'Event requires a verified eligible Contribution'
                    USING ERRCODE = 'check_violation';
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM FeedIntents i
                WHERE i.feedIntentId = NEW.feedIntentId
                  AND i.contributionId = NEW.contributionId
                  AND i.barnId = NEW.barnId
                  AND i.feederId = NEW.feederId
                  AND i.queueId = NEW.queueId
                  AND i.status = 'PROCESSING'
                  AND EXISTS (
                      SELECT 1 FROM Outbox o
                      WHERE o.feedIntentId = i.feedIntentId
                        AND o.status = 'PROCESSING'
                  )
            ) THEN
                RAISE EXCEPTION 'Event does not match its claimed FeedIntent'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$;
        CREATE TRIGGER events_validate_relations
            BEFORE INSERT OR UPDATE ON Events FOR EACH ROW
            EXECUTE FUNCTION alpacaly_validate_event();

        CREATE OR REPLACE FUNCTION alpacaly_validate_queue_entry()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM Events e
                WHERE e.eventId = NEW.eventId AND e.queueId = NEW.queueId
            ) THEN
                RAISE EXCEPTION 'Queue entry does not match Event queue'
                    USING ERRCODE = 'foreign_key_violation';
            END IF;
            RETURN NEW;
        END;
        $$;
        CREATE TRIGGER queue_validate_event_resource
            BEFORE INSERT OR UPDATE ON Queue FOR EACH ROW
            EXECUTE FUNCTION alpacaly_validate_queue_entry();

        CREATE OR REPLACE FUNCTION alpacaly_validate_feeder_device_assignment()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM Feeders f
                JOIN Devices d ON d.deviceId = NEW.deviceId
                WHERE f.feederId = NEW.feederId
                  AND f.barnId = NEW.barnId
                  AND d.barnId = NEW.barnId
            ) THEN
                RAISE EXCEPTION 'Feeder and Device must belong to the same Barn'
                    USING ERRCODE = 'foreign_key_violation';
            END IF;
            RETURN NEW;
        END;
        $$;
        CREATE TRIGGER feeder_device_assignment_validate
            BEFORE INSERT OR UPDATE ON FeederDeviceAssignments FOR EACH ROW
            EXECUTE FUNCTION alpacaly_validate_feeder_device_assignment();

        CREATE OR REPLACE FUNCTION alpacaly_validate_device_command()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM Events e
                JOIN FeederDeviceAssignments a
                  ON a.feederId = NEW.feederId
                 AND a.deviceId = NEW.deviceId
                 AND a.barnId = NEW.barnId
                WHERE e.eventId = NEW.eventId
                  AND e.barnId = NEW.barnId
                  AND e.feederId = NEW.feederId
            ) THEN
                RAISE EXCEPTION 'DeviceCommand resources do not match its Event'
                    USING ERRCODE = 'foreign_key_violation';
            END IF;
            RETURN NEW;
        END;
        $$;
        CREATE TRIGGER device_command_validate_resources
            BEFORE INSERT ON DeviceCommands FOR EACH ROW
            EXECUTE FUNCTION alpacaly_validate_device_command();

        CREATE OR REPLACE FUNCTION alpacaly_validate_device_acknowledgement()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM DeviceCommands c
                WHERE c.commandId = NEW.commandId AND c.deviceId = NEW.deviceId
            ) THEN
                RAISE EXCEPTION 'DeviceAcknowledgement device does not match command'
                    USING ERRCODE = 'foreign_key_violation';
            END IF;
            RETURN NEW;
        END;
        $$;
        CREATE TRIGGER device_acknowledgement_validate_device
            BEFORE INSERT ON DeviceAcknowledgements FOR EACH ROW
            EXECUTE FUNCTION alpacaly_validate_device_acknowledgement();

        CREATE OR REPLACE FUNCTION alpacaly_validate_simulated_execution()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM DeviceCommands c
                WHERE c.commandId = NEW.commandId
                  AND c.deviceId = NEW.deviceId
                  AND c.fencingToken = NEW.fencingToken
            ) THEN
                RAISE EXCEPTION 'Simulated execution does not match command fencing'
                    USING ERRCODE = 'foreign_key_violation';
            END IF;
            RETURN NEW;
        END;
        $$;
        CREATE TRIGGER simulated_execution_validate_command
            BEFORE INSERT ON SimulatedDeviceExecutions FOR EACH ROW
            EXECUTE FUNCTION alpacaly_validate_simulated_execution();

        CREATE OR REPLACE FUNCTION alpacaly_validate_controller_assignment()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM SimulatedControllers c
                JOIN Feeders f ON f.feederId = NEW.feederId
                WHERE c.controllerId = NEW.controllerId
                  AND c.barnId = NEW.barnId
                  AND f.barnId = NEW.barnId
            ) THEN
                RAISE EXCEPTION 'Controller and Feeder must belong to the same Barn'
                    USING ERRCODE = 'foreign_key_violation';
            END IF;
            RETURN NEW;
        END;
        $$;
        CREATE TRIGGER controller_assignment_validate_barn
            BEFORE INSERT OR UPDATE ON SimulatedControllerFeederAssignments FOR EACH ROW
            EXECUTE FUNCTION alpacaly_validate_controller_assignment();

        CREATE OR REPLACE FUNCTION alpacaly_validate_controller_journal()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM DeviceCommands c
                JOIN SimulatedControllerFeederAssignments a
                  ON a.controllerId = NEW.controllerId
                 AND a.barnId = NEW.barnId
                 AND a.feederId = NEW.feederId
                WHERE c.commandId = NEW.commandId
                  AND c.barnId = NEW.barnId
                  AND c.feederId = NEW.feederId
                  AND c.deviceId = NEW.deviceId
                  AND c.fencingToken = NEW.fencingToken
            ) THEN
                RAISE EXCEPTION 'Controller journal does not match command resources'
                    USING ERRCODE = 'foreign_key_violation';
            END IF;
            RETURN NEW;
        END;
        $$;
        CREATE TRIGGER controller_journal_validate_command
            BEFORE INSERT ON SimulatedControllerCommandJournal FOR EACH ROW
            EXECUTE FUNCTION alpacaly_validate_controller_journal();

        CREATE OR REPLACE FUNCTION alpacaly_validate_barn_scope()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM RoleAssignments r
                WHERE r.roleAssignmentId = NEW.roleAssignmentId
                  AND r.administratorId = NEW.administratorId
                  AND r.platformWide = 0
            ) THEN
                RAISE EXCEPTION 'BarnScope requires an active barn-scoped RoleAssignment'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$;
        CREATE TRIGGER barn_scope_validate_assignment
            BEFORE INSERT OR UPDATE ON BarnScopes FOR EACH ROW
            EXECUTE FUNCTION alpacaly_validate_barn_scope();

        CREATE OR REPLACE FUNCTION alpacaly_protect_verified_provider_event()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF OLD.verificationStatus = 'VERIFIED'
               AND NEW.verificationStatus <> 'VERIFIED' THEN
                RAISE EXCEPTION 'Verified ProviderEvent cannot be downgraded'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$;
        CREATE TRIGGER provider_events_verified_immutable
            BEFORE UPDATE ON ProviderEvents FOR EACH ROW
            EXECUTE FUNCTION alpacaly_protect_verified_provider_event();

        CREATE OR REPLACE FUNCTION alpacaly_protect_used_contribution()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM Events e WHERE e.contributionId = OLD.contributionId
            ) AND (
                OLD.eligibilityStatus IS DISTINCT FROM NEW.eligibilityStatus
                OR OLD.feedQuantity IS DISTINCT FROM NEW.feedQuantity
            ) THEN
                RAISE EXCEPTION 'Used Contribution eligibility is immutable'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$;
        CREATE TRIGGER contributions_feed_eligibility_immutable
            BEFORE UPDATE ON Contributions FOR EACH ROW
            EXECUTE FUNCTION alpacaly_protect_used_contribution();
    `
});
