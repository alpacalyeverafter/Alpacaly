export const migration011DistributedWorkerCoordination = Object.freeze({
    version: 11,
    name: "distributed_worker_coordination",
    up(database) {
        database.exec(`
            CREATE TABLE WorkerInstances (
                workerId TEXT PRIMARY KEY,
                serviceType TEXT NOT NULL,
                processInstanceId TEXT NOT NULL,
                bootId TEXT NOT NULL,
                startedAt TEXT NOT NULL,
                lastHeartbeatAt TEXT NOT NULL,
                stoppedAt TEXT,
                softwareVersion TEXT NOT NULL,
                environment TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('RUNNING', 'STOPPED', 'STALE')),
                metadataJson TEXT NOT NULL DEFAULT 'null'
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE DailyFeedReservations (
                queueId TEXT NOT NULL,
                dateKey TEXT NOT NULL,
                acceptedCount INTEGER NOT NULL CHECK (acceptedCount >= 0),
                updatedAt TEXT NOT NULL,
                PRIMARY KEY (queueId, dateKey),
                FOREIGN KEY (queueId) REFERENCES Queues(queueId) ON DELETE RESTRICT
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE DistributedWorkClaims (
                workType TEXT NOT NULL,
                workItemId TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN (
                    'AVAILABLE', 'ACTIVE', 'COMPLETED', 'FAILED',
                    'DEAD_LETTER', 'OPERATOR_REVIEW'
                )),
                workerId TEXT,
                serviceType TEXT NOT NULL,
                claimedAt TEXT,
                leaseExpiresAt TEXT,
                maximumExpiresAt TEXT,
                heartbeatAt TEXT,
                attemptNumber INTEGER NOT NULL DEFAULT 0 CHECK (attemptNumber >= 0),
                maximumAttempts INTEGER NOT NULL CHECK (maximumAttempts > 0),
                claimGeneration INTEGER NOT NULL DEFAULT 0 CHECK (claimGeneration >= 0),
                completedAt TEXT,
                failedAt TEXT,
                failureCode TEXT,
                failureMessage TEXT,
                nextEligibleAt TEXT,
                terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
                operatorReviewRequired INTEGER NOT NULL DEFAULT 0
                    CHECK (operatorReviewRequired IN (0, 1)),
                updatedAt TEXT NOT NULL,
                metadataJson TEXT NOT NULL DEFAULT 'null',
                PRIMARY KEY (workType, workItemId),
                FOREIGN KEY (workerId)
                    REFERENCES WorkerInstances(workerId) ON DELETE RESTRICT,
                CHECK (
                    (state = 'ACTIVE' AND workerId IS NOT NULL
                        AND claimedAt IS NOT NULL AND leaseExpiresAt IS NOT NULL)
                    OR state <> 'ACTIVE'
                )
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE WorkClaimHistory (
                claimHistorySequence INTEGER PRIMARY KEY AUTOINCREMENT,
                workType TEXT NOT NULL,
                workItemId TEXT NOT NULL,
                claimGeneration INTEGER NOT NULL CHECK (claimGeneration >= 0),
                workerId TEXT,
                action TEXT NOT NULL,
                occurredAt TEXT NOT NULL,
                detailsJson TEXT NOT NULL DEFAULT 'null',
                FOREIGN KEY (workType, workItemId)
                    REFERENCES DistributedWorkClaims(workType, workItemId)
                    ON DELETE RESTRICT,
                FOREIGN KEY (workerId)
                    REFERENCES WorkerInstances(workerId) ON DELETE RESTRICT
            ) STRICT;

            CREATE INDEX distributed_claims_ready
                ON DistributedWorkClaims(state, nextEligibleAt, leaseExpiresAt);
            CREATE INDEX distributed_claims_worker
                ON DistributedWorkClaims(workerId, state, leaseExpiresAt);
            CREATE INDEX worker_instances_heartbeat
                ON WorkerInstances(status, lastHeartbeatAt);
            CREATE INDEX work_claim_history_item
                ON WorkClaimHistory(workType, workItemId, claimHistorySequence);

            CREATE TRIGGER work_claim_history_append_only_update
            BEFORE UPDATE ON WorkClaimHistory
            BEGIN SELECT RAISE(ABORT, 'Work Claim history is append-only'); END;
            CREATE TRIGGER work_claim_history_append_only_delete
            BEFORE DELETE ON WorkClaimHistory
            BEGIN SELECT RAISE(ABORT, 'Work Claim history is append-only'); END;
        `);
    }
});
