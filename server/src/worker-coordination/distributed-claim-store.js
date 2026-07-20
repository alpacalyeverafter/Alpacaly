function serialize(value) {
    return JSON.stringify(value ?? null);
}

function parse(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    return typeof value === "string" ? JSON.parse(value) : value;
}

function mapClaim(row) {
    return row ? {
        workType: row.workType,
        workItemId: row.workItemId,
        state: row.state,
        workerId: row.workerId,
        serviceType: row.serviceType,
        claimedAt: row.claimedAt,
        leaseExpiresAt: row.leaseExpiresAt,
        maximumExpiresAt: row.maximumExpiresAt,
        heartbeatAt: row.heartbeatAt,
        attemptNumber: Number(row.attemptNumber),
        maximumAttempts: Number(row.maximumAttempts),
        claimGeneration: Number(row.claimGeneration),
        completedAt: row.completedAt,
        failedAt: row.failedAt,
        failureCode: row.failureCode,
        failureMessage: row.failureMessage,
        nextEligibleAt: row.nextEligibleAt,
        terminal: Boolean(row.terminal),
        operatorReviewRequired: Boolean(row.operatorReviewRequired),
        updatedAt: row.updatedAt,
        metadata: parse(row.metadataJson)
    } : null;
}

export class DistributedClaimStore {
    constructor({
        eventStore,
        clock = () => new Date(),
        leaseDurationMs = 30_000,
        maximumClaimDurationMs = 300_000,
        workerStaleThresholdMs = 45_000,
        clockSkewToleranceMs = 2_000,
        reclaimDelayMs = 1_000,
        maximumAttempts = 10
    }) {
        this.eventStore = eventStore;
        this.database = eventStore.database;
        this.clock = clock;
        this.leaseDurationMs = leaseDurationMs;
        this.maximumClaimDurationMs = maximumClaimDurationMs;
        this.workerStaleThresholdMs = workerStaleThresholdMs;
        this.clockSkewToleranceMs = clockSkewToleranceMs;
        this.reclaimDelayMs = reclaimDelayMs;
        this.maximumAttempts = maximumAttempts;
    }

    registerWorker(identity) {
        const now = this.clock().toISOString();
        this.database.prepare(`
            INSERT INTO WorkerInstances (
                workerId, serviceType, processInstanceId, bootId, startedAt,
                lastHeartbeatAt, stoppedAt, softwareVersion, environment,
                status, metadataJson
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'RUNNING', ?)
            ON CONFLICT (workerId) DO UPDATE SET
                serviceType = excluded.serviceType,
                processInstanceId = excluded.processInstanceId,
                bootId = excluded.bootId,
                startedAt = excluded.startedAt,
                lastHeartbeatAt = excluded.lastHeartbeatAt,
                stoppedAt = NULL,
                softwareVersion = excluded.softwareVersion,
                environment = excluded.environment,
                status = 'RUNNING',
                metadataJson = excluded.metadataJson
        `).run(
            identity.workerId,
            identity.serviceType,
            identity.processInstanceId,
            identity.bootId,
            identity.startedAt,
            now,
            identity.softwareVersion,
            identity.environment,
            serialize(identity.metadata)
        );
        return identity;
    }

    heartbeatWorker(identity) {
        const result = this.database.prepare(`
            UPDATE WorkerInstances
            SET lastHeartbeatAt = ?, status = 'RUNNING'
            WHERE workerId = ? AND bootId = ? AND status = 'RUNNING'
        `).run(this.clock().toISOString(), identity.workerId, identity.bootId);
        return Number(result.changes) === 1;
    }

    stopWorker(identity) {
        const now = this.clock().toISOString();
        this.database.prepare(`
            UPDATE WorkerInstances
            SET lastHeartbeatAt = ?, stoppedAt = ?, status = 'STOPPED'
            WHERE workerId = ? AND bootId = ?
        `).run(now, now, identity.workerId, identity.bootId);
    }

