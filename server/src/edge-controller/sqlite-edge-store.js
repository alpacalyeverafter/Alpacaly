import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const COMMAND_STATES = [
    "RECEIVED", "ACCEPTED", "STARTED", "COMPLETED", "REJECTED", "FAILED",
    "CANCELLED", "OUTCOME_UNKNOWN"
];
const CYCLE_STATES = [
    "RESERVED", "SAFETY_CHECKING", "BELL_PENDING", "BELL_ACTIVE", "COUNTDOWN",
    "FINAL_CHECK", "STARTED", "DISPENSING", "EVIDENCE_COLLECTION", "COMPLETED",
    "FAILED", "CANCELLED", "OUTCOME_UNKNOWN", "OPERATOR_LOCKOUT"
];

function json(value) {
    return JSON.stringify(value ?? null);
}

function parse(value, fallback = null) {
    if (value === null || value === undefined || value === "") return fallback;
    return JSON.parse(value);
}

function bool(value) {
    return value === null || value === undefined ? null : value === 1;
}

function edgeError(message, code) {
    return Object.assign(new Error(message), { code });
}

function requirePositiveNumber(value, name, { integer = false, allowZero = false } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number))
        || (allowZero ? number < 0 : number <= 0)) {
        throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"}${
            integer ? " integer" : " number"}.`);
    }
    return number;
}

function validateWelfareConfiguration(configuration) {
    if (!configuration?.version || typeof configuration.version !== "string") {
        throw new Error("Welfare configuration version is required.");
    }
    for (const name of [
        "maximumMotorDurationMs", "rollingPeriodMs", "maximumCyclesPerRollingPeriod",
        "maximumCyclesPerSession", "maximumQuantityPerSession",
        "maximumConsecutiveFailures", "maximumSensorDisagreements",
        "maximumConfigurationAgeMs", "maximumBellRepetitions",
        "maximumCountdownAttempts"
    ]) {
        requirePositiveNumber(configuration[name], name, {
            integer: name !== "maximumQuantityPerSession"
        });
    }
    for (const name of ["minimumIntervalMs", "cooldownAfterFailureMs"]) {
        requirePositiveNumber(configuration[name], name, { integer: true, allowZero: true });
    }
    const tolerance = requirePositiveNumber(
        configuration.quantityTolerance,
        "quantityTolerance",
        { allowZero: true }
    );
    if (tolerance > 1) throw new Error("quantityTolerance must not exceed 1.");
    if (!Array.isArray(configuration.permittedWindows)
        || configuration.permittedWindows.length === 0
        || configuration.permittedWindows.some(window => (
            !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(window?.start || ""))
            || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(window?.end || ""))
        ))) {
        throw new Error("permittedWindows must contain valid 24-hour start/end values.");
    }
}

function validateCalibrationRecord(record) {
    const requiredText = [
        "calibrationId", "feederId", "version", "feedType",
        "hopperFillConditions", "createdAt", "expiresAt", "notes"
    ];
    for (const key of requiredText) {
        if (typeof record?.[key] !== "string" || !record[key].trim()) {
            throw new Error(`Calibration ${key} is required.`);
        }
    }
    requirePositiveNumber(record.testCount, "calibration testCount", { integer: true });
    const hasCommandBasis = Number.isFinite(Number(record.commandedDurationMs))
        || Number.isFinite(Number(record.commandedRotations));
    if (!hasCommandBasis) {
        throw new Error("Calibration requires commanded duration or rotations.");
    }
    if (!Array.isArray(record.measuredOutputValues) || record.measuredOutputValues.length === 0
        || record.measuredOutputValues.some(value => !Number.isFinite(Number(value)))) {
        throw new Error("Calibration measuredOutputValues are required.");
    }
    requirePositiveNumber(record.average, "calibration average", { allowZero: true });
    requirePositiveNumber(record.variance ?? record.spread,
        "calibration variance or spread", { allowZero: true });
    requirePositiveNumber(record.tolerance, "calibration tolerance", { allowZero: true });
    if (!Number.isFinite(Date.parse(record.createdAt))
        || !Number.isFinite(Date.parse(record.expiresAt))
        || Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) {
        throw new Error("Calibration timestamps require a future expiry.");
    }
    if (typeof record.approved !== "boolean" || typeof record.simulated !== "boolean") {
        throw new Error("Calibration approved and simulated flags must be explicit booleans.");
    }
    if (record.approved && (!record.approvingOperatorIdentity
        || typeof record.approvingOperatorIdentity !== "string")) {
        throw new Error("Approved calibration requires an approving operator identity.");
    }
}

function mapCommand(row) {
    return row ? {
        journalSequence: row.journalSequence,
        commandId: row.commandId,
        deliveryId: row.deliveryId,
        eventId: row.eventId,
        cycleId: row.cycleId,
        controllerId: row.controllerId,
        barnId: row.barnId,
        feederId: row.feederId,
        deviceId: row.deviceId,
        assignmentGeneration: row.assignmentGeneration,
        fencingToken: row.fencingToken,
        authorityLeaseExpiresAt: row.authorityLeaseExpiresAt,
        commandExpiresAt: row.commandExpiresAt,
        action: row.action,
        parameters: parse(row.parametersJson, {}),
        calibrationVersion: row.calibrationVersion,
        welfareConfigurationVersion: row.welfareConfigurationVersion,
        controllerBootId: row.controllerBootId,
        state: row.state,
        receivedAt: row.receivedAt,
        acceptedAt: row.acceptedAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        updatedAt: row.updatedAt,
        finalAcknowledgement: parse(row.finalAcknowledgementJson),
        acknowledgementDeliveryStatus: row.acknowledgementDeliveryStatus,
        acknowledgementDeliveredAt: row.acknowledgementDeliveredAt,
        reconciliationStatus: row.reconciliationStatus,
        operatorResolutionRequired: row.operatorResolutionRequired === 1,
        failureCode: row.failureCode,
        failureMessage: row.failureMessage
    } : null;
}

function mapCycle(row) {
    return row ? {
        cycleSequence: row.cycleSequence,
        cycleId: row.cycleId,
        eventKey: row.eventKey,
        eventId: row.eventId,
        controllerId: row.controllerId,
        barnId: row.barnId,
        feederId: row.feederId,
        bellCommandId: row.bellCommandId,
        dispenseCommandId: row.dispenseCommandId,
        state: row.state,
        bellState: row.bellState,
        bellEvidence: parse(row.bellEvidenceJson),
        bellRepetitionCount: row.bellRepetitionCount,
        countdownState: row.countdownState,
        countdownAttemptCount: row.countdownAttemptCount,
        outputAuthorityState: row.outputAuthorityState,
        motorStartEvidence: parse(row.motorStartEvidenceJson),
        motorStopEvidence: parse(row.motorStopEvidenceJson),
        sensorEvidence: parse(row.sensorEvidenceJson),
        feedMovementOccurred: bool(row.feedMovementOccurred),
        measuredQuantity: row.measuredQuantity,
        outcome: row.outcome,
        lockoutReasons: parse(row.lockoutReasonsJson, []),
        calibrationVersion: row.calibrationVersion,
        welfareConfigurationVersion: row.welfareConfigurationVersion,
        controllerBootId: row.controllerBootId,
        reservedAt: row.reservedAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        updatedAt: row.updatedAt
    } : null;
}

export class SqliteEdgeStore {
    constructor({
        databasePath,
        controllerId,
        clock = () => new Date(),
        idGenerator = randomUUID,
        logger = null
    }) {
        if (!databasePath) throw new Error("SqliteEdgeStore requires databasePath.");
        this.databasePath = databasePath;
        this.controllerId = controllerId;
        this.clock = clock;
        this.idGenerator = idGenerator;
        this.logger = logger;
        if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
        try {
            this.database = new DatabaseSync(databasePath);
            this.configure();
            this.migrate();
            const integrity = this.database.prepare("PRAGMA integrity_check;").get();
            if (integrity.integrity_check !== "ok") {
                throw edgeError("The edge journal failed its integrity check.", "EDGE_JOURNAL_CORRUPT");
            }
            this.prepare();
        } catch (error) {
            try { this.database?.close(); } catch {}
            if (String(error.code || "").includes("CORRUPT")
                || String(error.code || "").includes("NOTADB")
                || /not a database|malformed/i.test(String(error.message || ""))) {
                error.code = "EDGE_JOURNAL_CORRUPT";
            } else if (!error.code) {
                error.code = "EDGE_JOURNAL_OPEN_FAILED";
            }
            throw error;
        }
    }

    configure() {
        this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
        if (this.databasePath !== ":memory:") {
            this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
        }
    }

    migrate() {
        const version = Number(this.database.prepare("PRAGMA user_version;").get().user_version);
        if (version > 1) throw new Error(`Edge schema version ${version} is newer than supported version 1.`);
        if (version === 1) return;
        const commandStates = COMMAND_STATES.map(item => `'${item}'`).join(",");
        const cycleStates = CYCLE_STATES.map(item => `'${item}'`).join(",");
        this.database.exec("BEGIN IMMEDIATE;");
        try {
            this.database.exec(`
                CREATE TABLE EdgeControllerRuntime (
                    controllerId TEXT PRIMARY KEY,
                    bootId TEXT,
                    bootCounter INTEGER NOT NULL DEFAULT 0 CHECK (bootCounter >= 0),
                    lastBootAt TEXT,
                    lastSafeShutdownAt TEXT,
                    journalSchemaVersion INTEGER NOT NULL DEFAULT 1
                ) STRICT, WITHOUT ROWID;

                CREATE TABLE EdgeAssignments (
                    feederId TEXT PRIMARY KEY,
                    controllerId TEXT NOT NULL,
                    barnId TEXT NOT NULL,
                    assignmentGeneration INTEGER NOT NULL CHECK (assignmentGeneration > 0),
                    authorityLeaseExpiresAt TEXT NOT NULL,
                    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
                    receivedAt TEXT NOT NULL
                ) STRICT, WITHOUT ROWID;

                CREATE TABLE EdgeSafetyStates (
                    scopeKey TEXT PRIMARY KEY,
                    level TEXT NOT NULL CHECK (level IN ('PLATFORM','BARN','FEEDER')),
                    barnId TEXT,
                    feederId TEXT,
                    generation INTEGER NOT NULL CHECK (generation > 0),
                    active INTEGER NOT NULL CHECK (active IN (0,1)),
                    reason TEXT,
                    expiresAt TEXT NOT NULL,
                    receivedAt TEXT NOT NULL
                ) STRICT, WITHOUT ROWID;

                CREATE TABLE EdgeCommands (
                    journalSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    commandId TEXT NOT NULL UNIQUE,
                    deliveryId TEXT NOT NULL,
                    eventId TEXT,
                    cycleId TEXT NOT NULL,
                    controllerId TEXT NOT NULL,
                    barnId TEXT NOT NULL,
                    feederId TEXT NOT NULL,
                    deviceId TEXT NOT NULL,
                    assignmentGeneration INTEGER NOT NULL CHECK (assignmentGeneration > 0),
                    fencingToken INTEGER NOT NULL CHECK (fencingToken > 0),
                    authorityLeaseExpiresAt TEXT NOT NULL,
                    commandExpiresAt TEXT NOT NULL,
                    action TEXT NOT NULL CHECK (action IN ('RING_BELL','DISPENSE_FEED')),
                    parametersJson TEXT NOT NULL,
                    calibrationVersion TEXT,
                    welfareConfigurationVersion TEXT,
                    controllerBootId TEXT NOT NULL,
                    state TEXT NOT NULL CHECK (state IN (${commandStates})),
                    receivedAt TEXT NOT NULL,
                    acceptedAt TEXT,
                    startedAt TEXT,
                    completedAt TEXT,
                    updatedAt TEXT NOT NULL,
                    finalAcknowledgementJson TEXT,
                    acknowledgementDeliveryStatus TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (acknowledgementDeliveryStatus IN ('PENDING','DELIVERED','LOST')),
                    acknowledgementDeliveredAt TEXT,
                    reconciliationStatus TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (reconciliationStatus IN ('PENDING','DELIVERED','RECONCILED','OUTCOME_UNKNOWN')),
                    operatorResolutionRequired INTEGER NOT NULL DEFAULT 0
                        CHECK (operatorResolutionRequired IN (0,1)),
                    failureCode TEXT,
                    failureMessage TEXT,
                    UNIQUE (controllerId, feederId, fencingToken, action)
                ) STRICT;

                CREATE TABLE EdgeFeedCycles (
                    cycleSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    cycleId TEXT NOT NULL UNIQUE,
                    eventKey TEXT NOT NULL UNIQUE,
                    eventId TEXT,
                    controllerId TEXT NOT NULL,
                    barnId TEXT NOT NULL,
                    feederId TEXT NOT NULL,
                    bellCommandId TEXT UNIQUE,
                    dispenseCommandId TEXT UNIQUE,
                    state TEXT NOT NULL CHECK (state IN (${cycleStates})),
                    bellState TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
                    bellEvidenceJson TEXT,
                    bellRepetitionCount INTEGER NOT NULL DEFAULT 0 CHECK (bellRepetitionCount >= 0),
                    countdownState TEXT NOT NULL DEFAULT 'NOT_STARTED',
                    countdownAttemptCount INTEGER NOT NULL DEFAULT 0 CHECK (countdownAttemptCount >= 0),
                    outputAuthorityState TEXT NOT NULL DEFAULT 'OFF',
                    motorStartEvidenceJson TEXT,
                    motorStopEvidenceJson TEXT,
                    sensorEvidenceJson TEXT,
                    feedMovementOccurred INTEGER CHECK (feedMovementOccurred IN (0,1)),
                    measuredQuantity REAL,
                    outcome TEXT,
                    lockoutReasonsJson TEXT NOT NULL DEFAULT '[]',
                    calibrationVersion TEXT,
                    welfareConfigurationVersion TEXT,
                    controllerBootId TEXT NOT NULL,
                    reservedAt TEXT NOT NULL,
                    startedAt TEXT,
                    completedAt TEXT,
                    updatedAt TEXT NOT NULL
                ) STRICT;

                CREATE TABLE EdgeCommandHistory (
                    historySequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    commandId TEXT NOT NULL,
                    fromState TEXT,
                    toState TEXT NOT NULL,
                    occurredAt TEXT NOT NULL,
                    detailsJson TEXT NOT NULL DEFAULT 'null',
                    FOREIGN KEY (commandId) REFERENCES EdgeCommands(commandId) ON DELETE RESTRICT
                ) STRICT;

                CREATE TABLE EdgeCycleHistory (
                    historySequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    cycleId TEXT NOT NULL,
                    fromState TEXT,
                    toState TEXT NOT NULL,
                    occurredAt TEXT NOT NULL,
                    detailsJson TEXT NOT NULL DEFAULT 'null',
                    FOREIGN KEY (cycleId) REFERENCES EdgeFeedCycles(cycleId) ON DELETE RESTRICT
                ) STRICT;

                CREATE TABLE EdgeWelfareConfigurations (
                    version TEXT PRIMARY KEY,
                    configurationJson TEXT NOT NULL,
                    createdAt TEXT NOT NULL,
                    expiresAt TEXT NOT NULL,
                    installedAt TEXT NOT NULL,
                    active INTEGER NOT NULL CHECK (active IN (0,1))
                ) STRICT, WITHOUT ROWID;

                CREATE TABLE EdgeCalibrationRecords (
                    calibrationId TEXT PRIMARY KEY,
                    feederId TEXT NOT NULL,
                    version TEXT NOT NULL,
                    recordJson TEXT NOT NULL,
                    createdAt TEXT NOT NULL,
                    expiresAt TEXT NOT NULL,
                    approved INTEGER NOT NULL CHECK (approved IN (0,1)),
                    simulated INTEGER NOT NULL CHECK (simulated IN (0,1)),
                    UNIQUE (feederId, version)
                ) STRICT, WITHOUT ROWID;

                CREATE TABLE EdgeSafetyCycleTokens (
                    cycleToken TEXT PRIMARY KEY,
                    safetyControllerBootId TEXT NOT NULL,
                    consumedAt TEXT NOT NULL
                ) STRICT, WITHOUT ROWID;

                CREATE TABLE EdgeMaintenanceState (
                    controllerId TEXT PRIMARY KEY,
                    state TEXT NOT NULL CHECK (state IN ('NORMAL','MAINTENANCE','RESET_REQUIRED')),
                    sessionId TEXT,
                    localPresenceEvidence TEXT,
                    enteredAt TEXT,
                    expiresAt TEXT,
                    exitedAt TEXT,
                    updatedAt TEXT NOT NULL
                ) STRICT, WITHOUT ROWID;

                CREATE TABLE EdgeLocalAuditRecords (
                    auditSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    auditId TEXT NOT NULL UNIQUE,
                    action TEXT NOT NULL,
                    feederId TEXT,
                    cycleId TEXT,
                    maintenanceSessionId TEXT,
                    operatorIdentity TEXT,
                    occurredAt TEXT NOT NULL,
                    detailsJson TEXT NOT NULL DEFAULT 'null'
                ) STRICT;

                CREATE TABLE EdgeObservabilityCounters (
                    name TEXT PRIMARY KEY,
                    value INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
                    lastOccurredAt TEXT,
                    lastDetailsJson TEXT NOT NULL DEFAULT 'null'
                ) STRICT, WITHOUT ROWID;

                CREATE INDEX edge_commands_recent ON EdgeCommands(journalSequence DESC);
                CREATE INDEX edge_cycles_feeder_recent ON EdgeFeedCycles(feederId, cycleSequence DESC);
                CREATE INDEX edge_audit_recent ON EdgeLocalAuditRecords(auditSequence DESC);

                CREATE TRIGGER edge_command_history_append_only_update BEFORE UPDATE ON EdgeCommandHistory
                BEGIN SELECT RAISE(ABORT, 'Edge command history is append-only'); END;
                CREATE TRIGGER edge_command_history_append_only_delete BEFORE DELETE ON EdgeCommandHistory
                BEGIN SELECT RAISE(ABORT, 'Edge command history is append-only'); END;
                CREATE TRIGGER edge_cycle_history_append_only_update BEFORE UPDATE ON EdgeCycleHistory
                BEGIN SELECT RAISE(ABORT, 'Edge cycle history is append-only'); END;
                CREATE TRIGGER edge_cycle_history_append_only_delete BEFORE DELETE ON EdgeCycleHistory
                BEGIN SELECT RAISE(ABORT, 'Edge cycle history is append-only'); END;
                CREATE TRIGGER edge_local_audit_append_only_update BEFORE UPDATE ON EdgeLocalAuditRecords
                BEGIN SELECT RAISE(ABORT, 'Edge local audit is append-only'); END;
                CREATE TRIGGER edge_local_audit_append_only_delete BEFORE DELETE ON EdgeLocalAuditRecords
                BEGIN SELECT RAISE(ABORT, 'Edge local audit is append-only'); END;
            `);
            this.database.exec("PRAGMA user_version = 1; COMMIT;");
        } catch (error) {
            this.database.exec("ROLLBACK;");
            throw error;
        }
    }

    prepare() {
        this.statements = {
            command: this.database.prepare("SELECT * FROM EdgeCommands WHERE commandId = ?"),
            cycle: this.database.prepare("SELECT * FROM EdgeFeedCycles WHERE cycleId = ?"),
            cycleByEvent: this.database.prepare("SELECT * FROM EdgeFeedCycles WHERE eventKey = ?"),
            recentCommands: this.database.prepare(
                "SELECT * FROM EdgeCommands ORDER BY journalSequence DESC LIMIT ?"
            ),
            recentCycles: this.database.prepare(
                "SELECT * FROM EdgeFeedCycles ORDER BY cycleSequence DESC LIMIT ?"
            )
        };
    }

    startBoot(controllerId = this.controllerId, timestamp = this.clock().toISOString()) {
        const bootId = `edge_boot_${this.idGenerator()}`;
        this.database.prepare(`
            INSERT INTO EdgeControllerRuntime (controllerId, bootId, bootCounter, lastBootAt)
            VALUES (?, ?, 1, ?)
            ON CONFLICT(controllerId) DO UPDATE SET
                bootId = excluded.bootId,
                bootCounter = EdgeControllerRuntime.bootCounter + 1,
                lastBootAt = excluded.lastBootAt,
                lastSafeShutdownAt = NULL
        `).run(controllerId, bootId, timestamp);
        this.incrementCounter("edge_restart", { bootId }, timestamp);
        return this.getRuntime(controllerId);
    }

    getRuntime(controllerId = this.controllerId) {
        const row = this.database.prepare(
            "SELECT * FROM EdgeControllerRuntime WHERE controllerId = ?"
        ).get(controllerId);
        return row ? { ...row } : null;
    }

    safeShutdown(timestamp = this.clock().toISOString()) {
        this.database.prepare(`
            UPDATE EdgeControllerRuntime SET lastSafeShutdownAt = ? WHERE controllerId = ?
        `).run(timestamp, this.controllerId);
    }

    saveAssignment(assignment, timestamp = this.clock().toISOString()) {
        const current = this.getAssignment(assignment.feederId);
        if (current && assignment.assignmentGeneration < current.assignmentGeneration) {
            this.incrementCounter("stale_assignment", assignment, timestamp);
            return { assignment: current, stale: true };
        }
        this.database.prepare(`
            INSERT INTO EdgeAssignments (
                feederId, controllerId, barnId, assignmentGeneration,
                authorityLeaseExpiresAt, enabled, receivedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(feederId) DO UPDATE SET
                controllerId=excluded.controllerId, barnId=excluded.barnId,
                assignmentGeneration=excluded.assignmentGeneration,
                authorityLeaseExpiresAt=excluded.authorityLeaseExpiresAt,
                enabled=excluded.enabled, receivedAt=excluded.receivedAt
        `).run(
            assignment.feederId, assignment.controllerId, assignment.barnId,
            assignment.assignmentGeneration, assignment.authorityLeaseExpiresAt,
            assignment.enabled === false ? 0 : 1, timestamp
        );
        return { assignment: this.getAssignment(assignment.feederId), stale: false };
    }

    getAssignment(feederId) {
        const row = this.database.prepare(
            "SELECT * FROM EdgeAssignments WHERE feederId = ?"
        ).get(feederId);
        return row ? { ...row, enabled: row.enabled === 1 } : null;
    }

    saveSafetyState(state, timestamp = this.clock().toISOString()) {
        const current = this.getSafetyState(state.scopeKey);
        if (current && state.generation < current.generation) {
            this.incrementCounter("stale_safety_state", state, timestamp);
            return { state: current, stale: true };
        }
        this.database.prepare(`
            INSERT INTO EdgeSafetyStates (
                scopeKey, level, barnId, feederId, generation, active,
                reason, expiresAt, receivedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scopeKey) DO UPDATE SET level=excluded.level,
                barnId=excluded.barnId, feederId=excluded.feederId,
                generation=excluded.generation, active=excluded.active,
                reason=excluded.reason, expiresAt=excluded.expiresAt,
                receivedAt=excluded.receivedAt
        `).run(
            state.scopeKey, state.level, state.barnId || null, state.feederId || null,
            state.generation, state.active ? 1 : 0, state.reason || null,
            state.expiresAt, timestamp
        );
        if (state.active) this.incrementCounter("software_emergency_stop", state, timestamp);
        return { state: this.getSafetyState(state.scopeKey), stale: false };
    }

    getSafetyState(scopeKey) {
        const row = this.database.prepare(
            "SELECT * FROM EdgeSafetyStates WHERE scopeKey = ?"
        ).get(scopeKey);
        return row ? { ...row, active: row.active === 1 } : null;
    }

    getSafetyStates() {
        return this.database.prepare("SELECT * FROM EdgeSafetyStates ORDER BY scopeKey")
            .all().map(row => ({ ...row, active: row.active === 1 }));
    }

    reserveCommand(envelope, bootId, timestamp = this.clock().toISOString()) {
        const existing = this.getCommand(envelope.commandId);
        if (existing) {
            this.incrementCounter("duplicate_command", { commandId: envelope.commandId }, timestamp);
            return { command: existing, cycle: this.getCycle(existing.cycleId), created: false };
        }
        const eventKey = envelope.eventId || envelope.commandId;
        let cycle = this.getCycleByEvent(eventKey);
        const cycleId = cycle?.cycleId || `feed_cycle_${this.idGenerator()}`;
        if (cycle && envelope.action === "DISPENSE_FEED"
            && cycle.dispenseCommandId && cycle.dispenseCommandId !== envelope.commandId) {
            throw edgeError("The feed cycle already has a dispense command.", "FEED_CYCLE_ALREADY_RESERVED");
        }
        if (cycle && envelope.action === "RING_BELL"
            && cycle.bellCommandId && cycle.bellCommandId !== envelope.commandId) {
            throw edgeError("The feed cycle already has a bell command.", "FEED_CYCLE_BELL_ALREADY_RESERVED");
        }
        const calibrationVersion = envelope.parameters?.calibrationVersion || null;
        const welfareVersion = envelope.parameters?.welfareConfigurationVersion || null;
        this.database.exec("BEGIN IMMEDIATE;");
        try {
            if (!cycle) {
                this.database.prepare(`
                    INSERT INTO EdgeFeedCycles (
                        cycleId, eventKey, eventId, controllerId, barnId, feederId,
                        bellCommandId, dispenseCommandId, state, controllerBootId,
                        reservedAt, updatedAt, calibrationVersion,
                        welfareConfigurationVersion
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?, ?)
                `).run(
                    cycleId, eventKey, envelope.eventId || null, envelope.controllerId,
                    envelope.barnId, envelope.feederId,
                    envelope.action === "RING_BELL" ? envelope.commandId : null,
                    envelope.action === "DISPENSE_FEED" ? envelope.commandId : null,
                    bootId, timestamp, timestamp, calibrationVersion, welfareVersion
                );
            } else {
                this.database.prepare(`
                    UPDATE EdgeFeedCycles SET
                        bellCommandId = CASE WHEN ? = 'RING_BELL' THEN ? ELSE bellCommandId END,
                        dispenseCommandId = CASE WHEN ? = 'DISPENSE_FEED' THEN ? ELSE dispenseCommandId END,
                        calibrationVersion = COALESCE(?, calibrationVersion),
                        welfareConfigurationVersion = COALESCE(?, welfareConfigurationVersion),
                        updatedAt = ?
                    WHERE cycleId = ?
                `).run(
                    envelope.action, envelope.commandId, envelope.action, envelope.commandId,
                    calibrationVersion, welfareVersion, timestamp, cycleId
                );
            }
            this.database.prepare(`
                INSERT INTO EdgeCommands (
                    commandId, deliveryId, eventId, cycleId, controllerId, barnId,
                    feederId, deviceId, assignmentGeneration, fencingToken,
                    authorityLeaseExpiresAt, commandExpiresAt, action, parametersJson,
                    calibrationVersion, welfareConfigurationVersion, controllerBootId,
                    state, receivedAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?)
            `).run(
                envelope.commandId, envelope.deliveryId, envelope.eventId || null, cycleId,
                envelope.controllerId, envelope.barnId, envelope.feederId,
                envelope.deviceId, envelope.assignmentGeneration, envelope.fencingToken,
                envelope.authorityLeaseExpiresAt, envelope.expiresAt, envelope.action,
                json(envelope.parameters || {}), calibrationVersion, welfareVersion,
                bootId, timestamp, timestamp
            );
            this.database.prepare(`
                INSERT INTO EdgeCommandHistory (commandId, fromState, toState, occurredAt)
                VALUES (?, NULL, 'RECEIVED', ?)
            `).run(envelope.commandId, timestamp);
            this.database.exec("COMMIT;");
        } catch (error) {
            this.database.exec("ROLLBACK;");
            throw error;
        }
        return {
            command: this.getCommand(envelope.commandId),
            cycle: this.getCycle(cycleId),
            created: true
        };
    }

    getCommand(commandId) {
        return mapCommand(this.statements.command.get(commandId));
    }

    getCycle(cycleId) {
        return mapCycle(this.statements.cycle.get(cycleId));
    }

    getCycleByEvent(eventKey) {
        return mapCycle(this.statements.cycleByEvent.get(eventKey));
    }

    transitionCommand(commandId, state, options = {}) {
        if (!COMMAND_STATES.includes(state)) throw new Error("Edge command state is invalid.");
        const before = this.getCommand(commandId);
        if (!before) throw edgeError("Edge command was not found.", "EDGE_COMMAND_NOT_FOUND");
        const timestamp = options.timestamp || this.clock().toISOString();
        const terminal = ["COMPLETED", "REJECTED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"]
            .includes(state);
        this.database.prepare(`
            UPDATE EdgeCommands SET state=?,
                acceptedAt=CASE WHEN ?='ACCEPTED' THEN COALESCE(acceptedAt, ?) ELSE acceptedAt END,
                startedAt=CASE WHEN ?='STARTED' THEN COALESCE(startedAt, ?) ELSE startedAt END,
                completedAt=CASE WHEN ? THEN COALESCE(completedAt, ?) ELSE completedAt END,
                finalAcknowledgementJson=COALESCE(?, finalAcknowledgementJson),
                reconciliationStatus=COALESCE(?, reconciliationStatus),
                operatorResolutionRequired=COALESCE(?, operatorResolutionRequired),
                failureCode=COALESCE(?, failureCode),
                failureMessage=COALESCE(?, failureMessage), updatedAt=?
            WHERE commandId=?
        `).run(
            state, state, timestamp, state, timestamp, terminal ? 1 : 0, timestamp,
            options.finalAcknowledgement === undefined ? null : json(options.finalAcknowledgement),
            options.reconciliationStatus || null,
            options.operatorResolutionRequired === undefined
                ? null : options.operatorResolutionRequired ? 1 : 0,
            options.failureCode || null, options.failureMessage || null,
            timestamp, commandId
        );
        this.database.prepare(`
            INSERT INTO EdgeCommandHistory (
                commandId, fromState, toState, occurredAt, detailsJson
            ) VALUES (?, ?, ?, ?, ?)
        `).run(commandId, before.state, state, timestamp, json(options.details));
        return this.getCommand(commandId);
    }

    updateCycle(cycleId, state, changes = {}) {
        if (!CYCLE_STATES.includes(state)) throw new Error("Edge cycle state is invalid.");
        const before = this.getCycle(cycleId);
        if (!before) throw edgeError("Feed cycle was not found.", "EDGE_CYCLE_NOT_FOUND");
        const timestamp = changes.timestamp || this.clock().toISOString();
        const merged = {
            ...before,
            ...changes,
            state,
            updatedAt: timestamp,
            startedAt: state === "STARTED" ? (before.startedAt || timestamp) : before.startedAt,
            completedAt: ["COMPLETED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN",
                "OPERATOR_LOCKOUT"].includes(state) ? (before.completedAt || timestamp) : before.completedAt
        };
        this.database.prepare(`
            UPDATE EdgeFeedCycles SET state=?, bellState=?, bellEvidenceJson=?,
                bellRepetitionCount=?, countdownState=?, countdownAttemptCount=?,
                outputAuthorityState=?, motorStartEvidenceJson=?, motorStopEvidenceJson=?,
                sensorEvidenceJson=?, feedMovementOccurred=?, measuredQuantity=?, outcome=?,
                lockoutReasonsJson=?, calibrationVersion=?, welfareConfigurationVersion=?,
                controllerBootId=?, startedAt=?, completedAt=?, updatedAt=?
            WHERE cycleId=?
        `).run(
            merged.state, merged.bellState, json(merged.bellEvidence),
            merged.bellRepetitionCount, merged.countdownState,
            merged.countdownAttemptCount, merged.outputAuthorityState,
            json(merged.motorStartEvidence), json(merged.motorStopEvidence),
            json(merged.sensorEvidence), merged.feedMovementOccurred === null
                || merged.feedMovementOccurred === undefined
                ? null : merged.feedMovementOccurred ? 1 : 0,
            merged.measuredQuantity ?? null, merged.outcome || null,
            json(merged.lockoutReasons || []), merged.calibrationVersion || null,
            merged.welfareConfigurationVersion || null, merged.controllerBootId,
            merged.startedAt || null, merged.completedAt || null, timestamp, cycleId
        );
        this.database.prepare(`
            INSERT INTO EdgeCycleHistory (cycleId, fromState, toState, occurredAt, detailsJson)
            VALUES (?, ?, ?, ?, ?)
        `).run(cycleId, before.state, state, timestamp, json(changes.details));
        return this.getCycle(cycleId);
    }

    markAcknowledgementDelivery(commandId, delivered, timestamp = this.clock().toISOString()) {
        const command = this.getCommand(commandId);
        if (!command) throw edgeError("Edge command was not found.", "EDGE_COMMAND_NOT_FOUND");
        const reconciliationStatus = delivered
            ? (command.acknowledgementDeliveryStatus === "LOST" ? "RECONCILED" : "DELIVERED")
            : command.state === "OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : "PENDING";
        this.database.prepare(`
            UPDATE EdgeCommands SET acknowledgementDeliveryStatus=?,
                acknowledgementDeliveredAt=?, reconciliationStatus=?, updatedAt=?
            WHERE commandId=?
        `).run(delivered ? "DELIVERED" : "LOST", delivered ? timestamp : null,
            reconciliationStatus, timestamp, commandId);
        this.incrementCounter(delivered ? "acknowledgement_delivery" : "acknowledgement_loss",
            { commandId }, timestamp);
        return this.getCommand(commandId);
    }

    installWelfareConfiguration(configuration, {
        createdAt = this.clock().toISOString(),
        expiresAt,
        serverLimits = null
    } = {}) {
        validateWelfareConfiguration(configuration);
        if (!expiresAt || Date.parse(expiresAt) <= Date.parse(createdAt)) {
            throw new Error("Welfare configuration requires a future expiry.");
        }
        if (serverLimits) {
            const maximumKeys = [
                "maximumMotorDurationMs", "maximumCyclesPerRollingPeriod",
                "maximumCyclesPerSession", "maximumQuantityPerSession",
                "maximumBellRepetitions", "maximumCountdownAttempts"
            ];
            for (const key of maximumKeys) {
                if (serverLimits[key] !== undefined
                    && Number(configuration[key]) > Number(serverLimits[key])) {
                    throw edgeError(`Local welfare setting ${key} is weaker than the server limit.`,
                        "LOCAL_WELFARE_LIMIT_WEAKER");
                }
            }
        }
        this.database.exec("BEGIN IMMEDIATE;");
        try {
            this.database.prepare("UPDATE EdgeWelfareConfigurations SET active=0").run();
            this.database.prepare(`
                INSERT INTO EdgeWelfareConfigurations (
                    version, configurationJson, createdAt, expiresAt, installedAt, active
                ) VALUES (?, ?, ?, ?, ?, 1)
                ON CONFLICT(version) DO UPDATE SET configurationJson=excluded.configurationJson,
                    createdAt=excluded.createdAt, expiresAt=excluded.expiresAt,
                    installedAt=excluded.installedAt, active=1
            `).run(configuration.version, json(configuration), createdAt, expiresAt,
                this.clock().toISOString());
            this.database.exec("COMMIT;");
        } catch (error) {
            this.database.exec("ROLLBACK;");
            throw error;
        }
        return this.getActiveWelfareConfiguration();
    }

    getActiveWelfareConfiguration() {
        const row = this.database.prepare(
            "SELECT * FROM EdgeWelfareConfigurations WHERE active=1 LIMIT 1"
        ).get();
        return row ? { ...parse(row.configurationJson), createdAt: row.createdAt,
            expiresAt: row.expiresAt, installedAt: row.installedAt } : null;
    }

    installCalibration(record) {
        validateCalibrationRecord(record);
        this.database.prepare(`
            INSERT INTO EdgeCalibrationRecords (
                calibrationId, feederId, version, recordJson, createdAt,
                expiresAt, approved, simulated
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(feederId, version) DO UPDATE SET
                recordJson=excluded.recordJson, createdAt=excluded.createdAt,
                expiresAt=excluded.expiresAt, approved=excluded.approved,
                simulated=excluded.simulated
        `).run(record.calibrationId, record.feederId, record.version, json(record),
            record.createdAt, record.expiresAt, record.approved ? 1 : 0,
            record.simulated ? 1 : 0);
        return this.getCalibration(record.feederId, record.version);
    }

    getCalibration(feederId, version = null) {
        const row = version
            ? this.database.prepare(`
                SELECT * FROM EdgeCalibrationRecords WHERE feederId=? AND version=?
            `).get(feederId, version)
            : this.database.prepare(`
                SELECT * FROM EdgeCalibrationRecords WHERE feederId=? AND approved=1
                ORDER BY createdAt DESC LIMIT 1
            `).get(feederId);
        return row ? { ...parse(row.recordJson), approved: row.approved === 1,
            simulated: row.simulated === 1 } : null;
    }

    reserveSafetyToken(token, bootId, timestamp = this.clock().toISOString()) {
        try {
            this.database.prepare(`
                INSERT INTO EdgeSafetyCycleTokens (
                    cycleToken, safetyControllerBootId, consumedAt
                ) VALUES (?, ?, ?)
            `).run(token, bootId, timestamp);
        } catch (error) {
            if (String(error.message).includes("UNIQUE")) {
                throw edgeError("Safety cycle token is stale or repeated.", "SAFETY_CYCLE_TOKEN_REPLAYED");
            }
            throw error;
        }
    }

    getMaintenanceState() {
        const row = this.database.prepare(
            "SELECT * FROM EdgeMaintenanceState WHERE controllerId=?"
        ).get(this.controllerId);
        return row ? { ...row } : {
            controllerId: this.controllerId,
            state: "NORMAL",
            sessionId: null,
            localPresenceEvidence: null,
            enteredAt: null,
            expiresAt: null,
            exitedAt: null,
            updatedAt: null
        };
    }

    setMaintenanceState(state, details = {}) {
        const timestamp = details.timestamp || this.clock().toISOString();
        this.database.prepare(`
            INSERT INTO EdgeMaintenanceState (
                controllerId, state, sessionId, localPresenceEvidence,
                enteredAt, expiresAt, exitedAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(controllerId) DO UPDATE SET state=excluded.state,
                sessionId=excluded.sessionId,
                localPresenceEvidence=excluded.localPresenceEvidence,
                enteredAt=excluded.enteredAt, expiresAt=excluded.expiresAt,
                exitedAt=excluded.exitedAt, updatedAt=excluded.updatedAt
        `).run(this.controllerId, state, details.sessionId || null,
            details.localPresenceEvidence || null, details.enteredAt || null,
            details.expiresAt || null, details.exitedAt || null, timestamp);
        return this.getMaintenanceState();
    }

    audit(action, details = {}) {
        const occurredAt = details.occurredAt || this.clock().toISOString();
        const record = {
            auditId: `edge_audit_${this.idGenerator()}`,
            action,
            feederId: details.feederId || null,
            cycleId: details.cycleId || null,
            maintenanceSessionId: details.maintenanceSessionId || null,
            operatorIdentity: details.operatorIdentity || null,
            occurredAt,
            details: details.details || null
        };
        this.database.prepare(`
            INSERT INTO EdgeLocalAuditRecords (
                auditId, action, feederId, cycleId, maintenanceSessionId,
                operatorIdentity, occurredAt, detailsJson
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(record.auditId, record.action, record.feederId, record.cycleId,
            record.maintenanceSessionId, record.operatorIdentity,
            record.occurredAt, json(record.details));
        return record;
    }

    getAuditRecords(limit = 100) {
        return this.database.prepare(`
            SELECT * FROM EdgeLocalAuditRecords ORDER BY auditSequence DESC LIMIT ?
        `).all(Math.max(1, Math.min(1000, Number(limit) || 100))).map(row => ({
            ...row,
            details: parse(row.detailsJson)
        }));
    }

    incrementCounter(name, details = null, timestamp = this.clock().toISOString()) {
        this.database.prepare(`
            INSERT INTO EdgeObservabilityCounters (
                name, value, lastOccurredAt, lastDetailsJson
            ) VALUES (?, 1, ?, ?)
            ON CONFLICT(name) DO UPDATE SET value=value+1,
                lastOccurredAt=excluded.lastOccurredAt,
                lastDetailsJson=excluded.lastDetailsJson
        `).run(name, timestamp, json(details));
    }

    getCounters() {
        return Object.fromEntries(this.database.prepare(
            "SELECT * FROM EdgeObservabilityCounters ORDER BY name"
        ).all().map(row => [row.name, {
            value: row.value,
            lastOccurredAt: row.lastOccurredAt,
            lastDetails: parse(row.lastDetailsJson)
        }]));
    }

    recentCommands(limit = 100) {
        return this.statements.recentCommands
            .all(Math.max(1, Math.min(1000, Number(limit) || 100))).map(mapCommand);
    }

    recentCycles(limit = 100) {
        return this.statements.recentCycles
            .all(Math.max(1, Math.min(1000, Number(limit) || 100))).map(mapCycle);
    }

    getUnresolvedUnknown(feederId) {
        return this.database.prepare(`
            SELECT * FROM EdgeFeedCycles
            WHERE feederId=? AND state IN ('OUTCOME_UNKNOWN','OPERATOR_LOCKOUT')
            ORDER BY cycleSequence DESC
        `).all(feederId).map(mapCycle);
    }

    getWelfareHistory(feederId, since) {
        return this.database.prepare(`
            SELECT * FROM EdgeFeedCycles
            WHERE feederId=? AND reservedAt>=?
              AND dispenseCommandId IS NOT NULL
              AND state IN ('COMPLETED','FAILED','OUTCOME_UNKNOWN','OPERATOR_LOCKOUT')
            ORDER BY cycleSequence DESC
        `).all(feederId, since).map(mapCycle);
    }

    recoverIncomplete(bootId, timestamp = this.clock().toISOString()) {
        const commands = this.database.prepare(`
            SELECT * FROM EdgeCommands
            WHERE state NOT IN ('COMPLETED','REJECTED','FAILED','CANCELLED','OUTCOME_UNKNOWN')
            ORDER BY journalSequence
        `).all().map(mapCommand);
        const recovered = [];
        for (const command of commands) {
            const cycle = this.getCycle(command.cycleId);
            if (cycle?.state === "COMPLETED"
                && cycle.outcome === "COMPLETED"
                && cycle.sensorEvidence) {
                const finalAcknowledgement = {
                    acknowledgementId:
                        `edge_ack_${command.commandId}_completed_recovered`,
                    commandId: command.commandId,
                    status: "COMPLETED",
                    occurredAt: timestamp,
                    measuredQuantity: cycle.measuredQuantity,
                    errorCode: null,
                    errorMessage: null,
                    calibrationVersion: cycle.calibrationVersion,
                    welfareConfigurationVersion: cycle.welfareConfigurationVersion,
                    cycleId: cycle.cycleId,
                    feedMovementOccurred: cycle.feedMovementOccurred,
                    evidence: cycle.sensorEvidence,
                    details: { recoveredFromDurableEvidence: true }
                };
                this.transitionCommand(command.commandId, "COMPLETED", {
                    timestamp,
                    finalAcknowledgement,
                    reconciliationStatus: "PENDING"
                });
                recovered.push({
                    commandId: command.commandId,
                    outcome: "COMPLETED_EVIDENCE_RECOVERED"
                });
            } else if (command.state === "STARTED"
                || ["STARTED", "DISPENSING", "EVIDENCE_COLLECTION"].includes(cycle?.state)) {
                this.transitionCommand(command.commandId, "OUTCOME_UNKNOWN", {
                    timestamp,
                    operatorResolutionRequired: command.action === "DISPENSE_FEED",
                    reconciliationStatus: "OUTCOME_UNKNOWN",
                    failureCode: "EDGE_RESTART_AFTER_STARTED",
                    failureMessage: "Edge restart occurred after STARTED."
                });
                this.updateCycle(command.cycleId, "OUTCOME_UNKNOWN", {
                    timestamp,
                    controllerBootId: bootId,
                    outcome: "OUTCOME_UNKNOWN",
                    lockoutReasons: ["EDGE_RESTART_AFTER_STARTED"]
                });
                this.incrementCounter("outcome_unknown", { commandId: command.commandId }, timestamp);
                recovered.push({ commandId: command.commandId, outcome: "OUTCOME_UNKNOWN" });
            } else {
                this.transitionCommand(command.commandId, "CANCELLED", {
                    timestamp,
                    failureCode: "EDGE_RESTART_BEFORE_STARTED",
                    failureMessage: "Pre-STARTED command cancelled safely during restart."
                });
                if (cycle && !["COMPLETED", "FAILED", "CANCELLED",
                    "OUTCOME_UNKNOWN", "OPERATOR_LOCKOUT"].includes(cycle.state)) {
                    this.updateCycle(cycle.cycleId, "CANCELLED", {
                        timestamp,
                        controllerBootId: bootId,
                        outcome: "CANCELLED"
                    });
                }
                recovered.push({ commandId: command.commandId, outcome: "CANCELLED" });
            }
        }
        if (recovered.length) {
            this.incrementCounter("journal_recovery", { recovered }, timestamp);
        }
        return recovered;
    }

    getStatusView() {
        const currentCycle = this.database.prepare(`
            SELECT * FROM EdgeFeedCycles ORDER BY cycleSequence DESC LIMIT 1
        `).get();
        const latestEvidence = this.database.prepare(`
            SELECT sensorEvidenceJson FROM EdgeFeedCycles
            WHERE sensorEvidenceJson IS NOT NULL ORDER BY cycleSequence DESC LIMIT 1
        `).get();
        return {
            schemaVersion: 1,
            runtime: this.getRuntime(),
            journal: {
                commandCount: this.database.prepare(
                    "SELECT COUNT(*) AS count FROM EdgeCommands"
                ).get().count,
                cycleCount: this.database.prepare(
                    "SELECT COUNT(*) AS count FROM EdgeFeedCycles"
                ).get().count,
                pendingAcknowledgements: this.database.prepare(`
                    SELECT COUNT(*) AS count FROM EdgeCommands
                    WHERE acknowledgementDeliveryStatus!='DELIVERED'
                      AND state IN ('COMPLETED','REJECTED','FAILED','CANCELLED','OUTCOME_UNKNOWN')
                `).get().count
            },
            currentCycle: mapCycle(currentCycle),
            latestCommand: (() => {
                const command = this.recentCommands(1)[0];
                return command ? {
                    journalSequence: command.journalSequence,
                    commandId: command.commandId,
                    cycleId: command.cycleId,
                    action: command.action,
                    state: command.state,
                    acknowledgementDeliveryStatus:
                        command.acknowledgementDeliveryStatus,
                    reconciliationStatus: command.reconciliationStatus,
                    operatorResolutionRequired: command.operatorResolutionRequired,
                    failureCode: command.failureCode,
                    updatedAt: command.updatedAt
                } : null;
            })(),
            latestSensorEvidence: latestEvidence
                ? parse(latestEvidence.sensorEvidenceJson) : null,
            welfareConfiguration: this.getActiveWelfareConfiguration(),
            calibrations: Object.fromEntries(this.database.prepare(`
                SELECT feederId, version, approved, simulated, expiresAt
                FROM EdgeCalibrationRecords ORDER BY feederId, createdAt DESC
            `).all().map(row => [row.feederId, {
                version: row.version,
                approved: row.approved === 1,
                simulated: row.simulated === 1,
                expiresAt: row.expiresAt
            }])),
            maintenance: this.getMaintenanceState(),
            safetyStates: this.getSafetyStates(),
            counters: this.getCounters()
        };
    }

    close() {
        this.database.close();
    }
}

export const EDGE_JOURNAL_SCHEMA_VERSION = 1;
