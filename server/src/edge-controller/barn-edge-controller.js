import { randomUUID } from "node:crypto";

import {
    buildSensorEvidence,
    classifySensorOutcome
} from "./sensor-evidence.js";
import { SimulatedSafetyController } from "./simulated-safety-controller.js";

const TERMINAL = new Set([
    "COMPLETED", "REJECTED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"
]);

export class EdgeSafetyRejection extends Error {
    constructor(message, code, { outcomeUnknown = false, lockout = false } = {}) {
        super(message);
        this.name = "EdgeSafetyRejection";
        this.code = code;
        this.outcomeUnknown = outcomeUnknown;
        this.lockout = lockout;
    }
}

function inPermittedWindow(date, windows, timezone = "UTC") {
    if (!Array.isArray(windows) || windows.length === 0) return false;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).formatToParts(date).filter(part => part.type !== "literal")
        .map(part => [part.type, part.value]));
    const value = Number(parts.hour) * 60 + Number(parts.minute);
    return windows.some(window => {
        const [startHour, startMinute] = String(window.start).split(":").map(Number);
        const [endHour, endMinute] = String(window.end).split(":").map(Number);
        const start = startHour * 60 + startMinute;
        const end = endHour * 60 + endMinute;
        return start <= end
            ? value >= start && value <= end
            : value >= start || value <= end;
    });
}

export class BarnEdgeController {
    constructor({
        config,
        store,
        hardware,
        safetyController = null,
        clock = () => new Date(),
        sleep = async () => {},
        idGenerator = randomUUID,
        logger = null
    }) {
        this.config = config;
        this.store = store;
        this.hardware = hardware;
        this.clock = clock;
        this.sleep = sleep;
        this.idGenerator = idGenerator;
        this.logger = logger;
        this.networkConnected = false;
        this.controllerEnabled = true;
        this.feederEnabled = new Map(config.feederIds.map(id => [id, true]));
        this.bellMuted = false;
        this.countdownCancellation = null;
        this.boot = this.store.startBoot(config.controllerId);
        this.hardware.resetOutputs("EDGE_CONTROLLER_BOOT");
        this.safetyController = safetyController || new SimulatedSafetyController({
            hardware,
            store,
            clock,
            sleep,
            idGenerator,
            hardMaximumDurationMs: config.safetyControllerHardMaximumDurationMs || 2000,
            watchdogTimeoutMs: Math.max(10, config.watchdogPulseMs * 2)
        });
        this.recovery = this.store.recoverIncomplete(this.boot.bootId);
    }

    setNetworkConnected(connected) {
        this.networkConnected = connected === true;
    }

    setControllerEnabled(enabled) {
        this.controllerEnabled = enabled === true;
        if (!this.controllerEnabled) this.safetyController.removeAuthority("CONTROLLER_DISABLED");
    }

    setFeederEnabled(feederId, enabled) {
        if (!this.feederEnabled.has(feederId)) {
            throw new EdgeSafetyRejection("Feeder is not assigned to this edge controller.",
                "EDGE_FEEDER_IDENTITY_MISMATCH");
        }
        this.feederEnabled.set(feederId, enabled === true);
    }

    setBellMuted(muted) {
        this.bellMuted = muted === true;
    }

    cancelCountdown(reason = "LOCAL_COUNTDOWN_CANCELLED") {
        this.countdownCancellation = String(reason).slice(0, 500);
    }

    acceptAssignmentEnvelope(envelope) {
        for (const assignment of envelope.assignments) {
            if (!this.config.feederIds.includes(assignment.feederId)) continue;
            this.store.saveAssignment({
                ...assignment,
                controllerId: envelope.controllerId,
                barnId: envelope.barnId
            });
        }
    }

    acceptSafetyEnvelope(envelope) {
        const scopeKey = envelope.level === "PLATFORM"
            ? "PLATFORM"
            : envelope.level === "BARN"
                ? `BARN:${envelope.barnId}`
                : `FEEDER:${envelope.feederId}`;
        this.store.saveSafetyState({ ...envelope, scopeKey });
        if (envelope.active) {
            this.safetyController.removeAuthority("SOFTWARE_EMERGENCY_STOP");
        }
    }