    claim(workType, workItemId, identity, options = {}) {
        const nowDate = this.clock();
        const now = nowDate.toISOString();
        const maximumAttempts = options.maximumAttempts || this.maximumAttempts;
        const leaseExpiresAt = new Date(
            nowDate.getTime() + (options.leaseDurationMs || this.leaseDurationMs)
        ).toISOString();
        const maximumExpiresAt = new Date(
            nowDate.getTime()
                + (options.maximumClaimDurationMs || this.maximumClaimDurationMs)
        ).toISOString();
        const expiredCutoff = new Date(
            nowDate.getTime() - this.clockSkewToleranceMs - this.reclaimDelayMs
        ).toISOString();

        return this.eventStore.transaction(() => {
            const inserted = this.database.prepare(`
                INSERT INTO DistributedWorkClaims (
                    workType, workItemId, state, workerId, serviceType,
                    claimedAt, leaseExpiresAt, maximumExpiresAt, heartbeatAt,
                    attemptNumber, maximumAttempts, claimGeneration,
                    completedAt, failedAt, failureCode, failureMessage,
                    nextEligibleAt, terminal, operatorReviewRequired,
                    updatedAt, metadataJson
                ) VALUES (
                    ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?,
                    1, ?, 1, NULL, NULL, NULL, NULL, NULL, 0, 0, ?, ?
                ) ON CONFLICT (workType, workItemId) DO NOTHING
            `).run(
                workType,
                workItemId,
                identity.workerId,
                identity.serviceType,
                now,
                leaseExpiresAt,
                maximumExpiresAt,
                now,
                maximumAttempts,
                now,
                serialize(options.metadata)
            );
            if (Number(inserted.changes) === 1) {
                this.appendHistory({
                    workType,
                    workItemId,
                    claimGeneration: 1,
                    workerId: identity.workerId,
                    action: "CLAIMED",
                    occurredAt: now,
                    details: { attemptNumber: 1, newClaim: true }
                });
                return this.get(workType, workItemId, { lock: false });
            }

            const existing = this.get(workType, workItemId, { lock: true });
            if (!existing || existing.terminal || [
                "COMPLETED", "DEAD_LETTER", "OPERATOR_REVIEW"
            ].includes(existing.state)) {
                return null;
            }
            const activeExpired = existing.state === "ACTIVE"
                && existing.leaseExpiresAt <= expiredCutoff;
            const failedReady = existing.state === "FAILED"
                && (!existing.nextEligibleAt || existing.nextEligibleAt <= now);
            const availableReady = existing.state === "AVAILABLE"
                && (options.force
                    || !existing.nextEligibleAt
                    || existing.nextEligibleAt <= now);
            if (!(availableReady || activeExpired || failedReady)) {
                return null;
            }
            if (existing.attemptNumber >= existing.maximumAttempts) {
                this.terminalizeExhausted(existing, now);
                return null;
            }

            const nextGeneration = existing.claimGeneration + 1;
            const updated = this.database.prepare(`
                UPDATE DistributedWorkClaims
                SET state = 'ACTIVE', workerId = ?, serviceType = ?,
                    claimedAt = ?, leaseExpiresAt = ?, maximumExpiresAt = ?,
                    heartbeatAt = ?, attemptNumber = attemptNumber + 1,
                    claimGeneration = ?, completedAt = NULL, failedAt = NULL,
                    failureCode = NULL, failureMessage = NULL,
                    nextEligibleAt = NULL, terminal = 0,
                    operatorReviewRequired = 0, updatedAt = ?, metadataJson = ?
                WHERE workType = ? AND workItemId = ? AND claimGeneration = ?
            `).run(
                identity.workerId,
                identity.serviceType,
                now,
                leaseExpiresAt,
                maximumExpiresAt,
                now,
                nextGeneration,
                now,
                serialize(options.metadata ?? existing.metadata),
                workType,
                workItemId,
                existing.claimGeneration
            );
            if (Number(updated.changes) !== 1) {
                return null;
            }
            this.appendHistory({
                workType,
                workItemId,
                claimGeneration: nextGeneration,
                workerId: identity.workerId,
                action: activeExpired ? "LEASE_RECLAIMED" : "CLAIMED",
                occurredAt: now,
                details: {
                    priorWorkerId: existing.workerId,
                    attemptNumber: existing.attemptNumber + 1
                }
            });
            return this.get(workType, workItemId, { lock: false });
        });
    }

