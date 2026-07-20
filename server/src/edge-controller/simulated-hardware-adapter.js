export const SIMULATED_HARDWARE_ADAPTER_VERSION = "phase-7e2-simulator-v1";

const DEFAULT_INPUTS = Object.freeze({
    electricalEmergencyStopHealthy: true,
    mainIsolatorOn: true,
    safetyControllerReady: true,
    safetyControllerWatchdogHealthy: true,
    motorContactorFeedback: false,
    motorCurrent: false,
    shaftRotation: false,
    feedFlow: false,
    receivingWeight: 10,
    hopperLevel: "OK",
    outletState: "OPEN",
    enclosureClosed: true
});

const DEFAULT_OUTPUTS = Object.freeze({
    bell: false,
    motorAuthorityRequest: false,
    augerRunRequest: false,
    warningIndicator: false,
    maintenanceModeIndicator: false
});

export class HardwareSafetyError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "HardwareSafetyError";
        this.code = code;
    }
}

export class SimulatedHardwareAdapter {
    constructor({ clock = () => new Date(), scenario = {} } = {}) {
        this.clock = clock;
        this.version = SIMULATED_HARDWARE_ADAPTER_VERSION;
        this.scenario = { mode: "NORMAL", quantity: 1, ...scenario };
        this.inputs = { ...DEFAULT_INPUTS, ...(scenario.inputs || {}) };
        this.outputs = { ...DEFAULT_OUTPUTS };
        this.evidence = [];
        this.resetOutputs("BOOT");
    }

    setScenario(scenario = {}) {
        this.scenario = { mode: "NORMAL", quantity: 1, ...scenario };
        this.inputs = { ...DEFAULT_INPUTS, ...(scenario.inputs || {}) };
        this.resetOutputs("SCENARIO_CHANGED");
    }

    readInputs() {
        return Object.freeze({
            ...this.inputs,
            hopperLevel: this.scenario.mode === "EMPTY_HOPPER"
                ? "EMPTY" : this.inputs.hopperLevel,
            outletState: this.scenario.mode === "BLOCKED_OUTLET"
                ? "BLOCKED" : this.inputs.outletState,
            electricalEmergencyStopHealthy:
                this.scenario.mode === "ELECTRICAL_EMERGENCY_STOP_OPEN"
                    ? false : this.inputs.electricalEmergencyStopHealthy,
            safetyControllerReady: this.scenario.mode === "SAFETY_CONTROLLER_UNAVAILABLE"
                ? false : this.inputs.safetyControllerReady
        });
    }

    getOutputs() {
        return Object.freeze({ ...this.outputs });
    }

    record(type, details = null) {
        const entry = { type, occurredAt: this.clock().toISOString(), details };
        this.evidence.push(entry);
        return entry;
    }

    resetOutputs(reason = "SAFE_RESET") {
        this.outputs = { ...DEFAULT_OUTPUTS };
        this.record("OUTPUTS_DEFAULTED_OFF", { reason });
    }

    setIndicator(name, active) {
        if (!["warningIndicator", "maintenanceModeIndicator"].includes(name)) {
            throw new Error("Indicator is not supported by the hardware abstraction.");
        }
        this.outputs[name] = active === true;
        this.record("INDICATOR_CHANGED", { name, active: this.outputs[name] });
    }

    async ringBell(durationMs, sleep = async () => {}) {
        if (this.scenario.mode === "BELL_FAILURE") {
            this.record("BELL_FAILED");
            throw new HardwareSafetyError("The simulated bell did not energise.", "BELL_FAILURE");
        }
        this.outputs.bell = true;
        this.record("BELL_ON", { durationMs });
        try {
            await sleep(durationMs);
        } finally {
            this.outputs.bell = false;
            this.record("BELL_OFF");
        }
    }

    safetyControllerSetAuthority(active) {
        this.outputs.motorAuthorityRequest = active === true;
        this.record("MOTOR_AUTHORITY_CHANGED", { active: active === true });
    }

    safetyControllerSetAuger(active) {
        this.outputs.augerRunRequest = active === true;
        if (active) {
            this.inputs.motorContactorFeedback = this.scenario.mode !== "MOTOR_FAILS_TO_START";
            this.inputs.motorCurrent = !["MOTOR_FAILS_TO_START", "FEED_FLOW_WITHOUT_MOTOR"]
                .includes(this.scenario.mode);
            this.inputs.shaftRotation = ![
                "MOTOR_FAILS_TO_START", "CURRENT_NO_SHAFT", "FEED_FLOW_WITHOUT_MOTOR"
            ].includes(this.scenario.mode);
            this.inputs.feedFlow = ![
                "MOTOR_FAILS_TO_START", "CURRENT_NO_SHAFT", "SHAFT_NO_FLOW",
                "EMPTY_HOPPER", "BLOCKED_OUTLET"
            ].includes(this.scenario.mode);
        } else if (this.scenario.mode !== "STUCK_OUTPUT") {
            this.inputs.motorContactorFeedback = false;
            this.inputs.motorCurrent = false;
            this.inputs.shaftRotation = false;
            this.inputs.feedFlow = false;
        }
        this.record("AUGER_REQUEST_CHANGED", { active: active === true });
    }

    captureWeightBefore() {
        return this.inputs.receivingWeight;
    }

    collectObservations(weightBefore) {
        const mode = this.scenario.mode;
        const moved = ![
            "MOTOR_FAILS_TO_START", "CURRENT_NO_SHAFT", "SHAFT_NO_FLOW",
            "EMPTY_HOPPER", "BLOCKED_OUTLET"
        ].includes(mode);
        let change = moved ? Number(this.scenario.quantity ?? 1) : 0;
        if (mode === "EXCESSIVE_WEIGHT") change *= 3;
        if (mode === "INSUFFICIENT_WEIGHT") change *= 0.1;
        const observations = {
            contactorFeedback: mode === "CONTACTOR_DISAGREEMENT"
                ? false : mode === "MOTOR_FAILS_TO_START" ? false : true,
            motorCurrent: mode === "FEED_FLOW_WITHOUT_MOTOR"
                ? false : mode === "MOTOR_FAILS_TO_START" ? false : true,
            shaftRotation: !["MOTOR_FAILS_TO_START", "CURRENT_NO_SHAFT",
                "FEED_FLOW_WITHOUT_MOTOR"].includes(mode),
            feedFlow: mode === "FEED_FLOW_WITHOUT_MOTOR"
                ? true : moved,
            weightBefore,
            weightAfter: weightBefore + change,
            hopperLevel: mode === "EMPTY_HOPPER" ? "EMPTY" : this.inputs.hopperLevel,
            outletState: mode === "BLOCKED_OUTLET" ? "BLOCKED" : this.inputs.outletState,
            confidence: "HIGH"
        };
        if (mode === "MISSING_EVIDENCE") {
            observations.motorCurrent = null;
            observations.shaftRotation = null;
            observations.feedFlow = null;
            observations.weightAfter = null;
        }
        if (mode === "CONTRADICTORY_EVIDENCE") {
            observations.motorCurrent = true;
            observations.shaftRotation = false;
            observations.feedFlow = true;
        }
        this.record("SENSOR_EVIDENCE_COLLECTED", observations);
        return observations;
    }
}