    async handleCommand(envelope, {
        emitAcknowledgement = async () => {},
        onStage = async () => {}
    } = {}) {
        const reservation = this.store.reserveCommand(
            envelope,
            this.boot.bootId,
            this.clock().toISOString()
        );
        let { command, cycle } = reservation;
        if (!reservation.created) {
            await this.emitPersisted(command, emitAcknowledgement);
            return this.resultFor(command);
        }
        await this.safeEmit(command, "RECEIVED", emitAcknowledgement);
        await onStage("RECEIVED", { command, cycle });
        try {
            this.assertMayProgress(command, { finalCheck: false });
            command = this.store.transitionCommand(command.commandId, "ACCEPTED");
            cycle = this.store.updateCycle(cycle.cycleId, "SAFETY_CHECKING");
            await this.safeEmit(command, "ACCEPTED", emitAcknowledgement);
            await onStage("ACCEPTED", { command, cycle });
            if (command.action === "RING_BELL") {
                return await this.executeBellCommand(command, cycle, {
                    emitAcknowledgement,
                    onStage
                });
            }
            return await this.executeDispenseCommand(command, cycle, {
                emitAcknowledgement,
                onStage
            });
        } catch (error) {
            if (error?.code === "SIMULATED_PROCESS_RESTART") throw error;
            return await this.finalizeError(command, cycle, error, emitAcknowledgement);
        }
    }

    async executeBellCommand(command, cycle, { emitAcknowledgement, onStage }) {
        if (cycle.bellState === "COMPLETED") {
            return await this.finalize(command, cycle, "COMPLETED", {
                emitAcknowledgement,
                details: { deduplicatedBell: true }
            });
        }
        if (this.bellMuted) {
            throw new EdgeSafetyRejection("The edge bell is muted.", "BELL_MUTED");
        }
        const welfare = this.requireWelfareConfiguration(command);
        if (cycle.bellRepetitionCount >= welfare.maximumBellRepetitions) {
            throw new EdgeSafetyRejection("Maximum bell repetitions reached.",
                "BELL_REPETITION_LIMIT");
        }
        cycle = this.store.updateCycle(cycle.cycleId, "BELL_PENDING", {
            bellState: "PENDING"
        });
        cycle = this.store.updateCycle(cycle.cycleId, "BELL_ACTIVE", {
            bellState: "ACTIVE",
            bellRepetitionCount: cycle.bellRepetitionCount + 1
        });
        await onStage("BELL_ACTIVE", { command, cycle });
        const startedAt = this.clock().toISOString();
        try {
            await this.hardware.ringBell(this.config.bellDurationMs, this.sleep);
        } catch (error) {
            if (error?.code === "SIMULATED_PROCESS_RESTART") throw error;
            cycle = this.store.updateCycle(cycle.cycleId, "FAILED", {
                bellState: "FAILED",
                bellEvidence: {
                    startedAt,
                    failedAt: this.clock().toISOString(),
                    errorCode: error.code || "BELL_FAILURE"
                },
                outcome: "FAILED"
            });
            this.store.incrementCounter("bell_failure", { cycleId: cycle.cycleId });
            throw error;
        }
        cycle = this.store.updateCycle(cycle.cycleId, "RESERVED", {
            bellState: "COMPLETED",
            bellEvidence: {
                startedAt,
                stoppedAt: this.clock().toISOString(),
                adapterVersion: this.hardware.version
            }
        });
        return await this.finalize(command, cycle, "COMPLETED", {
            emitAcknowledgement,
            details: { bellOnly: true }
        });
    }