    extend(claim, identity, { leaseDurationMs = this.leaseDurationMs } = {}) {
        const nowDate = this.clock();
        const maximum = Date.parse(claim.maximumExpiresAt);
        const desired = nowDate.getTime() + leaseDurationMs;
        const leaseExpiresAt = new Date(Math.min(maximum, desired)).toISOString();
        if (!Number.isFinite(maximum) || maximum <= nowDate.getTime()) {
            return false;
        }
        const result = this.database.prepare(`
            UPDATE DistributedWorkClaims
            SET leaseExpiresAt = ?, heartbeatAt = ?, updatedAt = ?
            WHERE workType = ? AND workItemId = ? AND state = 'ACTIVE'
              AND workerId = ? AND claimGeneration = ?
              AND maximumExpiresAt > ?
        `).run(
            leaseExpiresAt,
            nowDate.toISOString(),
            nowDate.toISOString(),
            claim.workType,
            claim.workItemId,
            identity.workerId,
            claim.claimGeneration,
            nowDate.toISOString()
        );
        return Number(result.changes) === 1;
    }

    complete(claim, identity, details = null) {
        const now = this.clock().toISOString();
        return this.eventStore.transaction(() => this.completeWithinTransaction(
            claim,
            identity,
            now,
            details
        ));
    }

    completeWithinTransaction(claim, identity, occurredAt, details = null) {
        const result = this.database.prepare(`
            UPDATE DistributedWorkClaims
            SET state = 'COMPLETED', completedAt = ?, leaseExpiresAt = NULL,
                heartbeatAt = ?, terminal = 1, updatedAt = ?
            WHERE workType = ? AND workItemId = ? AND state = 'ACTIVE'
              AND workerId = ? AND claimGeneration = ?
        `).run(
            occurredAt,
            occurredAt,
            occurredAt,
            claim.workType,
            claim.workItemId,
            identity.workerId,
            claim.claimGeneration
        );
        if (Number(result.changes) !== 1) {
            return false;
        }
        this.appendHistory({
            ...claim,
            workerId: identity.workerId,
            action: "COMPLETED",
            occurredAt,
            details
        });
        return true;
    }

    release(claim, identity, { nextEligibleAt = null, reason = "RELEASED" } = {}) {
        const now = this.clock().toISOString();
        const result = this.database.prepare(`
            UPDATE DistributedWorkClaims
            SET state = 'AVAILABLE', workerId = NULL, claimedAt = NULL,
                leaseExpiresAt = NULL, maximumExpiresAt = NULL,
                heartbeatAt = NULL, nextEligibleAt = ?,
                attemptNumber = CASE
                    WHEN attemptNumber > 0 THEN attemptNumber - 1 ELSE 0
                END,
                updatedAt = ?
            WHERE workType = ? AND workItemId = ? AND state = 'ACTIVE'
              AND workerId = ? AND claimGeneration = ?
        `).run(
            nextEligibleAt,
            now,
            claim.workType,
            claim.workItemId,
            identity.workerId,
            claim.claimGeneration
        );
        if (Number(result.changes) === 1) {
            this.appendHistory({
                ...claim,
                workerId: identity.workerId,
                action: "RELEASED",
                occurredAt: now,
                details: { reason, nextEligibleAt }
            });
            return true;
        }
        return false;
    }

    fail(claim, identity, {
        error,
        retryAt = null,
        failureCode = "WORK_FAILED",
        potentiallyCompleted = false,
        nonRetryable = false,
        details = null
    } = {}) {
        const now = this.clock().toISOString();
        const latest = this.get(claim.workType, claim.workItemId);
        if (!latest || latest.state !== "ACTIVE"
            || latest.workerId !== identity.workerId
            || latest.claimGeneration !== claim.claimGeneration) {
            return false;
        }
        const exhausted = latest.attemptNumber >= latest.maximumAttempts;
        const state = potentiallyCompleted
            ? "OPERATOR_REVIEW"
            : (nonRetryable || exhausted ? "DEAD_LETTER" : "FAILED");
        const terminal = state === "FAILED" ? 0 : 1;
        const message = String(error?.message || error || "Work failed").slice(0, 1000);
        const result = this.database.prepare(`
            UPDATE DistributedWorkClaims
            SET state = ?, failedAt = ?, failureCode = ?, failureMessage = ?,
                leaseExpiresAt = NULL, heartbeatAt = ?, nextEligibleAt = ?,
                terminal = ?, operatorReviewRequired = ?, updatedAt = ?
            WHERE workType = ? AND workItemId = ? AND state = 'ACTIVE'
              AND workerId = ? AND claimGeneration = ?
        `).run(
            state,
            now,
            failureCode,
            message,
            now,
            state === "FAILED" ? retryAt : null,
            terminal,
            state === "OPERATOR_REVIEW" ? 1 : 0,
            now,
            claim.workType,
            claim.workItemId,
            identity.workerId,
            claim.claimGeneration
        );
        if (Number(result.changes) === 1) {
            this.appendHistory({
                ...claim,
                workerId: identity.workerId,
                action: state,
                occurredAt: now,
                details: { ...details, failureCode, message, retryAt }
            });
            return true;
        }
        return false;
    }

