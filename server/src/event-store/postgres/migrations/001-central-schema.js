export const migration001CentralSchema = Object.freeze({
    version: 1,
    name: "central_schema_equivalent_to_sqlite_v10",
    sql: `
        CREATE TABLE Barns (
            barnId TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            timezone TEXT NOT NULL,
            createdAt TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE Feeders (
            feederId TEXT PRIMARY KEY,
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            name TEXT NOT NULL,
            createdAt TIMESTAMPTZ NOT NULL,
            operationalStatus TEXT NOT NULL DEFAULT 'AVAILABLE'
                CHECK (operationalStatus IN (
                    'AVAILABLE', 'PAUSED', 'WELFARE_UNAVAILABLE', 'MAINTENANCE'
                )),
            operationalReason TEXT,
            operationalUpdatedAt TIMESTAMPTZ,
            safetyStatus TEXT NOT NULL DEFAULT 'ONLINE'
                CHECK (safetyStatus IN (
                    'ONLINE', 'OFFLINE', 'DEGRADED', 'PAUSED', 'MAINTENANCE',
                    'EMERGENCY_STOPPED', 'BLOCKED_OUTCOME_UNKNOWN', 'UNKNOWN'
                )),
            safetyReason TEXT,
            safetyUpdatedAt TIMESTAMPTZ,
            UNIQUE (feederId, barnId)
        );

        CREATE TABLE Cameras (
            cameraId TEXT PRIMARY KEY,
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            name TEXT NOT NULL,
            createdAt TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE Devices (
            deviceId TEXT PRIMARY KEY,
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            createdAt TIMESTAMPTZ NOT NULL,
            operationalStatus TEXT NOT NULL DEFAULT 'AVAILABLE'
                CHECK (operationalStatus IN ('AVAILABLE', 'PAUSED', 'MAINTENANCE')),
            operationalReason TEXT,
            operationalUpdatedAt TIMESTAMPTZ
        );

        CREATE TABLE Queues (
            queueId TEXT PRIMARY KEY,
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            feederId TEXT NOT NULL UNIQUE,
            resourceType TEXT NOT NULL CHECK (resourceType = 'FEEDER'),
            resourceId TEXT NOT NULL,
            name TEXT NOT NULL,
            createdAt TIMESTAMPTZ NOT NULL,
            FOREIGN KEY (feederId, barnId)
                REFERENCES Feeders(feederId, barnId) ON DELETE RESTRICT,
            UNIQUE (resourceType, resourceId),
            CHECK (resourceId = feederId)
        );

        CREATE TABLE DailyFeedReservations (
            queueId TEXT NOT NULL REFERENCES Queues(queueId) ON DELETE RESTRICT,
            dateKey TEXT NOT NULL,
            acceptedCount INTEGER NOT NULL CHECK (acceptedCount >= 0),
            updatedAt TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (queueId, dateKey)
        );

        CREATE TABLE ProviderEvents (
            providerEventId TEXT PRIMARY KEY,
            provider TEXT NOT NULL CHECK (provider IN (
                'WEBSITE', 'STRIPE', 'YOUTUBE', 'TIKTOK', 'FACEBOOK',
                'QR_CODE', 'MANUAL_ADMIN', 'CORPORATE_SPONSOR', 'FUTURE_API'
            )),
            externalEventId TEXT NOT NULL,
            receivedAt TIMESTAMPTZ NOT NULL,
            verificationStatus TEXT NOT NULL
                CHECK (verificationStatus IN ('PENDING', 'VERIFIED', 'REJECTED')),
            rawMetadataJson JSONB NOT NULL DEFAULT 'null'::jsonb,
            rejectionReason TEXT,
            createdAt TIMESTAMPTZ NOT NULL,
            updatedAt TIMESTAMPTZ NOT NULL,
            UNIQUE (provider, externalEventId)
        );

        CREATE TABLE Contributions (
            contributionId TEXT PRIMARY KEY,
            providerEventId TEXT NOT NULL UNIQUE
                REFERENCES ProviderEvents(providerEventId) ON DELETE RESTRICT,
            verifiedAt TIMESTAMPTZ NOT NULL,
            amountMinor BIGINT NOT NULL CHECK (amountMinor >= 0),
            currency TEXT NOT NULL CHECK (length(currency) = 3),
            supporterDisplayName TEXT NOT NULL,
            eligibilityStatus TEXT NOT NULL
                CHECK (eligibilityStatus IN ('ELIGIBLE', 'INELIGIBLE')),
            feedQuantity INTEGER NOT NULL CHECK (feedQuantity >= 0),
            metadataJson JSONB NOT NULL DEFAULT 'null'::jsonb,
            createdAt TIMESTAMPTZ NOT NULL,
            updatedAt TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE FeedIntents (
            feedIntentId TEXT PRIMARY KEY,
            contributionId TEXT NOT NULL UNIQUE
                REFERENCES Contributions(contributionId) ON DELETE RESTRICT,
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            feederId TEXT NOT NULL REFERENCES Feeders(feederId) ON DELETE RESTRICT,
            queueId TEXT NOT NULL REFERENCES Queues(queueId) ON DELETE RESTRICT,
            message TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL
                CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
            createdAt TIMESTAMPTZ NOT NULL,
            outboxQueuedAt TIMESTAMPTZ NOT NULL,
            processingStartedAt TIMESTAMPTZ,
            feedRequestCreatedAt TIMESTAMPTZ,
            queueInsertionCompletedAt TIMESTAMPTZ,
            processingCompletedAt TIMESTAMPTZ,
            processingFailedAt TIMESTAMPTZ,
            failureReason TEXT,
            attemptCount INTEGER NOT NULL DEFAULT 0 CHECK (attemptCount >= 0),
            updatedAt TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE Outbox (
            outboxSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            outboxEntryId TEXT NOT NULL UNIQUE,
            feedIntentId TEXT NOT NULL UNIQUE
                REFERENCES FeedIntents(feedIntentId) ON DELETE RESTRICT,
            status TEXT NOT NULL
                CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
            createdAt TIMESTAMPTZ NOT NULL,
            availableAt TIMESTAMPTZ NOT NULL,
            processingStartedAt TIMESTAMPTZ,
            completedAt TIMESTAMPTZ,
            failedAt TIMESTAMPTZ,
            attemptCount INTEGER NOT NULL DEFAULT 0 CHECK (attemptCount >= 0),
            lastError TEXT,
            updatedAt TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE FeedIntentHistory (
            historySequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            feedIntentId TEXT NOT NULL
                REFERENCES FeedIntents(feedIntentId) ON DELETE RESTRICT,
            action TEXT NOT NULL CHECK (action IN (
                'FEED_INTENT_CREATED', 'OUTBOX_QUEUED', 'PROCESSING_STARTED',
                'FEED_REQUEST_CREATED', 'QUEUE_INSERTION_COMPLETED',
                'PROCESSING_COMPLETED', 'PROCESSING_FAILED', 'PROCESSING_RECOVERED'
            )),
            timestamp TIMESTAMPTZ NOT NULL,
            detailsJson JSONB NOT NULL DEFAULT 'null'::jsonb
        );

        CREATE SEQUENCE AlpacalyEventSequence AS BIGINT;

        CREATE TABLE Events (
            eventId TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            sequenceNumber BIGINT NOT NULL UNIQUE,
            supporterName TEXT NOT NULL,
            source TEXT NOT NULL,
            message TEXT NOT NULL DEFAULT '',
            clientRequestId TEXT UNIQUE,
            requestedAt TIMESTAMPTZ NOT NULL,
            updatedAt TIMESTAMPTZ NOT NULL,
            currentState TEXT NOT NULL CHECK (currentState IN (
                'RECEIVED', 'VALIDATED', 'QUEUED', 'APPROVED', 'COUNTDOWN',
                'BELL', 'DISPENSING', 'COMPLETE', 'ARCHIVED'
            )),
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            feederId TEXT NOT NULL REFERENCES Feeders(feederId) ON DELETE RESTRICT,
            queueId TEXT NOT NULL REFERENCES Queues(queueId) ON DELETE RESTRICT,
            contributionId TEXT NOT NULL REFERENCES Contributions(contributionId),
            feedIntentId TEXT NOT NULL REFERENCES FeedIntents(feedIntentId),
            safetyState TEXT,
            safetyUpdatedAt TIMESTAMPTZ
        );

        CREATE TABLE LifecycleHistory (
            historyId BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            eventId TEXT NOT NULL REFERENCES Events(eventId) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (state IN (
                'RECEIVED', 'VALIDATED', 'QUEUED', 'APPROVED', 'COUNTDOWN',
                'BELL', 'DISPENSING', 'COMPLETE', 'ARCHIVED'
            )),
            timestamp TIMESTAMPTZ NOT NULL,
            detailsJson JSONB NOT NULL DEFAULT 'null'::jsonb,
            UNIQUE (eventId, ordinal),
            UNIQUE (eventId, state)
        );

        CREATE TABLE Queue (
            eventId TEXT PRIMARY KEY REFERENCES Events(eventId) ON DELETE CASCADE,
            queueId TEXT NOT NULL REFERENCES Queues(queueId) ON DELETE RESTRICT,
            queuePosition BIGINT NOT NULL,
            enqueuedAt TIMESTAMPTZ NOT NULL,
            UNIQUE (queueId, queuePosition)
        );

        CREATE TABLE HardwareAcknowledgements (
            acknowledgementId BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            eventId TEXT NOT NULL REFERENCES Events(eventId) ON DELETE CASCADE,
            stage TEXT NOT NULL CHECK (stage IN ('BELL', 'DISPENSING')),
            status TEXT NOT NULL,
            receivedAt TIMESTAMPTZ NOT NULL,
            detailsJson JSONB NOT NULL DEFAULT 'null'::jsonb
        );

        CREATE TABLE Administrators (
            administratorId TEXT PRIMARY KEY,
            externalIdentityId TEXT NOT NULL UNIQUE,
            displayName TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
            createdAt TIMESTAMPTZ NOT NULL,
            updatedAt TIMESTAMPTZ NOT NULL,
            lastAuthenticatedAt TIMESTAMPTZ
        );

        CREATE TABLE RoleAssignments (
            roleAssignmentId TEXT PRIMARY KEY,
            administratorId TEXT NOT NULL
                REFERENCES Administrators(administratorId) ON DELETE RESTRICT,
            role TEXT NOT NULL CHECK (role IN (
                'VIEWER', 'WELFARE_OPERATOR', 'HARDWARE_OPERATOR', 'ADMINISTRATOR'
            )),
            platformWide SMALLINT NOT NULL DEFAULT 0 CHECK (platformWide IN (0, 1)),
            assignedAt TIMESTAMPTZ NOT NULL,
            revokedAt TIMESTAMPTZ
        );

        CREATE TABLE BarnScopes (
            barnScopeId TEXT PRIMARY KEY,
            roleAssignmentId TEXT NOT NULL
                REFERENCES RoleAssignments(roleAssignmentId) ON DELETE RESTRICT,
            administratorId TEXT NOT NULL
                REFERENCES Administrators(administratorId) ON DELETE RESTRICT,
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            assignedAt TIMESTAMPTZ NOT NULL,
            revokedAt TIMESTAMPTZ
        );

        CREATE TABLE OperatorAuditRecords (
            auditSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            auditRecordId TEXT NOT NULL UNIQUE,
            administratorId TEXT
                REFERENCES Administrators(administratorId) ON DELETE RESTRICT,
            effectiveRole TEXT CHECK (
                effectiveRole IS NULL OR effectiveRole IN (
                    'VIEWER', 'WELFARE_OPERATOR', 'HARDWARE_OPERATOR', 'ADMINISTRATOR'
                )
            ),
            barnId TEXT,
            feederId TEXT,
            deviceId TEXT,
            action TEXT NOT NULL,
            targetType TEXT NOT NULL,
            targetId TEXT,
            reason TEXT,
            requestId TEXT,
            authenticationStrength TEXT,
            timestamp TIMESTAMPTZ NOT NULL,
            result TEXT NOT NULL CHECK (result IN ('SUCCEEDED', 'REJECTED', 'FAILED')),
            beforeSummaryJson JSONB NOT NULL DEFAULT 'null'::jsonb,
            afterSummaryJson JSONB NOT NULL DEFAULT 'null'::jsonb,
            metadataJson JSONB NOT NULL DEFAULT 'null'::jsonb,
            approvalId TEXT
        );

        CREATE TABLE WelfareNotes (
            welfareNoteId TEXT PRIMARY KEY,
            administratorId TEXT NOT NULL
                REFERENCES Administrators(administratorId) ON DELETE RESTRICT,
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            feederId TEXT REFERENCES Feeders(feederId) ON DELETE RESTRICT,
            note TEXT NOT NULL,
            createdAt TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE ApprovalRequests (
            approvalRequestSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            approvalRequestId TEXT NOT NULL UNIQUE,
            actionType TEXT NOT NULL,
            requestedBy TEXT NOT NULL
                REFERENCES Administrators(administratorId) ON DELETE RESTRICT,
            targetType TEXT NOT NULL,
            targetId TEXT NOT NULL,
            barnId TEXT REFERENCES Barns(barnId) ON DELETE RESTRICT,
            feederId TEXT REFERENCES Feeders(feederId) ON DELETE RESTRICT,
            reason TEXT NOT NULL,
            requiredAuthoritiesJson JSONB NOT NULL,
            actionPayloadJson JSONB NOT NULL DEFAULT 'null'::jsonb,
            status TEXT NOT NULL CHECK (status IN (
                'PENDING', 'PARTIALLY_APPROVED', 'APPROVED', 'REJECTED',
                'EXPIRED', 'CANCELLED', 'EXECUTED', 'EXECUTION_FAILED'
            )),
            createdAt TIMESTAMPTZ NOT NULL,
            expiresAt TIMESTAMPTZ NOT NULL,
            completedAt TIMESTAMPTZ
        );

        CREATE TABLE ApprovalDecisions (
            approvalDecisionSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            approvalDecisionId TEXT NOT NULL UNIQUE,
            approvalRequestId TEXT NOT NULL
                REFERENCES ApprovalRequests(approvalRequestId) ON DELETE RESTRICT,
            administratorId TEXT NOT NULL
                REFERENCES Administrators(administratorId) ON DELETE RESTRICT,
            effectiveRole TEXT NOT NULL,
            authorityRepresented TEXT NOT NULL CHECK (
                authorityRepresented IN ('WELFARE', 'HARDWARE', 'PLATFORM_ADMIN')
            ),
            decision TEXT NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
            reason TEXT NOT NULL,
            authenticationStrength TEXT NOT NULL,
            decidedAt TIMESTAMPTZ NOT NULL,
            UNIQUE (approvalRequestId, administratorId)
        );

        CREATE TABLE ApprovalRequestHistory (
            approvalHistorySequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            approvalRequestId TEXT NOT NULL
                REFERENCES ApprovalRequests(approvalRequestId) ON DELETE RESTRICT,
            fromStatus TEXT,
            toStatus TEXT NOT NULL CHECK (toStatus IN (
                'PENDING', 'PARTIALLY_APPROVED', 'APPROVED', 'REJECTED',
                'EXPIRED', 'CANCELLED', 'EXECUTED', 'EXECUTION_FAILED'
            )),
            timestamp TIMESTAMPTZ NOT NULL,
            detailsJson JSONB NOT NULL DEFAULT 'null'::jsonb
        );

        CREATE TABLE EmergencyStops (
            emergencyStopSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            emergencyStopId TEXT NOT NULL UNIQUE,
            level TEXT NOT NULL CHECK (level IN ('PLATFORM', 'BARN', 'FEEDER')),
            barnId TEXT REFERENCES Barns(barnId) ON DELETE RESTRICT,
            feederId TEXT REFERENCES Feeders(feederId) ON DELETE RESTRICT,
            status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CLEARED')),
            activatedBy TEXT NOT NULL
                REFERENCES Administrators(administratorId) ON DELETE RESTRICT,
            activatedRole TEXT NOT NULL,
            reason TEXT NOT NULL,
            requestId TEXT,
            activatedAt TIMESTAMPTZ NOT NULL,
            clearedAt TIMESTAMPTZ,
            clearanceApprovalRequestId TEXT,
            CHECK (
                (level = 'PLATFORM' AND barnId IS NULL AND feederId IS NULL)
                OR (level = 'BARN' AND barnId IS NOT NULL AND feederId IS NULL)
                OR (level = 'FEEDER' AND barnId IS NOT NULL AND feederId IS NOT NULL)
            )
        );

        CREATE TABLE FeederDeviceAssignments (
            feederId TEXT PRIMARY KEY REFERENCES Feeders(feederId) ON DELETE RESTRICT,
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            deviceId TEXT NOT NULL UNIQUE REFERENCES Devices(deviceId) ON DELETE RESTRICT,
            createdAt TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE OperatorResolutionCases (
            resolutionCaseSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            resolutionCaseId TEXT NOT NULL UNIQUE,
            eventId TEXT NOT NULL REFERENCES Events(eventId) ON DELETE RESTRICT,
            commandId TEXT NOT NULL UNIQUE,
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            feederId TEXT NOT NULL REFERENCES Feeders(feederId) ON DELETE RESTRICT,
            deviceId TEXT NOT NULL REFERENCES Devices(deviceId) ON DELETE RESTRICT,
            caseType TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED')),
            requestedResolution TEXT,
            reason TEXT NOT NULL,
            supportingNotes TEXT,
            createdBy TEXT REFERENCES Administrators(administratorId) ON DELETE RESTRICT,
            createdAt TIMESTAMPTZ NOT NULL,
            approvalDeadline TIMESTAMPTZ,
            approvalRequestId TEXT,
            resolvedAt TIMESTAMPTZ,
            finalResolution TEXT,
            welfareImpactJson JSONB NOT NULL,
            replacementCommandId TEXT
        );

        CREATE TABLE DeviceCommands (
            commandSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            commandId TEXT NOT NULL UNIQUE,
            eventId TEXT NOT NULL REFERENCES Events(eventId) ON DELETE CASCADE,
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            feederId TEXT NOT NULL REFERENCES Feeders(feederId) ON DELETE RESTRICT,
            deviceId TEXT NOT NULL REFERENCES Devices(deviceId) ON DELETE RESTRICT,
            commandType TEXT NOT NULL CHECK (commandType IN ('RING_BELL', 'DISPENSE_FEED')),
            commandPayloadJson JSONB NOT NULL DEFAULT 'null'::jsonb,
            idempotencyKey TEXT NOT NULL UNIQUE,
            fencingToken BIGINT NOT NULL CHECK (fencingToken > 0),
            status TEXT NOT NULL CHECK (status IN (
                'PENDING', 'READY', 'SENT', 'ACKNOWLEDGED', 'RETRY_SCHEDULED',
                'TIMED_OUT', 'FAILED', 'OUTCOME_UNKNOWN', 'CANCELLED'
            )),
            attemptCount INTEGER NOT NULL DEFAULT 0 CHECK (attemptCount >= 0),
            maximumAttempts INTEGER NOT NULL CHECK (maximumAttempts > 0),
            acknowledgementDeadline TIMESTAMPTZ,
            nextAttemptAt TIMESTAMPTZ,
            createdAt TIMESTAMPTZ NOT NULL,
            sentAt TIMESTAMPTZ,
            acknowledgedAt TIMESTAMPTZ,
            completedAt TIMESTAMPTZ,
            failedAt TIMESTAMPTZ,
            lastError TEXT,
            updatedAt TIMESTAMPTZ NOT NULL,
            replacementOfCommandId TEXT
                REFERENCES DeviceCommands(commandId) ON DELETE RESTRICT,
            resolutionCaseId TEXT,
            CONSTRAINT device_command_resolution_case_fk
                FOREIGN KEY (resolutionCaseId)
                REFERENCES OperatorResolutionCases(resolutionCaseId)
                ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
            UNIQUE (feederId, fencingToken)
        );

        CREATE TABLE DeviceCommandOutbox (
            outboxSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            commandId TEXT NOT NULL UNIQUE
                REFERENCES DeviceCommands(commandId) ON DELETE CASCADE,
            status TEXT NOT NULL
                CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED')),
            availableAt TIMESTAMPTZ NOT NULL,
            claimedAt TIMESTAMPTZ,
            completedAt TIMESTAMPTZ,
            createdAt TIMESTAMPTZ NOT NULL,
            updatedAt TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE DeviceCommandHistory (
            historySequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            commandId TEXT NOT NULL REFERENCES DeviceCommands(commandId) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            fromStatus TEXT,
            toStatus TEXT NOT NULL CHECK (toStatus IN (
                'PENDING', 'READY', 'SENT', 'ACKNOWLEDGED', 'RETRY_SCHEDULED',
                'TIMED_OUT', 'FAILED', 'OUTCOME_UNKNOWN', 'CANCELLED'
            )),
            timestamp TIMESTAMPTZ NOT NULL,
            detailsJson JSONB NOT NULL DEFAULT 'null'::jsonb,
            UNIQUE (commandId, ordinal)
        );

        CREATE TABLE DeviceAcknowledgements (
            acknowledgementSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            acknowledgementId TEXT NOT NULL UNIQUE,
            commandId TEXT NOT NULL REFERENCES DeviceCommands(commandId) ON DELETE CASCADE,
            deviceId TEXT NOT NULL REFERENCES Devices(deviceId) ON DELETE RESTRICT,
            acknowledgementType TEXT NOT NULL,
            receivedAt TIMESTAMPTZ NOT NULL,
            deviceTimestamp TIMESTAMPTZ NOT NULL,
            result TEXT NOT NULL
                CHECK (result IN ('ACCEPTED', 'STARTED', 'SUCCEEDED', 'REJECTED', 'FAILED')),
            measuredQuantity DOUBLE PRECISION,
            errorCode TEXT,
            errorMessage TEXT,
            metadataJson JSONB NOT NULL DEFAULT 'null'::jsonb
        );

        CREATE TABLE DeviceCommandAuditRecords (
            auditSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            auditRecordId TEXT NOT NULL UNIQUE,
            commandId TEXT NOT NULL REFERENCES DeviceCommands(commandId) ON DELETE CASCADE,
            acknowledgementId TEXT
                REFERENCES DeviceAcknowledgements(acknowledgementId) ON DELETE CASCADE,
            action TEXT NOT NULL,
            occurredAt TIMESTAMPTZ NOT NULL,
            detailsJson JSONB NOT NULL DEFAULT 'null'::jsonb
        );

        CREATE TABLE SimulatedDeviceExecutions (
            commandId TEXT PRIMARY KEY REFERENCES DeviceCommands(commandId) ON DELETE CASCADE,
            deviceId TEXT NOT NULL REFERENCES Devices(deviceId) ON DELETE RESTRICT,
            fencingToken BIGINT NOT NULL,
            performedAt TIMESTAMPTZ NOT NULL,
            acknowledgementJson JSONB NOT NULL,
            actionCount INTEGER NOT NULL DEFAULT 1 CHECK (actionCount = 1)
        );

        CREATE TABLE SimulatedDeviceFences (
            deviceId TEXT PRIMARY KEY REFERENCES Devices(deviceId) ON DELETE RESTRICT,
            highestFencingToken BIGINT NOT NULL CHECK (highestFencingToken > 0),
            updatedAt TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE WelfareSafetyLedger (
            welfareEntrySequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            welfareEntryId TEXT NOT NULL UNIQUE,
            eventId TEXT NOT NULL REFERENCES Events(eventId) ON DELETE RESTRICT,
            commandId TEXT NOT NULL REFERENCES DeviceCommands(commandId) ON DELETE RESTRICT,
            resolutionCaseId TEXT
                REFERENCES OperatorResolutionCases(resolutionCaseId) ON DELETE RESTRICT,
            feederId TEXT NOT NULL REFERENCES Feeders(feederId) ON DELETE RESTRICT,
            entryType TEXT NOT NULL,
            quantity DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
            unit TEXT NOT NULL,
            countsAsDispensed SMALLINT NOT NULL CHECK (countsAsDispensed IN (0, 1)),
            recordedAt TIMESTAMPTZ NOT NULL,
            detailsJson JSONB NOT NULL DEFAULT 'null'::jsonb
        );

        CREATE TABLE AuditRecords (
            auditSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            auditRecordId TEXT NOT NULL UNIQUE,
            action TEXT NOT NULL CHECK (action IN (
                'PROVIDER_EVENT_RECEIVED', 'DUPLICATE_DETECTED', 'VERIFICATION_PASSED',
                'VERIFICATION_FAILED', 'CONTRIBUTION_CREATED',
                'CONTRIBUTION_REJECTED', 'FEED_REQUEST_CREATED'
            )),
            providerEventId TEXT
                REFERENCES ProviderEvents(providerEventId) ON DELETE RESTRICT,
            contributionId TEXT
                REFERENCES Contributions(contributionId) ON DELETE RESTRICT,
            eventId TEXT REFERENCES Events(eventId) ON DELETE RESTRICT,
            occurredAt TIMESTAMPTZ NOT NULL,
            detailsJson JSONB NOT NULL DEFAULT 'null'::jsonb
        );

        CREATE TABLE SimulatedControllers (
            controllerSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            controllerId TEXT NOT NULL UNIQUE,
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            name TEXT NOT NULL,
            enabled SMALLINT NOT NULL CHECK (enabled IN (0, 1)),
            softwareVersion TEXT NOT NULL,
            protocolVersion TEXT NOT NULL,
            lastSeenAt TIMESTAMPTZ,
            connectionState TEXT NOT NULL CHECK (connectionState IN ('ONLINE', 'OFFLINE')),
            simulationBehaviourJson JSONB NOT NULL DEFAULT
                '{"mode":"NORMAL","acknowledgementDelayMs":0,"completionDelayMs":0}'::jsonb,
            createdAt TIMESTAMPTZ NOT NULL,
            updatedAt TIMESTAMPTZ NOT NULL,
            controllerBootId TEXT,
            bootCounter BIGINT NOT NULL DEFAULT 0 CHECK (bootCounter >= 0),
            lastHeartbeatReceivedAt TIMESTAMPTZ,
            statusExpiresAt TIMESTAMPTZ,
            revokedAt TIMESTAMPTZ,
            lastControllerSequence BIGINT NOT NULL DEFAULT 0
                CHECK (lastControllerSequence >= 0)
        );

        CREATE TABLE SimulatedControllerFeederAssignments (
            controllerId TEXT NOT NULL
                REFERENCES SimulatedControllers(controllerId) ON DELETE RESTRICT,
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            feederId TEXT NOT NULL UNIQUE REFERENCES Feeders(feederId) ON DELETE RESTRICT,
            createdAt TIMESTAMPTZ NOT NULL,
            assignmentGeneration BIGINT NOT NULL DEFAULT 1
                CHECK (assignmentGeneration > 0),
            authorityLeaseExpiresAt TIMESTAMPTZ,
            updatedAt TIMESTAMPTZ,
            PRIMARY KEY (controllerId, feederId)
        );

        CREATE TABLE ControllerAssignmentHistory (
            assignmentHistorySequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            controllerId TEXT NOT NULL
                REFERENCES SimulatedControllers(controllerId) ON DELETE RESTRICT,
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            feederId TEXT NOT NULL REFERENCES Feeders(feederId) ON DELETE RESTRICT,
            assignmentGeneration BIGINT NOT NULL CHECK (assignmentGeneration > 0),
            assignmentStatus TEXT NOT NULL
                CHECK (assignmentStatus IN ('ACTIVE', 'DISABLED', 'REPLACED')),
            authorityLeaseExpiresAt TIMESTAMPTZ,
            reason TEXT NOT NULL,
            approvalRequestId TEXT,
            occurredAt TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE SimulatedControllerCommandJournal (
            journalSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            journalId TEXT NOT NULL UNIQUE,
            controllerId TEXT NOT NULL
                REFERENCES SimulatedControllers(controllerId) ON DELETE RESTRICT,
            commandId TEXT NOT NULL UNIQUE
                REFERENCES DeviceCommands(commandId) ON DELETE RESTRICT,
            barnId TEXT NOT NULL REFERENCES Barns(barnId) ON DELETE RESTRICT,
            feederId TEXT NOT NULL REFERENCES Feeders(feederId) ON DELETE RESTRICT,
            deviceId TEXT NOT NULL REFERENCES Devices(deviceId) ON DELETE RESTRICT,
            fencingToken BIGINT NOT NULL CHECK (fencingToken > 0),
            executionState TEXT NOT NULL CHECK (executionState IN (
                'RECEIVED', 'ACCEPTED', 'STARTED', 'COMPLETED',
                'REJECTED', 'FAILED', 'OUTCOME_UNKNOWN'
            )),
            dispensePerformed SMALLINT NOT NULL DEFAULT 0
                CHECK (dispensePerformed IN (0, 1)),
            receivedAt TIMESTAMPTZ NOT NULL,
            acceptedAt TIMESTAMPTZ,
            startedAt TIMESTAMPTZ,
            completedAt TIMESTAMPTZ,
            updatedAt TIMESTAMPTZ NOT NULL,
            finalAcknowledgementJson JSONB,
            failureReason TEXT,
            assignmentGeneration BIGINT NOT NULL DEFAULT 1
                CHECK (assignmentGeneration > 0),
            acknowledgementDeliverySucceeded SMALLINT
                CHECK (acknowledgementDeliverySucceeded IN (0, 1)),
            reconciliationState TEXT NOT NULL DEFAULT 'PENDING' CHECK (
                reconciliationState IN ('PENDING', 'DELIVERED', 'RECONCILED', 'OUTCOME_UNKNOWN')
            ),
            commandAction TEXT,
            commandParametersJson JSONB NOT NULL DEFAULT 'null'::jsonb,
            evidenceAt TIMESTAMPTZ,
            controllerBootId TEXT,
            UNIQUE (controllerId, feederId, fencingToken)
        );

        CREATE TABLE SimulatedControllerJournalHistory (
            historySequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            journalId TEXT NOT NULL
                REFERENCES SimulatedControllerCommandJournal(journalId) ON DELETE RESTRICT,
            fromState TEXT,
            toState TEXT NOT NULL CHECK (toState IN (
                'RECEIVED', 'ACCEPTED', 'STARTED', 'COMPLETED',
                'REJECTED', 'FAILED', 'OUTCOME_UNKNOWN'
            )),
            timestamp TIMESTAMPTZ NOT NULL,
            detailsJson JSONB NOT NULL DEFAULT 'null'::jsonb
        );

        CREATE TABLE MqttOutboundDeliveries (
            deliverySequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            deliveryId TEXT NOT NULL UNIQUE,
            commandId TEXT NOT NULL REFERENCES DeviceCommands(commandId) ON DELETE RESTRICT,
            controllerId TEXT NOT NULL
                REFERENCES SimulatedControllers(controllerId) ON DELETE RESTRICT,
            assignmentGeneration BIGINT NOT NULL CHECK (assignmentGeneration > 0),
            topic TEXT NOT NULL,
            publishedAt TIMESTAMPTZ NOT NULL,
            brokerAcknowledgedAt TIMESTAMPTZ,
            state TEXT NOT NULL
                CHECK (state IN ('PUBLISHING', 'BROKER_ACKNOWLEDGED', 'FAILED')),
            failureCode TEXT
        );

        CREATE TABLE MqttInboundMessages (
            inboundSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            controllerId TEXT NOT NULL
                REFERENCES SimulatedControllers(controllerId) ON DELETE RESTRICT,
            messageType TEXT NOT NULL,
            messageId TEXT NOT NULL,
            controllerBootId TEXT,
            controllerSequence BIGINT,
            receivedAt TIMESTAMPTZ NOT NULL,
            duplicateCount INTEGER NOT NULL DEFAULT 0 CHECK (duplicateCount >= 0),
            UNIQUE (controllerId, messageType, messageId)
        );

        CREATE TABLE MqttProtocolEvents (
            protocolEventSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR')),
            eventType TEXT NOT NULL,
            code TEXT,
            controllerId TEXT,
            commandId TEXT,
            topic TEXT,
            occurredAt TIMESTAMPTZ NOT NULL,
            detailsJson JSONB NOT NULL DEFAULT 'null'::jsonb
        );

        CREATE TABLE MqttSafetyStates (
            scopeKey TEXT PRIMARY KEY,
            level TEXT NOT NULL CHECK (level IN ('PLATFORM', 'BARN', 'FEEDER')),
            barnId TEXT,
            feederId TEXT,
            generation BIGINT NOT NULL CHECK (generation > 0),
            active SMALLINT NOT NULL CHECK (active IN (0, 1)),
            reason TEXT,
            updatedAt TIMESTAMPTZ NOT NULL,
            CHECK (
                (level = 'PLATFORM' AND barnId IS NULL AND feederId IS NULL)
                OR (level = 'BARN' AND barnId IS NOT NULL AND feederId IS NULL)
                OR (level = 'FEEDER' AND feederId IS NOT NULL)
            )
        );

        CREATE TABLE EdgeControllerStatus (
            controllerId TEXT PRIMARY KEY
                REFERENCES SimulatedControllers(controllerId) ON DELETE RESTRICT,
            controllerBootId TEXT NOT NULL,
            bootCounter BIGINT NOT NULL CHECK (bootCounter > 0),
            statusVersion TEXT NOT NULL,
            statusJson JSONB NOT NULL,
            receivedAt TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE EdgeControllerStatusHistory (
            statusSequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            controllerId TEXT NOT NULL
                REFERENCES SimulatedControllers(controllerId) ON DELETE RESTRICT,
            controllerBootId TEXT NOT NULL,
            bootCounter BIGINT NOT NULL CHECK (bootCounter > 0),
            statusVersion TEXT NOT NULL,
            receivedAt TIMESTAMPTZ NOT NULL,
            summaryJson JSONB NOT NULL
        );

        CREATE INDEX idx_events_barn_feeder ON Events(barnId, feederId);
        CREATE INDEX idx_events_queue ON Events(queueId, currentState);
        CREATE INDEX idx_events_current_state ON Events(currentState);
        CREATE UNIQUE INDEX idx_events_contribution ON Events(contributionId);
        CREATE UNIQUE INDEX idx_events_feed_intent ON Events(feedIntentId);
        CREATE INDEX idx_feeders_barn ON Feeders(barnId, feederId);
        CREATE INDEX idx_cameras_barn ON Cameras(barnId, cameraId);
        CREATE INDEX idx_devices_barn ON Devices(barnId, deviceId);
        CREATE INDEX idx_queues_barn ON Queues(barnId, queueId);
        CREATE INDEX idx_queue_position ON Queue(queueId, queuePosition);
        CREATE INDEX idx_lifecycle_history_event ON LifecycleHistory(eventId, ordinal);
        CREATE INDEX idx_hardware_acknowledgements_event
            ON HardwareAcknowledgements(eventId, acknowledgementId);
        CREATE INDEX idx_provider_events_status
            ON ProviderEvents(verificationStatus, receivedAt);
        CREATE INDEX idx_contributions_eligibility
            ON Contributions(eligibilityStatus, verifiedAt);
        CREATE INDEX idx_feed_intents_status ON FeedIntents(status, createdAt);
        CREATE INDEX idx_feed_intents_resource ON FeedIntents(feederId, status, createdAt);
        CREATE INDEX idx_outbox_processable ON Outbox(status, availableAt, outboxSequence);
        CREATE INDEX idx_feed_intent_history ON FeedIntentHistory(feedIntentId, historySequence);
        CREATE INDEX idx_audit_provider_event ON AuditRecords(providerEventId, auditSequence);
        CREATE INDEX idx_audit_contribution ON AuditRecords(contributionId, auditSequence);
        CREATE INDEX idx_audit_event ON AuditRecords(eventId, auditSequence);
        CREATE UNIQUE INDEX idx_active_role_assignments
            ON RoleAssignments(administratorId, role, platformWide) WHERE revokedAt IS NULL;
        CREATE UNIQUE INDEX idx_active_barn_scopes
            ON BarnScopes(roleAssignmentId, barnId) WHERE revokedAt IS NULL;
        CREATE INDEX idx_role_assignments_administrator
            ON RoleAssignments(administratorId, revokedAt, role);
        CREATE INDEX idx_barn_scopes_administrator
            ON BarnScopes(administratorId, barnId, revokedAt);
        CREATE INDEX idx_operator_audit_administrator
            ON OperatorAuditRecords(administratorId, auditSequence);
        CREATE INDEX idx_operator_audit_barn ON OperatorAuditRecords(barnId, auditSequence);
        CREATE INDEX idx_operator_audit_request ON OperatorAuditRecords(requestId, auditSequence);
        CREATE INDEX idx_welfare_notes_barn ON WelfareNotes(barnId, feederId, createdAt);
        CREATE UNIQUE INDEX idx_active_emergency_stop_scope
            ON EmergencyStops(level, COALESCE(barnId, ''), COALESCE(feederId, ''))
            WHERE status = 'ACTIVE';
        CREATE INDEX idx_emergency_stops_active
            ON EmergencyStops(status, level, barnId, feederId);
        CREATE INDEX idx_approval_requests_status
            ON ApprovalRequests(status, expiresAt, approvalRequestSequence);
        CREATE INDEX idx_approval_decisions_request
            ON ApprovalDecisions(approvalRequestId, approvalDecisionSequence);
        CREATE INDEX idx_resolution_cases_feeder
            ON OperatorResolutionCases(feederId, status, resolutionCaseSequence);
        CREATE INDEX idx_device_commands_event ON DeviceCommands(eventId, commandType);
        CREATE INDEX idx_device_commands_feeder ON DeviceCommands(feederId, commandSequence);
        CREATE INDEX idx_device_commands_ready
            ON DeviceCommands(status, nextAttemptAt, commandSequence);
        CREATE UNIQUE INDEX idx_device_commands_original_event_action
            ON DeviceCommands(eventId, commandType) WHERE replacementOfCommandId IS NULL;
        CREATE UNIQUE INDEX idx_device_commands_resolution_replacement
            ON DeviceCommands(resolutionCaseId) WHERE resolutionCaseId IS NOT NULL;
        CREATE INDEX idx_device_command_outbox_ready
            ON DeviceCommandOutbox(status, availableAt, outboxSequence);
        CREATE INDEX idx_device_command_history_command
            ON DeviceCommandHistory(commandId, ordinal);
        CREATE INDEX idx_device_acknowledgements_command
            ON DeviceAcknowledgements(commandId, acknowledgementSequence);
        CREATE INDEX idx_device_command_audit_command
            ON DeviceCommandAuditRecords(commandId, auditSequence);
        CREATE INDEX idx_welfare_safety_feeder
            ON WelfareSafetyLedger(feederId, recordedAt, welfareEntrySequence);
        CREATE INDEX idx_simulated_controllers_barn
            ON SimulatedControllers(barnId, enabled, connectionState);
        CREATE INDEX idx_controller_assignments_controller
            ON SimulatedControllerFeederAssignments(controllerId, feederId);
        CREATE INDEX idx_assignment_history_feeder
            ON ControllerAssignmentHistory(feederId, assignmentGeneration DESC);
        CREATE INDEX idx_controller_journal_recent
            ON SimulatedControllerCommandJournal(controllerId, journalSequence DESC);
        CREATE INDEX idx_mqtt_deliveries_command
            ON MqttOutboundDeliveries(commandId, deliverySequence DESC);
        CREATE INDEX idx_mqtt_inbound_controller
            ON MqttInboundMessages(controllerId, inboundSequence DESC);
        CREATE INDEX idx_mqtt_protocol_events_recent
            ON MqttProtocolEvents(protocolEventSequence DESC);
        CREATE INDEX edge_controller_status_history_recent
            ON EdgeControllerStatusHistory(controllerId, statusSequence DESC);

        CREATE OR REPLACE FUNCTION alpacaly_prevent_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
                USING ERRCODE = 'integrity_constraint_violation';
        END;
        $$;

        CREATE OR REPLACE FUNCTION alpacaly_immutable_columns()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE column_name TEXT;
        BEGIN
            FOREACH column_name IN ARRAY TG_ARGV LOOP
                IF to_jsonb(OLD) -> column_name IS DISTINCT FROM
                   to_jsonb(NEW) -> column_name THEN
                    RAISE EXCEPTION '% identity column % is immutable',
                        TG_TABLE_NAME, column_name
                        USING ERRCODE = 'integrity_constraint_violation';
                END IF;
            END LOOP;
            RETURN NEW;
        END;
        $$;

        CREATE TRIGGER provider_events_identity_immutable
            BEFORE UPDATE ON ProviderEvents FOR EACH ROW
            EXECUTE FUNCTION alpacaly_immutable_columns('provider', 'externaleventid');
        CREATE TRIGGER contributions_provider_event_immutable
            BEFORE UPDATE ON Contributions FOR EACH ROW
            EXECUTE FUNCTION alpacaly_immutable_columns('providereventid');
        CREATE TRIGGER feed_intents_identity_immutable
            BEFORE UPDATE ON FeedIntents FOR EACH ROW
            EXECUTE FUNCTION alpacaly_immutable_columns(
                'contributionid', 'barnid', 'feederid', 'queueid'
            );
        CREATE TRIGGER device_command_identity_immutable
            BEFORE UPDATE ON DeviceCommands FOR EACH ROW
            EXECUTE FUNCTION alpacaly_immutable_columns(
                'commandid', 'eventid', 'barnid', 'feederid', 'deviceid',
                'commandtype', 'idempotencykey', 'fencingtoken',
                'replacementofcommandid', 'resolutioncaseid'
            );
        CREATE TRIGGER administrator_identity_immutable
            BEFORE UPDATE ON Administrators FOR EACH ROW
            EXECUTE FUNCTION alpacaly_immutable_columns(
                'administratorid', 'externalidentityid', 'createdat'
            );
        CREATE TRIGGER role_assignment_identity_immutable
            BEFORE UPDATE ON RoleAssignments FOR EACH ROW
            EXECUTE FUNCTION alpacaly_immutable_columns(
                'roleassignmentid', 'administratorid', 'role', 'platformwide', 'assignedat'
            );
        CREATE TRIGGER emergency_stop_identity_immutable
            BEFORE UPDATE ON EmergencyStops FOR EACH ROW
            EXECUTE FUNCTION alpacaly_immutable_columns(
                'emergencystopid', 'level', 'barnid', 'feederid', 'activatedby', 'activatedat'
            );
        CREATE TRIGGER resolution_case_identity_immutable
            BEFORE UPDATE ON OperatorResolutionCases FOR EACH ROW
            EXECUTE FUNCTION alpacaly_immutable_columns(
                'resolutioncaseid', 'eventid', 'commandid', 'barnid',
                'feederid', 'deviceid', 'casetype', 'createdat'
            );
        CREATE TRIGGER simulated_controller_identity_immutable
            BEFORE UPDATE ON SimulatedControllers FOR EACH ROW
            EXECUTE FUNCTION alpacaly_immutable_columns('controllerid', 'barnid', 'createdat');
        CREATE TRIGGER controller_journal_identity_immutable
            BEFORE UPDATE ON SimulatedControllerCommandJournal FOR EACH ROW
            EXECUTE FUNCTION alpacaly_immutable_columns(
                'journalid', 'controllerid', 'commandid', 'barnid',
                'feederid', 'deviceid', 'fencingtoken', 'receivedat'
            );

        CREATE TRIGGER audit_records_append_only
            BEFORE UPDATE OR DELETE ON AuditRecords FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER operator_audit_records_append_only
            BEFORE UPDATE OR DELETE ON OperatorAuditRecords FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER welfare_notes_append_only
            BEFORE UPDATE OR DELETE ON WelfareNotes FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER lifecycle_history_append_only
            BEFORE UPDATE OR DELETE ON LifecycleHistory FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER feed_intent_history_append_only
            BEFORE UPDATE OR DELETE ON FeedIntentHistory FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER device_command_history_append_only
            BEFORE UPDATE OR DELETE ON DeviceCommandHistory FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER device_command_audit_append_only
            BEFORE UPDATE OR DELETE ON DeviceCommandAuditRecords FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER approval_decisions_append_only
            BEFORE UPDATE OR DELETE ON ApprovalDecisions FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER approval_history_append_only
            BEFORE UPDATE OR DELETE ON ApprovalRequestHistory FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER welfare_safety_ledger_append_only
            BEFORE UPDATE OR DELETE ON WelfareSafetyLedger FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER assignment_history_append_only
            BEFORE UPDATE OR DELETE ON ControllerAssignmentHistory FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER controller_journal_history_append_only
            BEFORE UPDATE OR DELETE ON SimulatedControllerJournalHistory FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER mqtt_protocol_events_append_only
            BEFORE UPDATE OR DELETE ON MqttProtocolEvents FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER edge_status_history_append_only
            BEFORE UPDATE OR DELETE ON EdgeControllerStatusHistory FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER emergency_stops_delete_forbidden
            BEFORE DELETE ON EmergencyStops FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();
        CREATE TRIGGER resolution_cases_delete_forbidden
            BEFORE DELETE ON OperatorResolutionCases FOR EACH ROW
            EXECUTE FUNCTION alpacaly_prevent_mutation();

        INSERT INTO Barns (barnId, name, timezone, createdAt)
        VALUES (
            'barn_00000000-0000-4000-8000-000000000001',
            'Default Barn', 'Europe/London', '2026-07-19T00:00:00.000Z'
        ) ON CONFLICT DO NOTHING;
        INSERT INTO Feeders (feederId, barnId, name, createdAt)
        VALUES (
            'feeder_00000000-0000-4000-8000-000000000002',
            'barn_00000000-0000-4000-8000-000000000001',
            'Default Feeder', '2026-07-19T00:00:00.000Z'
        ) ON CONFLICT DO NOTHING;
        INSERT INTO Queues (
            queueId, barnId, feederId, resourceType, resourceId, name, createdAt
        ) VALUES (
            'queue_00000000-0000-4000-8000-000000000003',
            'barn_00000000-0000-4000-8000-000000000001',
            'feeder_00000000-0000-4000-8000-000000000002',
            'FEEDER', 'feeder_00000000-0000-4000-8000-000000000002',
            'Default Feeder Queue', '2026-07-19T00:00:00.000Z'
        ) ON CONFLICT DO NOTHING;
    `
});