    async executeDispenseCommand(command, cycle, { emitAcknowledgement, onStage }) {
        const welfare = this.requireWelfareConfiguration(command);
        const calibration = this.requireCalibration(command);
        this.assertWelfareLimits(command, cycle, welfare);

        if (cycle.bellState !== "COMPLETED") {
            if (this.bellMuted) {
                throw new EdgeSafetyRejection("The edge bell is muted.", "BELL_MUTED");
            }
            cycle = this.store.updateCycle(cycle.cycleId, "BELL_ACTIVE", {
                bellState: "ACTIVE",
                bellRepetitionCount: cycle.bellRepetitionCount + 1
            });
            await onStage("BELL_ACTIVE", { command, cycle });
            const bellStartedAt = this.clock().toISOString();
            try {
                await this.hardware.ringBell(this.config.bellDurationMs, this.sleep);
                cycle = this.store.updateCycle(cycle.cycleId, "COUNTDOWN", {
                    bellState: "COMPLETED",
                    bellEvidence: {
                        startedAt: bellStartedAt,
                        stoppedAt: this.clock().toISOString(),
                        adapterVersion: this.hardware.version
                    }
                });
            } catch (error) {
                if (error?.code === "SIMULATED_PROCESS_RESTART") throw error;
                cycle = this.store.updateCycle(cycle.cycleId,
                    this.config.bellFailurePolicy === "CONTINUE" ? "COUNTDOWN" : "FAILED", {
                        bellState: "FAILED",
                        bellEvidence: {
                            startedAt: bellStartedAt,
                            failedAt: this.clock().toISOString(),
                            errorCode: error.code || "BELL_FAILURE"
                        }
                    });
                if (this.config.bellFailurePolicy !== "CONTINUE") throw error;
            }
        } else {
            cycle = this.store.updateCycle(cycle.cycleId, "COUNTDOWN");
        }

        if (cycle.countdownAttemptCount >= welfare.maximumCountdownAttempts) {
            throw new EdgeSafetyRejection("Maximum countdown attempts reached.",
                "COUNTDOWN_ATTEMPT_LIMIT");
        }
        cycle = this.store.updateCycle(cycle.cycleId, "COUNTDOWN", {
            countdownState: "ACTIVE",
            countdownAttemptCount: cycle.countdownAttemptCount + 1
        });
        await onStage("COUNTDOWN", { command, cycle });
        if (this.countdownCancellation) {
            const reason = this.countdownCancellation;
            this.countdownCancellation = null;
            throw new EdgeSafetyRejection(reason, "EDGE_COUNTDOWN_CANCELLED");
        }
        await this.sleep(this.config.countdownDurationMs);
        if (this.countdownCancellation) {
            const reason = this.countdownCancellation;
            this.countdownCancellation = null;
            throw new EdgeSafetyRejection(reason, "EDGE_COUNTDOWN_CANCELLED");
        }
        cycle = this.store.updateCycle(cycle.cycleId, "FINAL_CHECK", {
            countdownState: "COMPLETED"
        });
        await onStage("FINAL_CHECK", { command, cycle });
        this.assertMayProgress(command, { finalCheck: true });
        this.assertWelfareLimits(command, cycle, welfare);
        const durationMs = this.determineDuration(command, calibration, welfare);

        const timestamp = this.clock().toISOString();
        command = this.store.transitionCommand(command.commandId, "STARTED", { timestamp });
        cycle = this.store.updateCycle(cycle.cycleId, "STARTED", { timestamp });
        await this.safeEmit(command, "STARTED", emitAcknowledgement);
        await onStage("STARTED", { command, cycle });

        const cycleToken = `edge_cycle_token_${cycle.cycleId}_${command.commandId}`;
        let authorityGranted = false;
        let actionError = null;
        let weightBefore = null;
        const motorStartedAt = this.clock().toISOString();
        try {
            const granted = this.safetyController.enable({
                cycleToken,
                maximumDurationMs: durationMs
            });
            authorityGranted = granted.granted === true;
            cycle = this.store.updateCycle(cycle.cycleId, "DISPENSING", {
                outputAuthorityState: "GRANTED",
                motorStartEvidence: {
                    requestedAt: motorStartedAt,
                    safetyControllerBootId: granted.safetyControllerBootId,
                    cycleToken
                }
            });
            weightBefore = this.hardware.captureWeightBefore();
            await onStage("DISPENSING", { command, cycle });
            await this.safetyController.runBounded({
                cycleToken,
                durationMs,
                pulseIntervalMs: this.config.watchdogPulseMs
            });
        } catch (error) {
            if (error?.code === "SIMULATED_PROCESS_RESTART") {
                this.safetyController.removeAuthority("SIMULATED_PROCESS_RESTART");
                throw error;
            }
            actionError = error;
            this.safetyController.removeAuthority(error.code || "ACTION_FAILED");
            const counter = error.code === "WATCHDOG_EXPIRED"
                ? "watchdog_trip"
                : error.code === "ELECTRICAL_EMERGENCY_STOP_OPEN"
                    ? "electrical_emergency_stop_trip"
                    : error.code === "SAFETY_CONTROLLER_REFUSED"
                        ? "safety_controller_refusal" : "local_safety_failure";
            this.store.incrementCounter(counter, { cycleId: cycle.cycleId, code: error.code });
        }

        await onStage("MOTOR_STOPPED", { command, cycle });
        if (!authorityGranted) {
            throw new EdgeSafetyRejection(
                actionError?.message || "Safety authority was not granted.",
                actionError?.code || "SAFETY_AUTHORITY_NOT_GRANTED"
            );
        }
        cycle = this.store.updateCycle(cycle.cycleId, "EVIDENCE_COLLECTION", {
            outputAuthorityState: "OFF",
            motorStopEvidence: {
                stoppedAt: this.clock().toISOString(),
                reason: actionError?.code || "BOUNDED_ACTION_COMPLETE"
            }
        });
        await onStage("EVIDENCE_COLLECTION", { command, cycle });
        const stoppedAt = this.clock().toISOString();
        const observations = this.hardware.collectObservations(weightBefore);
        const evidence = buildSensorEvidence({
            observations,
            command: { ...command, cycleId: cycle.cycleId },
            authorityGranted,
            startedAt: motorStartedAt,
            stoppedAt,
            calibrationVersion: calibration.version,
            adapterVersion: this.hardware.version
        });
        const classified = classifySensorOutcome(evidence, {
            expectedQuantity: Number(command.parameters.quantity || 1),
            tolerance: Number(calibration.tolerance ?? welfare.quantityTolerance),
            hardDurationMs: welfare.maximumMotorDurationMs,
            safetyTrip: actionError?.code || null
        });
        if (evidence.sensorDisagreement.length) {
            this.store.incrementCounter("sensor_disagreement", {
                cycleId: cycle.cycleId,
                disagreements: evidence.sensorDisagreement
            });
        }
        if (evidence.motorCurrentObservation !== true) {
            this.store.incrementCounter("no_motor_evidence", { cycleId: cycle.cycleId });
        }
        if (evidence.feedFlowObservation !== true) {
            this.store.incrementCounter("no_feed_flow_evidence", { cycleId: cycle.cycleId });
        }
        if (classified.outcome === "OUTCOME_UNKNOWN") {
            this.store.incrementCounter("outcome_unknown", { cycleId: cycle.cycleId });
        }
        for (const reason of classified.lockoutReasons) {
            const counter = reason === "HARD_DURATION_EXCEEDED"
                ? "action_duration_breach"
                : ["POSSIBLE_CONTINUOUS_FLOW", "EXCESSIVE_FEED_MOVEMENT"]
                    .includes(reason)
                    ? "excessive_simulated_flow" : "local_lockout";
            this.store.incrementCounter(counter, { cycleId: cycle.cycleId, reason });
        }
        const finalState = classified.lockoutReasons.length
            ? "OPERATOR_LOCKOUT" : classified.outcome;
        cycle = this.store.updateCycle(cycle.cycleId, finalState, {
            sensorEvidence: evidence,
            feedMovementOccurred: classified.feedMovementOccurred,
            measuredQuantity: classified.measuredQuantity,
            outcome: classified.outcome,
            lockoutReasons: classified.lockoutReasons,
            calibrationVersion: calibration.version,
            welfareConfigurationVersion: welfare.version
        });
        await onStage("EVIDENCE_PERSISTED", { command, cycle });
        if (classified.outcome !== "COMPLETED") {
            throw new EdgeSafetyRejection(
                classified.outcome === "FAILED"
                    ? "Sensor evidence proves no dispense occurred."
                    : "Sensor evidence cannot prove the dispense outcome.",
                classified.outcome === "FAILED" ? "DISPENSE_PROVEN_NOT_PERFORMED"
                    : "DISPENSE_OUTCOME_UNCERTAIN",
                {
                    outcomeUnknown: classified.outcome === "OUTCOME_UNKNOWN",
                    lockout: classified.lockoutReasons.length > 0
                }
            );
        }
        return await this.finalize(command, cycle, "COMPLETED", {
            emitAcknowledgement,
            evidence,
            measuredQuantity: classified.measuredQuantity
        });
    }

