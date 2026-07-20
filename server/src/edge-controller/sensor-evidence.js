export const SENSOR_EVIDENCE_VERSION = "1.0";

export function buildSensorEvidence({
    observations,
    command,
    authorityGranted,
    startedAt,
    stoppedAt,
    calibrationVersion,
    adapterVersion
}) {
    const before = Number.isFinite(observations.weightBefore)
        ? observations.weightBefore : null;
    const after = Number.isFinite(observations.weightAfter)
        ? observations.weightAfter : null;
    const calculatedWeightChange = before === null || after === null
        ? null : after - before;
    const missingEvidence = [
        "contactorFeedback", "motorCurrent", "shaftRotation", "feedFlow"
    ].filter(name => observations[name] === null || observations[name] === undefined);
    const disagreements = [];
    if (observations.motorCurrent === true && observations.shaftRotation === false) {
        disagreements.push("MOTOR_CURRENT_WITHOUT_SHAFT_ROTATION");
    }
    if (observations.shaftRotation === true && observations.feedFlow === false) {
        disagreements.push("SHAFT_ROTATION_WITHOUT_FEED_FLOW");
    }
    if (observations.feedFlow === true
        && observations.motorCurrent !== true
        && observations.shaftRotation !== true) {
        disagreements.push("FEED_FLOW_WITHOUT_MOTOR_EVIDENCE");
    }
    if (observations.contactorFeedback === true && !authorityGranted) {
        disagreements.push("CONTACTOR_WITHOUT_AUTHORITY");
    }
    if (authorityGranted && observations.contactorFeedback === false
        && observations.motorCurrent === true) {
        disagreements.push("CONTACTOR_FEEDBACK_DISAGREEMENT");
    }
    return Object.freeze({
        evidenceVersion: SENSOR_EVIDENCE_VERSION,
        commandId: command.commandId,
        cycleId: command.cycleId,
        motorCommandRequested: true,
        safetyAuthorityGranted: authorityGranted === true,
        contactorFeedback: observations.contactorFeedback ?? null,
        motorCurrentObservation: observations.motorCurrent ?? null,
        shaftRotationObservation: observations.shaftRotation ?? null,
        feedFlowObservation: observations.feedFlow ?? null,
        weightBefore: before,
        weightAfter: after,
        calculatedWeightChange,
        hopperLevelState: observations.hopperLevel ?? null,
        outletState: observations.outletState ?? null,
        actionDurationMs: Math.max(0, Date.parse(stoppedAt) - Date.parse(startedAt)),
        startedAt,
        stoppedAt,
        observedAt: stoppedAt,
        confidence: observations.confidence || "HIGH",
        sensorDisagreement: disagreements,
        missingEvidence,
        calibrationVersion,
        simulatedHardwareAdapterVersion: adapterVersion
    });
}

export function classifySensorOutcome(evidence, {
    expectedQuantity,
    tolerance,
    hardDurationMs,
    safetyTrip = null,
    restartDetected = false
}) {
    const movementEvidence = [
        evidence.shaftRotationObservation,
        evidence.feedFlowObservation,
        evidence.calculatedWeightChange === null
            ? null : evidence.calculatedWeightChange > 0
    ];
    const movementProven = movementEvidence.filter(value => value === true).length >= 2;
    const noMovementProven = evidence.contactorFeedback === false
        && evidence.motorCurrentObservation === false
        && movementEvidence.filter(value => value === false).length >= 2;
    const quantity = evidence.calculatedWeightChange;
    const withinTolerance = quantity !== null
        && Math.abs(quantity - expectedQuantity) <= Math.max(0, expectedQuantity * tolerance);
    const lockoutReasons = [];
    if (evidence.actionDurationMs > hardDurationMs) lockoutReasons.push("HARD_DURATION_EXCEEDED");
    if (safetyTrip) lockoutReasons.push(safetyTrip);
    if (evidence.feedFlowObservation === true
        && evidence.actionDurationMs >= hardDurationMs) {
        lockoutReasons.push("POSSIBLE_CONTINUOUS_FLOW");
    }
    if (quantity !== null
        && quantity > expectedQuantity + Math.max(0, expectedQuantity * tolerance)) {
        lockoutReasons.push("EXCESSIVE_FEED_MOVEMENT");
    }
    if (evidence.sensorDisagreement.length > 0) lockoutReasons.push("SENSOR_DISAGREEMENT");

    if (restartDetected || lockoutReasons.length > 0 || evidence.missingEvidence.length > 0) {
        return {
            outcome: "OUTCOME_UNKNOWN",
            feedMovementOccurred: movementProven ? true : null,
            measuredQuantity: quantity,
            lockoutReasons
        };
    }
    if (evidence.sensorDisagreement.length > 0) {
        return {
            outcome: "OUTCOME_UNKNOWN",
            feedMovementOccurred: movementProven ? true : null,
            measuredQuantity: quantity,
            lockoutReasons: ["SENSOR_DISAGREEMENT"]
        };
    }
    if (evidence.safetyAuthorityGranted && movementProven && withinTolerance) {
        return {
            outcome: "COMPLETED",
            feedMovementOccurred: true,
            measuredQuantity: quantity,
            lockoutReasons: []
        };
    }
    if (noMovementProven) {
        return {
            outcome: "FAILED",
            feedMovementOccurred: false,
            measuredQuantity: quantity ?? 0,
            lockoutReasons: []
        };
    }
    return {
        outcome: "OUTCOME_UNKNOWN",
        feedMovementOccurred: movementProven ? true : null,
        measuredQuantity: quantity,
        lockoutReasons: []
    };
}
