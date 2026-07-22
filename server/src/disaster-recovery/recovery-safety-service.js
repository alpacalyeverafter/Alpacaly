import { ApplicationError } from "../errors/application-error.js";

function serialize(value) {
    return JSON.stringify(value ?? null);
}

function parse(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    return typeof value === "string" ? JSON.parse(value) : value;
}

function requiredDecisionId(value) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        throw new Error("An explicit recovery decision ID is required.");
    }
    return normalized.slice(0, 256);
}

export class RecoverySafetyService {
    constructor({
        eventStore,
        config = {},
        logger = null,
        clock = () => new Date()
    }) {
        this.eventStore = eventStore;
        this.database = eventStore.database;
        this.config = config;
        this.logger = logger;
        this.clock = clock;
    }

    getStatus() {
        const row = this.database.prepare(`
            SELECT * FROM RecoverySafetyState
            WHERE recoveryStateId = 'central'
        `).get();
        if (!row) {
            throw new Error("Recovery safety state is unavailable.");
        }
        return {
            mode: row.mode,
            sourceBackupId: row.sourceBackupId,
            restoredAt: row.restoredAt,
            reconciliationStatus: row.reconciliationStatus,
            reconciliationRunAt: row.reconciliationRunAt,
            releasedAt: row.releasedAt,
            releaseDecisionId: row.releaseDecisionId,
            unresolvedClaimCount: Number(row.unresolvedClaimCount),
            unresolvedCommandCount: Number(row.unresolvedCommandCount),
            lastReport: parse(row.lastReportJson),
            updatedAt: row.updatedAt,
            configurationBlock: this.config.recoverySafetyMode === true
        };
    }

    isBlocked() {
        const state = this.getStatus();
        return state.configurationBlock || state.mode === "BLOCKED";
    }

    workersMayStart() {
        return !this.isBlocked();
    }

    assertWorkerMayStart(workerType) {
        this.assertOperationAllowed(`${workerType}_WORKER_START`);
    }

    assertOperationAllowed(operation) {
        if (!this.isBlocked()) {
            return;
        }
        throw new ApplicationError(
            "Recovery safety mode blocks feeding and command operations.",
            {
                code: "RECOVERY_SAFETY_MODE_ACTIVE",
                statusCode: 503,
                details: { operation }
            }
        );
    }

    assertCommandMayProgress(commandId) {
        this.assertOperationAllowed("DEVICE_COMMAND_DELIVERY");
        const review = this.database.prepare(`
            SELECT classification, reviewStatus
            FROM RestoredCommandReviews WHERE commandId = ?
        `).get(commandId);
        if (review?.reviewStatus === "REVIEW_REQUIRED") {
            throw new ApplicationError(
                "The restored Device Command requires deliberate operator review.",
                {
                    code: "RESTORED_COMMAND_REVIEW_REQUIRED",
                    statusCode: 409,
                    details: {
                        commandId,
                        classification: review.classification
                    }
                }
            );
        }
    }

    markRestored({ backupId, restoredAt = this.clock().toISOString() }) {
        return this.eventStore.transaction(() => {
            this.database.prepare(`
                UPDATE RecoverySafetyState
                SET mode = 'BLOCKED', sourceBackupId = ?, restoredAt = ?,
                    reconciliationStatus = 'NOT_RUN', reconciliationRunAt = NULL,
                    releasedAt = NULL, releaseDecisionId = NULL,
                    unresolvedClaimCount = 0, unresolvedCommandCount = 0,
                    lastReportJson = 'null', updatedAt = ?
                WHERE recoveryStateId = 'central'
            `).run(backupId, restoredAt, restoredAt);
            this.insertEvent("RESTORE_SAFETY_MODE_ENABLED", backupId, restoredAt, {
                workersBlocked: true
            });
            return this.getStatus();
        });
    }