    get(workType, workItemId, { lock = false } = {}) {
        const suffix = lock && this.eventStore.databaseType === "postgres"
            ? " FOR UPDATE" : "";
        return mapClaim(this.database.prepare(`
            SELECT * FROM DistributedWorkClaims
            WHERE workType = ? AND workItemId = ?${suffix}
        `).get(workType, workItemId));
    }

    getHistory(workType, workItemId) {
        return this.database.prepare(`
            SELECT * FROM WorkClaimHistory
            WHERE workType = ? AND workItemId = ?
            ORDER BY claimHistorySequence ASC
        `).all(workType, workItemId).map(row => ({
            ...row,
            claimGeneration: Number(row.claimGeneration),
            details: parse(row.detailsJson)
        }));
    }

    getDiagnostics() {
        const staleCutoff = new Date(
            this.clock().getTime() - this.workerStaleThresholdMs
        ).toISOString();
        this.database.prepare(`
            UPDATE WorkerInstances SET status = 'STALE'
            WHERE status = 'RUNNING' AND lastHeartbeatAt < ?
        `).run(staleCutoff);
        const counts = this.database.prepare(`
            SELECT state, COUNT(*) AS count
            FROM DistributedWorkClaims GROUP BY state ORDER BY state
        `).all();
        const workers = this.database.prepare(`
            SELECT status, COUNT(*) AS count
            FROM WorkerInstances GROUP BY status ORDER BY status
        `).all();
        return {
            claims: Object.fromEntries(counts.map(row => [row.state, Number(row.count)])),
            workers: Object.fromEntries(workers.map(row => [row.status, Number(row.count)]))
        };
    }

    appendHistory({
        workType,
        workItemId,
        claimGeneration,
        workerId,
        action,
        occurredAt,
        details
    }) {
        this.database.prepare(`
            INSERT INTO WorkClaimHistory (
                workType, workItemId, claimGeneration, workerId,
                action, occurredAt, detailsJson
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            workType,
            workItemId,
            claimGeneration,
            workerId,
            action,
            occurredAt,
            serialize(details)
        );
    }

    terminalizeExhausted(claim, occurredAt) {
        this.database.prepare(`
            UPDATE DistributedWorkClaims
            SET state = 'DEAD_LETTER', terminal = 1, failedAt = ?,
                failureCode = 'MAXIMUM_ATTEMPTS_EXHAUSTED',
                failureMessage = 'Maximum claim attempts exhausted', updatedAt = ?
            WHERE workType = ? AND workItemId = ? AND claimGeneration = ?
        `).run(
            occurredAt,
            occurredAt,
            claim.workType,
            claim.workItemId,
            claim.claimGeneration
        );
        this.appendHistory({
            ...claim,
            action: "DEAD_LETTER",
            occurredAt,
            details: { reason: "MAXIMUM_ATTEMPTS_EXHAUSTED" }
        });
    }
}

export function createDistributedClaimStore({ eventStore, config, clock }) {
    return new DistributedClaimStore({
        eventStore,
        clock,
        leaseDurationMs: config.workerLeaseDurationMs,
        maximumClaimDurationMs: config.workerMaximumClaimDurationMs,
        workerStaleThresholdMs: config.workerStaleThresholdMs,
        clockSkewToleranceMs: config.workerClockSkewToleranceMs,
        reclaimDelayMs: config.workerReclaimDelayMs,
        maximumAttempts: config.workerMaximumAttempts
    });
}