    assertMayProgress(command, { finalCheck }) {
        const now = this.clock();
        if (command.controllerId !== this.config.controllerId
            || command.barnId !== this.config.barnId
            || !this.config.feederIds.includes(command.feederId)) {
            throw new EdgeSafetyRejection("Command identity is not assigned to this controller.",
                "EDGE_COMMAND_IDENTITY_MISMATCH");
        }
        if (!this.controllerEnabled || !this.feederEnabled.get(command.feederId)) {
            throw new EdgeSafetyRejection("Controller or feeder is disabled.", "EDGE_RESOURCE_DISABLED");
        }
        const assignment = this.store.getAssignment(command.feederId);
        if (!assignment || !assignment.enabled
            || assignment.controllerId !== command.controllerId
            || assignment.barnId !== command.barnId
            || assignment.assignmentGeneration !== command.assignmentGeneration) {
            throw new EdgeSafetyRejection("Current assignment does not authorise the command.",
                "EDGE_ASSIGNMENT_INVALID");
        }
        if (Date.parse(command.commandExpiresAt) <= now.getTime()) {
            this.store.incrementCounter("stale_command", { commandId: command.commandId });
            throw new EdgeSafetyRejection("Command has expired.", "MQTT_COMMAND_EXPIRED");
        }
        if (Date.parse(command.authorityLeaseExpiresAt) <= now.getTime()
            || Date.parse(assignment.authorityLeaseExpiresAt) <= now.getTime()) {
            this.store.incrementCounter("expired_authority_lease", {
                commandId: command.commandId
            });
            throw new EdgeSafetyRejection("Authority lease has expired.",
                "MQTT_AUTHORITY_LEASE_EXPIRED");
        }
        if (finalCheck && !this.networkConnected) {
            throw new EdgeSafetyRejection(
                "Current remote safety state cannot be verified while disconnected.",
                "EDGE_NETWORK_STATE_UNVERIFIED"
            );
        }
        const requiredSafety = [
            "PLATFORM",
            `BARN:${command.barnId}`,
            `FEEDER:${command.feederId}`
        ];
        for (const scope of requiredSafety) {
            const state = this.store.getSafetyState(scope);
            if (!state || Date.parse(state.expiresAt) <= now.getTime()) {
                throw new EdgeSafetyRejection("Current software safety state is unavailable.",
                    "MQTT_SAFETY_STATE_UNCONFIRMED");
            }
            if (state.active) {
                throw new EdgeSafetyRejection("A software emergency stop is active.",
                    "MQTT_EMERGENCY_STOP_ACTIVE");
            }
        }
        const inputs = this.hardware.readInputs();
        if (!inputs.electricalEmergencyStopHealthy) {
            throw new EdgeSafetyRejection("Electrical emergency-stop circuit is open.",
                "ELECTRICAL_EMERGENCY_STOP_OPEN");
        }
        if (!inputs.mainIsolatorOn || !inputs.safetyControllerReady
            || !inputs.safetyControllerWatchdogHealthy
            || inputs.hopperLevel === "EMPTY" || inputs.outletState === "BLOCKED"
            || !inputs.enclosureClosed) {
            throw new EdgeSafetyRejection("Simulated sensor readiness check failed.",
                inputs.hopperLevel === "EMPTY" ? "HOPPER_EMPTY"
                    : inputs.outletState === "BLOCKED" ? "OUTLET_BLOCKED"
                        : "EDGE_SENSOR_NOT_READY");
        }
        const maintenance = this.store.getMaintenanceState();
        if (maintenance.state !== "NORMAL") {
            throw new EdgeSafetyRejection("Maintenance mode blocks remote supporter feeding.",
                "EDGE_MAINTENANCE_MODE_ACTIVE");
        }
        if (this.store.getUnresolvedUnknown(command.feederId).length) {
            throw new EdgeSafetyRejection("An unresolved uncertain outcome blocks this feeder.",
                "EDGE_UNRESOLVED_OUTCOME_LOCKOUT");
        }
    }

