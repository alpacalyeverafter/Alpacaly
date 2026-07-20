import { randomUUID } from "node:crypto";

import { HardwareSafetyError } from "./simulated-hardware-adapter.js";

export class SimulatedSafetyController {
    constructor({
        hardware,
        store,
        clock = () => new Date(),
        sleep = async () => {},
        idGenerator = randomUUID,
        hardMaximumDurationMs = 2000,
        watchdogTimeoutMs = 250,
        behaviour = "NORMAL"
    }) {
        this.hardware = hardware;
        this.store = store;
        this.clock = clock;
        this.sleep = sleep;
        this.idGenerator = idGenerator;
        this.hardMaximumDurationMs = hardMaximumDurationMs;
        this.watchdogTimeoutMs = watchdogTimeoutMs;
        this.behaviour = behaviour;
        this.bootId = `safety_boot_${idGenerator()}`;
        this.enabledToken = null;
        this.lastWatchdogAt = null;
        this.tripped = false;
        this.hardware.resetOutputs("SAFETY_CONTROLLER_BOOT");
    }

    setBehaviour(behaviour) {
        this.behaviour = String(behaviour || "NORMAL").toUpperCase();
    }

    status() {
        return {
            bootId: this.bootId,
            ready: this.hardware.readInputs().safetyControllerReady,
            watchdogHealthy: !this.tripped,
            authorityGranted: Boolean(this.enabledToken),
            behaviour: this.behaviour
        };
    }

    reboot() {
        this.removeAuthority("SAFETY_CONTROLLER_REBOOT");
        this.bootId = `safety_boot_${this.idGenerator()}`;
        this.tripped = false;
        return this.status();
    }

    enable({ cycleToken, maximumDurationMs }) {
        const inputs = this.hardware.readInputs();
        if (!inputs.electricalEmergencyStopHealthy) {
            throw new HardwareSafetyError(
                "Electrical emergency-stop circuit is open.",
                "ELECTRICAL_EMERGENCY_STOP_OPEN"
            );
        }
        if (!inputs.safetyControllerReady || this.behaviour === "REFUSE_ENABLE") {
            throw new HardwareSafetyError(
                "Safety controller refused output authority.",
                "SAFETY_CONTROLLER_REFUSED"
            );
        }
        if (["STALE_TOKEN", "DUPLICATE_TOKEN"].includes(this.behaviour)) {
            this.store.reserveSafetyToken(cycleToken, this.bootId, this.clock().toISOString());
        }
        this.store.reserveSafetyToken(cycleToken, this.bootId, this.clock().toISOString());
        const requested = Number(maximumDurationMs);
        if (!Number.isFinite(requested) || requested <= 0
            || requested > this.hardMaximumDurationMs) {
            throw new HardwareSafetyError(
                "Requested duration exceeds the safety-controller hard bound.",
                "HARD_DURATION_INVALID"
            );
        }
        this.enabledToken = cycleToken;
        this.lastWatchdogAt = this.clock().getTime();
        this.hardware.safetyControllerSetAuthority(true);
        return { granted: true, safetyControllerBootId: this.bootId, cycleToken };
    }

    pulseWatchdog(cycleToken) {
        if (cycleToken !== this.enabledToken) {
            throw new HardwareSafetyError("Watchdog token is not active.", "WATCHDOG_TOKEN_INVALID");
        }
        if (this.behaviour === "WATCHDOG_EXPIRY") {
            this.trip("WATCHDOG_EXPIRED");
            throw new HardwareSafetyError("Safety watchdog expired.", "WATCHDOG_EXPIRED");
        }
        if (this.behaviour === "REBOOT_DURING_ACTION") {
            this.reboot();
            throw new HardwareSafetyError(
                "Safety controller rebooted during the active cycle.",
                "SAFETY_CONTROLLER_REBOOTED"
            );
        }
        if (this.clock().getTime() - this.lastWatchdogAt > this.watchdogTimeoutMs) {
            this.trip("WATCHDOG_EXPIRED");
            throw new HardwareSafetyError("Safety watchdog expired.", "WATCHDOG_EXPIRED");
        }
        this.lastWatchdogAt = this.clock().getTime();
        return true;
    }

    async runBounded({ cycleToken, durationMs, pulseIntervalMs = 100 }) {
        if (cycleToken !== this.enabledToken) {
            throw new HardwareSafetyError("Output authority is absent.", "OUTPUT_AUTHORITY_ABSENT");
        }
        const inputs = this.hardware.readInputs();
        if (!inputs.electricalEmergencyStopHealthy) {
            this.trip("ELECTRICAL_EMERGENCY_STOP_OPEN");
            throw new HardwareSafetyError("Electrical emergency stop opened.", "ELECTRICAL_EMERGENCY_STOP_OPEN");
        }
        this.hardware.safetyControllerSetAuger(true);
        let elapsed = 0;
        try {
            while (elapsed < durationMs) {
                const step = Math.min(pulseIntervalMs, durationMs - elapsed);
                await this.sleep(step);
                elapsed += step;
                this.pulseWatchdog(cycleToken);
                if (!this.hardware.readInputs().electricalEmergencyStopHealthy) {
                    this.trip("ELECTRICAL_EMERGENCY_STOP_OPEN");
                    throw new HardwareSafetyError(
                        "Electrical emergency stop opened during execution.",
                        "ELECTRICAL_EMERGENCY_STOP_OPEN"
                    );
                }
                if (elapsed > this.hardMaximumDurationMs) {
                    this.trip("HARD_DURATION_EXCEEDED");
                    throw new HardwareSafetyError(
                        "Safety-controller hard duration exceeded.",
                        "HARD_DURATION_EXCEEDED"
                    );
                }
            }
        } finally {
            this.hardware.safetyControllerSetAuger(false);
            this.removeAuthority("BOUNDED_ACTION_COMPLETE");
        }
        if (this.behaviour === "OUTPUT_STUCK" || this.hardware.scenario.mode === "STUCK_OUTPUT") {
            this.trip("OUTPUT_STUCK");
            throw new HardwareSafetyError("Output feedback remained active.", "OUTPUT_STUCK");
        }
        return { durationMs: elapsed };
    }

    trip(reason) {
        this.tripped = true;
        this.hardware.setIndicator("warningIndicator", true);
        this.removeAuthority(reason);
    }

    removeAuthority(reason = "AUTHORITY_REMOVED") {
        this.hardware.safetyControllerSetAuger(false);
        this.hardware.safetyControllerSetAuthority(false);
        this.enabledToken = null;
        this.lastWatchdogAt = null;
        this.hardware.record("SAFETY_AUTHORITY_REMOVED", { reason });
    }

    shutdown() {
        this.removeAuthority("SHUTDOWN");
        this.hardware.resetOutputs("SHUTDOWN");
    }
}