    classifyRestoredCommands({ backupId }) {
        const now = this.clock().toISOString();
        return this.eventStore.transaction(() => {
            const commands = this.database.prepare(`
                SELECT commandId, status FROM DeviceCommands ORDER BY commandId
            `).all();
            const counts = {
                PROVEN_NOT_SENT: 0,
                UNCERTAIN: 0,
                COMPLETED: 0,
                OUTCOME_UNKNOWN: 0
            };
            commands.forEach(command => {
                const unsafeAcknowledgement = Number(this.database.prepare(`
                    SELECT COUNT(*) AS count FROM DeviceAcknowledgements
                    WHERE commandId = ? AND result IN ('STARTED', 'SUCCEEDED')
                `).get(command.commandId).count) > 0;
                let classification;
                let reviewStatus;
                if (["ACKNOWLEDGED", "CANCELLED"].includes(command.status)) {
                    classification = "COMPLETED";
                    reviewStatus = "CLOSED";
                } else if (command.status === "OUTCOME_UNKNOWN") {
                    classification = "OUTCOME_UNKNOWN";
                    reviewStatus = "REVIEW_REQUIRED";
                } else if (
                    ["SENT", "TIMED_OUT"].includes(command.status)
                    || unsafeAcknowledgement
                ) {
                    classification = "UNCERTAIN";
                    reviewStatus = "REVIEW_REQUIRED";
                } else {
                    classification = "PROVEN_NOT_SENT";
                    reviewStatus = "REVIEW_REQUIRED";
                }
                counts[classification] += 1;
                this.database.prepare(`
                    INSERT INTO RestoredCommandReviews (
                        commandId, sourceBackupId, originalStatus, classification,
                        reviewStatus, createdAt, reviewedAt, reviewDecisionId,
                        detailsJson
                    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
                    ON CONFLICT (commandId) DO UPDATE SET
                        sourceBackupId = excluded.sourceBackupId,
                        originalStatus = excluded.originalStatus,
                        classification = excluded.classification,
                        reviewStatus = excluded.reviewStatus,
                        createdAt = excluded.createdAt,
                        reviewedAt = NULL,
                        reviewDecisionId = NULL,
                        detailsJson = excluded.detailsJson
                `).run(
                    command.commandId,
                    backupId,
                    command.status,
                    classification,
                    reviewStatus,
                    now,
                    serialize({ unsafeAcknowledgement })
                );
            });
            const unresolved = counts.PROVEN_NOT_SENT
                + counts.UNCERTAIN
                + counts.OUTCOME_UNKNOWN;
            this.database.prepare(`
                UPDATE RecoverySafetyState
                SET unresolvedCommandCount = ?, updatedAt = ?
                WHERE recoveryStateId = 'central'
            `).run(unresolved, now);
            this.insertEvent("UNCERTAIN_COMMANDS_BLOCKED", backupId, now, counts);
            return { total: commands.length, counts, unresolved };
        });
    }