    requireWelfareConfiguration(command) {
        const welfare = this.store.getActiveWelfareConfiguration();
        if (!welfare || Date.parse(welfare.expiresAt) <= this.clock().getTime()) {
            this.store.incrementCounter("welfare_configuration_stale", {
                commandId: command.commandId
            });
            throw new EdgeSafetyRejection("Local welfare configuration is absent or stale.",
                "EDGE_WELFARE_CONFIGURATION_STALE");
        }
        if (!command.welfareConfigurationVersion
            || command.welfareConfigurationVersion !== welfare.version) {
            throw new EdgeSafetyRejection("Command welfare version does not match local authority.",
                "EDGE_WELFARE_VERSION_MISMATCH");
        }
        return welfare;
    }

    requireCalibration(command) {
        const calibration = this.store.getCalibration(
            command.feederId,
            command.calibrationVersion
        );
        if (!calibration || !calibration.approved
            || Date.parse(calibration.expiresAt) <= this.clock().getTime()) {
            this.store.incrementCounter("calibration_stale", { commandId: command.commandId });
            throw new EdgeSafetyRejection("Approved current calibration is required.",
                "EDGE_CALIBRATION_STALE");
        }
        if (this.config.mode === "production" && calibration.simulated) {
            throw new EdgeSafetyRejection("Production mode rejects simulated calibration.",
                "EDGE_SIMULATED_CALIBRATION_REJECTED");
        }
        return calibration;
    }

    assertWelfareLimits(command, cycle, welfare) {
        const now = this.clock();
        if (!inPermittedWindow(
            now,
            welfare.permittedWindows,
            this.config.barnTimezone || "UTC"
        )) {
            throw new EdgeSafetyRejection("Current time is outside local feeding windows.",
                "EDGE_FEEDING_WINDOW_CLOSED");
        }
        if (this.store.getUnresolvedUnknown(command.feederId).length) {
            throw new EdgeSafetyRejection("Unresolved OUTCOME_UNKNOWN blocks this feeder.",
                "EDGE_UNRESOLVED_OUTCOME_LOCKOUT");
        }
        const rollingSince = new Date(now.getTime() - welfare.rollingPeriodMs).toISOString();
        const rolling = this.store.getWelfareHistory(command.feederId, rollingSince)
            .filter(item => item.cycleId !== cycle.cycleId);
        if (rolling.length >= welfare.maximumCyclesPerRollingPeriod) {
            throw new EdgeSafetyRejection("Local rolling feed-cycle limit reached.",
                "EDGE_ROLLING_LIMIT_REACHED");
        }
        const session = rolling.filter(item => item.controllerBootId === this.boot.bootId);
        if (session.length >= welfare.maximumCyclesPerSession) {
            throw new EdgeSafetyRejection("Local session cycle limit reached.",
                "EDGE_SESSION_LIMIT_REACHED");
        }
        const sessionQuantity = session.reduce((total, item) => (
            total + Number(item.measuredQuantity || 0)
        ), 0);
        if (sessionQuantity + Number(command.parameters.quantity || 1)
            > welfare.maximumQuantityPerSession) {
            throw new EdgeSafetyRejection("Local session quantity limit reached.",
                "EDGE_SESSION_QUANTITY_LIMIT_REACHED");
        }
        const last = rolling[0];
        if (last && Date.parse(last.completedAt || last.updatedAt) + welfare.minimumIntervalMs
            > now.getTime()) {
            throw new EdgeSafetyRejection("Minimum interval between dispenses is active.",
                "EDGE_MINIMUM_INTERVAL_ACTIVE");
        }
        const consecutiveFailures = rolling.findIndex(item => item.state === "COMPLETED");
        const failureCount = consecutiveFailures === -1 ? rolling.length : consecutiveFailures;
        if (failureCount >= welfare.maximumConsecutiveFailures) {
            throw new EdgeSafetyRejection("Consecutive failure lockout is active.",
                "EDGE_CONSECUTIVE_FAILURE_LOCKOUT");
        }
        const disagreements = rolling.filter(item => (
            item.sensorEvidence?.sensorDisagreement?.length > 0
        )).length;
        if (disagreements >= welfare.maximumSensorDisagreements) {
            throw new EdgeSafetyRejection("Sensor-disagreement lockout is active.",
                "EDGE_SENSOR_DISAGREEMENT_LOCKOUT");
        }
        if (last?.state === "FAILED"
            && Date.parse(last.completedAt || last.updatedAt) + welfare.cooldownAfterFailureMs
                > now.getTime()) {
            throw new EdgeSafetyRejection("Failure cooldown is active.",
                "EDGE_FAILURE_COOLDOWN_ACTIVE");
        }
    }

    determineDuration(command, calibration, welfare) {
        const duration = Number(
            command.parameters.simulatedMotorDurationMs
            ?? calibration.commandedDurationMs
            ?? 100
        );
        if (!Number.isFinite(duration) || duration <= 0
            || duration > welfare.maximumMotorDurationMs) {
            throw new EdgeSafetyRejection("Requested motor duration exceeds local welfare limits.",
                "EDGE_MOTOR_DURATION_LIMIT");
        }
        return duration;
    }

    async finalize(command, cycle, outcome, {
        emitAcknowledgement,
        evidence = null,
        measuredQuantity = null,
        details = null
    }) {
        const acknowledgement = this.acknowledgement(command, outcome, {
            evidence,
            measuredQuantity,
            details,
            cycle
        });
        command = this.store.transitionCommand(command.commandId, outcome, {
            finalAcknowledgement: acknowledgement,
            reconciliationStatus: "PENDING"
        });
        try {
            await emitAcknowledgement(outcome, acknowledgement, command);
            this.store.markAcknowledgementDelivery(command.commandId, true);
        } catch (error) {
            this.store.markAcknowledgementDelivery(command.commandId, false);
        }
        return this.resultFor(this.store.getCommand(command.commandId));
    }

    async finalizeError(command, cycle, error, emitAcknowledgement) {
        command = this.store.getCommand(command.commandId) || command;
        cycle = this.store.getCycle(command.cycleId) || cycle;
        const outcomeUnknown = error?.outcomeUnknown === true
            || cycle?.outcome === "OUTCOME_UNKNOWN";
        const state = outcomeUnknown ? "OUTCOME_UNKNOWN"
            : error?.code === "EDGE_COUNTDOWN_CANCELLED" ? "CANCELLED"
                : command.action === "RING_BELL" && cycle?.bellState === "FAILED"
                    ? "FAILED"
                : command.state === "RECEIVED" || command.state === "ACCEPTED"
                    ? "REJECTED" : "FAILED";
        if (!TERMINAL.has(cycle?.state)) {
            const cycleState = error?.lockout ? "OPERATOR_LOCKOUT"
                : state === "REJECTED" ? "CANCELLED" : state;
            this.store.updateCycle(cycle.cycleId,
                cycleState, {
                    outcome: state,
                    lockoutReasons: error?.lockout ? [error.code] : cycle.lockoutReasons
                });
        }
        const acknowledgement = this.acknowledgement(command, state, {
            error,
            cycle: this.store.getCycle(cycle.cycleId)
        });
        command = this.store.transitionCommand(command.commandId, state, {
            finalAcknowledgement: acknowledgement,
            reconciliationStatus: outcomeUnknown ? "OUTCOME_UNKNOWN" : "PENDING",
            operatorResolutionRequired: outcomeUnknown && command.action === "DISPENSE_FEED",
            failureCode: error?.code || "EDGE_EXECUTION_FAILED",
            failureMessage: String(error?.message || error)
        });
        if (outcomeUnknown) this.store.incrementCounter("local_lockout", {
            commandId: command.commandId,
            code: error?.code
        });
        try {
            await emitAcknowledgement(state, acknowledgement, command);
            this.store.markAcknowledgementDelivery(command.commandId, true);
        } catch {
            this.store.markAcknowledgementDelivery(command.commandId, false);
        }
        return this.resultFor(this.store.getCommand(command.commandId));
    }