    fenceRestoredClaims({ backupId }) {
        const now = this.clock().toISOString();
        return this.eventStore.transaction(() => {
            const activeClaims = this.database.prepare(`
                SELECT * FROM DistributedWorkClaims
                WHERE state = 'ACTIVE'
                ORDER BY workType, workItemId
            `).all();
            let operatorReview = 0;
            let madeAvailable = 0;
            activeClaims.forEach(claim => {
                const commandReview = claim.workType === "DEVICE_COMMAND"
                    ? this.database.prepare(`
                        SELECT classification FROM RestoredCommandReviews
                        WHERE commandId = ?
                    `).get(claim.workItemId)
                    : null;
                const requiresReview = commandReview
                    && ["UNCERTAIN", "OUTCOME_UNKNOWN"].includes(
                        commandReview.classification
                    );
                const state = requiresReview ? "OPERATOR_REVIEW" : "AVAILABLE";
                const nextGeneration = Number(claim.claimGeneration) + 1;
                const metadata = {
                    ...(parse(claim.metadataJson) || {}),
                    restoredFromBackupId: backupId,
                    priorWorkerId: claim.workerId,
                    recoveryBlocked: true
                };
                this.database.prepare(`
                    UPDATE DistributedWorkClaims
                    SET state = ?, workerId = NULL, claimedAt = NULL,
                        leaseExpiresAt = NULL, maximumExpiresAt = NULL,
                        heartbeatAt = NULL, claimGeneration = ?,
                        failureCode = ?, failureMessage = ?, nextEligibleAt = NULL,
                        terminal = ?, operatorReviewRequired = ?, updatedAt = ?,
                        metadataJson = ?
                    WHERE workType = ? AND workItemId = ? AND state = 'ACTIVE'
                      AND claimGeneration = ?
                `).run(
                    state,
                    nextGeneration,
                    requiresReview ? "RESTORED_UNCERTAIN_COMMAND" : null,
                    requiresReview
                        ? "Restored command requires operator review before any delivery."
                        : null,
                    requiresReview ? 1 : 0,
                    requiresReview ? 1 : 0,
                    now,
                    serialize(metadata),
                    claim.workType,
                    claim.workItemId,
                    claim.claimGeneration
                );
                this.database.prepare(`
                    INSERT INTO WorkClaimHistory (
                        workType, workItemId, claimGeneration, workerId,
                        action, occurredAt, detailsJson
                    ) VALUES (?, ?, ?, ?, 'RESTORE_FENCED', ?, ?)
                `).run(
                    claim.workType,
                    claim.workItemId,
                    nextGeneration,
                    claim.workerId,
                    now,
                    serialize({ backupId, priorState: "ACTIVE", state })
                );
                if (requiresReview) {
                    operatorReview += 1;
                } else {
                    madeAvailable += 1;
                }
            });
            this.database.prepare(`
                UPDATE WorkerInstances
                SET status = 'STALE', stoppedAt = COALESCE(stoppedAt, ?)
                WHERE status = 'RUNNING'
            `).run(now);
            this.database.prepare(`
                UPDATE RecoverySafetyState
                SET unresolvedClaimCount = ?, updatedAt = ?
                WHERE recoveryStateId = 'central'
            `).run(operatorReview, now);
            this.insertEvent("RESTORED_CLAIMS_FENCED", backupId, now, {
                fenced: activeClaims.length,
                operatorReview,
                madeAvailable
            });
            return {
                fenced: activeClaims.length,
                operatorReview,
                madeAvailable
            };
        });
    }

    recordReconciliation(report) {
        const now = this.clock().toISOString();
        const status = String(report?.status || "BLOCKED").toUpperCase();
        if (!["PASS", "WARNING", "BLOCKED"].includes(status)) {
            throw new Error("The reconciliation result is not supported.");
        }
        return this.eventStore.transaction(() => {
            this.database.prepare(`
                UPDATE RecoverySafetyState
                SET reconciliationStatus = ?, reconciliationRunAt = ?,
                    lastReportJson = ?, updatedAt = ?
                WHERE recoveryStateId = 'central'
            `).run(status, now, serialize(report), now);
            if (status === "BLOCKED") {
                this.insertEvent(
                    "RECONCILIATION_BLOCKED",
                    this.getStatus().sourceBackupId,
                    now,
                    { reportId: report.reportId }
                );
            }
            return this.getStatus();
        });
    }

    releaseSafeWork({ decisionId }) {
        const normalizedDecisionId = requiredDecisionId(decisionId);
        const now = this.clock().toISOString();
        return this.eventStore.transaction(() => {
            const result = this.database.prepare(`
                UPDATE RestoredCommandReviews
                SET reviewStatus = 'SAFE_WORK_RELEASED', reviewedAt = ?,
                    reviewDecisionId = ?
                WHERE classification = 'PROVEN_NOT_SENT'
                  AND reviewStatus = 'REVIEW_REQUIRED'
            `).run(now, normalizedDecisionId);
            const released = Number(result.changes);
            const unresolved = Number(this.database.prepare(`
                SELECT COUNT(*) AS count FROM RestoredCommandReviews
                WHERE reviewStatus = 'REVIEW_REQUIRED'
            `).get().count);
            this.database.prepare(`
                UPDATE RecoverySafetyState
                SET unresolvedCommandCount = ?, updatedAt = ?
                WHERE recoveryStateId = 'central'
            `).run(unresolved, now);
            this.insertEvent("SAFE_RESTORED_WORK_RELEASED", this.getStatus().sourceBackupId,
                now, { decisionId: normalizedDecisionId, released });
            return { released, unresolved };
        });
    }