    acknowledgement(command, status, {
        evidence = null,
        measuredQuantity = null,
        error = null,
        cycle = null,
        details = null
    } = {}) {
        return {
            acknowledgementId: `edge_ack_${command.commandId}_${status.toLowerCase()}`,
            commandId: command.commandId,
            status,
            occurredAt: this.clock().toISOString(),
            measuredQuantity,
            errorCode: error?.code || null,
            errorMessage: error ? String(error.message || error) : null,
            calibrationVersion: command.calibrationVersion,
            welfareConfigurationVersion: command.welfareConfigurationVersion,
            cycleId: command.cycleId,
            feedMovementOccurred: cycle?.feedMovementOccurred ?? null,
            evidence,
            details
        };
    }

    async safeEmit(command, status, emitAcknowledgement) {
        try {
            await emitAcknowledgement(status, this.acknowledgement(command, status), command);
        } catch (error) {
            this.store.incrementCounter("acknowledgement_loss", {
                commandId: command.commandId,
                status,
                message: String(error?.message || error)
            });
        }
    }

    async emitPersisted(command, emitAcknowledgement) {
        if (command.finalAcknowledgement) {
            try {
                await emitAcknowledgement(
                    command.finalAcknowledgement.status,
                    command.finalAcknowledgement,
                    command
                );
                this.store.markAcknowledgementDelivery(command.commandId, true);
            } catch {
                this.store.markAcknowledgementDelivery(command.commandId, false);
            }
            return;
        }
        await this.safeEmit(command, command.state, emitAcknowledgement);
    }

    resultFor(command) {
        return {
            commandId: command.commandId,
            cycleId: command.cycleId,
            state: command.state,
            duplicateSafe: true,
            acknowledgement: command.finalAcknowledgement
        };
    }

    enterMaintenance({
        localPresenceEvidence,
        operatorIdentity,
        durationMs = 15 * 60 * 1000
    }) {
        if (!localPresenceEvidence || !operatorIdentity) {
            throw new EdgeSafetyRejection(
                "Local presence and operator identity are required for maintenance.",
                "MAINTENANCE_LOCAL_PRESENCE_REQUIRED"
            );
        }
        if (!Number.isFinite(Number(durationMs)) || Number(durationMs) <= 0) {
            throw new EdgeSafetyRejection(
                "Maintenance duration must be positive and bounded.",
                "MAINTENANCE_DURATION_INVALID"
            );
        }
        const now = this.clock();
        const sessionId = `maintenance_${this.idGenerator()}`;
        const state = this.store.setMaintenanceState("MAINTENANCE", {
            sessionId,
            localPresenceEvidence,
            enteredAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + Math.min(durationMs, 30 * 60 * 1000))
                .toISOString()
        });
        this.hardware.setIndicator("maintenanceModeIndicator", true);
        this.store.audit("MAINTENANCE_MODE_ENTERED", {
            maintenanceSessionId: sessionId,
            operatorIdentity,
            details: { localPresenceEvidence, expiresAt: state.expiresAt }
        });
        this.store.incrementCounter("maintenance_mode_entered", { sessionId });
        return state;
    }

    async runMaintenanceAction({
        action,
        feederId,
        operatorIdentity,
        localHoldActive,
        durationMs = 100
    }) {
        const maintenance = this.store.getMaintenanceState();
        if (maintenance.state !== "MAINTENANCE"
            || Date.parse(maintenance.expiresAt) <= this.clock().getTime()) {
            this.store.setMaintenanceState("RESET_REQUIRED", {
                sessionId: maintenance.sessionId,
                exitedAt: this.clock().toISOString()
            });
            throw new EdgeSafetyRejection("Maintenance session is absent or expired.",
                "MAINTENANCE_SESSION_EXPIRED");
        }
        this.assertLocalEmergencyHealthy();
        const normalized = String(action || "").toUpperCase();
        if (normalized === "SHORT_AUGER_JOG") {
            if (!localHoldActive) {
                throw new EdgeSafetyRejection("Auger jog requires hold-to-run presence.",
                    "MAINTENANCE_HOLD_TO_RUN_REQUIRED");
            }
            const bounded = Math.min(durationMs, this.config.maintenanceMaximumJogMs);
            const token = `maintenance_token_${this.idGenerator()}`;
            this.safetyController.enable({ cycleToken: token, maximumDurationMs: bounded });
            await this.safetyController.runBounded({
                cycleToken: token,
                durationMs: bounded,
                pulseIntervalMs: this.config.watchdogPulseMs
            });
        } else if (normalized === "BELL_TEST") {
            await this.hardware.ringBell(Math.min(durationMs, this.config.bellDurationMs), this.sleep);
        } else if (normalized === "WATCHDOG_TEST") {
            const previous = this.safetyController.behaviour;
            this.safetyController.setBehaviour("WATCHDOG_EXPIRY");
            const token = `maintenance_token_${this.idGenerator()}`;
            try {
                this.safetyController.enable({ cycleToken: token, maximumDurationMs: 10 });
                await this.safetyController.runBounded({ cycleToken: token, durationMs: 10 });
            } catch (error) {
                if (error.code !== "WATCHDOG_EXPIRED") throw error;
            } finally {
                this.safetyController.setBehaviour(previous);
            }
        } else if (!["SENSOR_TEST", "CALIBRATION_TEST_CYCLE", "EMERGENCY_STOP_INPUT_TEST"]
            .includes(normalized)) {
            throw new EdgeSafetyRejection("Maintenance action is unsupported.",
                "MAINTENANCE_ACTION_UNSUPPORTED");
        }
        const audit = this.store.audit(`MAINTENANCE_${normalized}`, {
            feederId,
            maintenanceSessionId: maintenance.sessionId,
            operatorIdentity,
            details: { localHoldActive: localHoldActive === true, durationMs }
        });
        return { action: normalized, completed: true, auditId: audit.auditId };
    }

    exitMaintenance({ operatorIdentity, localPresenceEvidence }) {
        const maintenance = this.store.getMaintenanceState();
        if (!["MAINTENANCE", "RESET_REQUIRED"].includes(maintenance.state)
            || !localPresenceEvidence) {
            throw new EdgeSafetyRejection("Deliberate local maintenance exit is required.",
                "MAINTENANCE_EXIT_CONFIRMATION_REQUIRED");
        }
        this.safetyController.shutdown();
        this.hardware.setIndicator("maintenanceModeIndicator", false);
        const state = this.store.setMaintenanceState("NORMAL", {
            exitedAt: this.clock().toISOString()
        });
        this.store.audit("MAINTENANCE_MODE_EXITED", {
            maintenanceSessionId: maintenance.sessionId,
            operatorIdentity,
            details: { localPresenceEvidence }
        });
        this.store.incrementCounter("maintenance_mode_exited", {
            sessionId: maintenance.sessionId
        });
        return state;
    }

    assertLocalEmergencyHealthy() {
        if (!this.hardware.readInputs().electricalEmergencyStopHealthy) {
            throw new EdgeSafetyRejection("Electrical emergency stop is open.",
                "ELECTRICAL_EMERGENCY_STOP_OPEN");
        }
    }

    getStatus() {
        const view = this.store.getStatusView();
        const maintenance = view.maintenance ? {
            state: view.maintenance.state,
            sessionId: view.maintenance.sessionId,
            enteredAt: view.maintenance.enteredAt,
            expiresAt: view.maintenance.expiresAt,
            exitedAt: view.maintenance.exitedAt,
            updatedAt: view.maintenance.updatedAt,
            localPresenceConfirmed: Boolean(view.maintenance.localPresenceEvidence)
        } : null;
        return {
            statusVersion: "1.0",
            controllerId: this.config.controllerId,
            barnId: this.config.barnId,
            feederIds: [...this.config.feederIds],
            bootId: this.boot.bootId,
            bootCounter: this.boot.bootCounter,
            networkConnected: this.networkConnected,
            controllerEnabled: this.controllerEnabled,
            hardwareAdapter: {
                type: "SIMULATED",
                version: this.hardware.version,
                inputs: this.hardware.readInputs(),
                outputs: this.hardware.getOutputs()
            },
            safetyController: this.safetyController.status(),
            bellMuted: this.bellMuted,
            lockoutReasons: view.currentCycle?.lockoutReasons || [],
            ...view,
            maintenance
        };
    }

    shutdown() {
        this.safetyController.shutdown();
        this.hardware.resetOutputs("EDGE_CONTROLLER_SHUTDOWN");
        this.store.safeShutdown();
    }
}