    releaseWorkers({ decisionId }) {
        const normalizedDecisionId = requiredDecisionId(decisionId);
        const current = this.getStatus();
        if (!["PASS", "WARNING"].includes(current.reconciliationStatus)) {
            throw new Error("Workers cannot be released before successful reconciliation.");
        }
        const activeClaims = Number(this.database.prepare(`
            SELECT COUNT(*) AS count FROM DistributedWorkClaims
            WHERE state = 'ACTIVE'
        `).get().count);
        if (activeClaims > 0) {
            throw new Error("Workers cannot be released while restored active claims remain.");
        }
        const now = this.clock().toISOString();
        return this.eventStore.transaction(() => {
            this.database.prepare(`
                UPDATE RecoverySafetyState
                SET mode = 'NORMAL', releasedAt = ?, releaseDecisionId = ?,
                    updatedAt = ?
                WHERE recoveryStateId = 'central' AND mode = 'BLOCKED'
            `).run(now, normalizedDecisionId, now);
            this.insertEvent("WORKERS_RELEASED", current.sourceBackupId, now, {
                decisionId: normalizedDecisionId,
                unresolvedCommandsRemainIndividuallyBlocked:
                    this.getStatus().unresolvedCommandCount
            });
            this.logger?.warn?.({
                event: "recovery_workers_released",
                decisionId: normalizedDecisionId
            }, "Recovery worker release was explicitly approved");
            return this.getStatus();
        });
    }

    getDiagnostics() {
        const state = this.getStatus();
        const restoredClaims = Number(this.database.prepare(`
            SELECT COUNT(*) AS count FROM DistributedWorkClaims claim
            WHERE claim.state <> 'COMPLETED' AND EXISTS (
                SELECT 1 FROM WorkClaimHistory history
                WHERE history.workType = claim.workType
                  AND history.workItemId = claim.workItemId
                  AND history.action = 'RESTORE_FENCED'
            )
        `).get().count);
        const unresolvedCommands = Number(this.database.prepare(`
            SELECT COUNT(*) AS count FROM RestoredCommandReviews
            WHERE reviewStatus = 'REVIEW_REQUIRED'
        `).get().count);
        const eventCounts = Object.fromEntries(this.database.prepare(`
            SELECT eventType, COUNT(*) AS count FROM DisasterRecoveryEvents
            GROUP BY eventType ORDER BY eventType
        `).all().map(row => [row.eventType, Number(row.count)]));
        return {
            mode: this.isBlocked() ? "BLOCKED" : "NORMAL",
            persistentMode: state.mode,
            configurationBlock: state.configurationBlock,
            workersBlocked: this.isBlocked(),
            reconciliation: {
                status: state.reconciliationStatus,
                runAt: state.reconciliationRunAt
            },
            restoredAt: state.restoredAt,
            releasedAt: state.releasedAt,
            unresolvedRestoredClaims: restoredClaims,
            unresolvedRestoredDeviceCommands: unresolvedCommands,
            observabilityCounters: eventCounts
        };
    }

    insertEvent(eventType, backupId, occurredAt, details) {
        this.database.prepare(`
            INSERT INTO DisasterRecoveryEvents (
                eventType, backupId, occurredAt, detailsJson
            ) VALUES (?, ?, ?, ?)
        `).run(eventType, backupId || null, occurredAt, serialize(details));
    }
}
