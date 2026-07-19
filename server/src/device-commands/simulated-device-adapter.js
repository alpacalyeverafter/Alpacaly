import { createDeviceAcknowledgement } from "../domain/device-commands.js";
import {
    DeviceAdapter,
    DeviceUnavailableError,
    StaleFencingTokenError
} from "./device-adapter.js";

function abortableDelay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            const error = new Error("Simulated device delivery was cancelled.");
            error.name = "AbortError";
            reject(error);
            return;
        }
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, Math.max(0, milliseconds));
        function abort() {
            clearTimeout(timeout);
            const error = new Error("Simulated device delivery was cancelled.");
            error.name = "AbortError";
            reject(error);
        }
        signal?.addEventListener("abort", abort, { once: true });
    });
}

export class SimulatedDeviceAdapter extends DeviceAdapter {
    constructor({
        deviceCommandStore,
        clock = () => new Date(),
        sleep = abortableDelay,
        bellDelayMs = 3000,
        dispensingDelayMs = 2000
    }) {
        super();
        this.deviceCommandStore = deviceCommandStore;
        this.clock = clock;
        this.sleep = sleep;
        this.delays = {
            RING_BELL: bellDelayMs,
            DISPENSE_FEED: dispensingDelayMs
        };
        this.deviceAvailability = new Map();
        this.commandBehaviors = new Map();
        this.stopped = false;
    }

    start() {
        this.stopped = false;
    }

    setDeviceAvailable(deviceId, available) {
        this.deviceAvailability.set(deviceId, Boolean(available));
    }

    setCommandBehavior(commandId, behavior) {
        this.commandBehaviors.set(commandId, { ...behavior });
    }

    isDeviceAvailable(deviceId) {
        return this.deviceAvailability.get(deviceId) !== false;
    }

    async deliver(command, { signal } = {}) {
        if (this.stopped || !this.isDeviceAvailable(command.deviceId)) {
            throw new DeviceUnavailableError();
        }
        const existing = this.deviceCommandStore.getSimulatedExecution(
            command.commandId
        );
        if (existing) {
            return { ...existing.acknowledgement };
        }

        const behavior = this.commandBehaviors.get(command.commandId) || {};
        if (behavior.throwBeforeAction) {
            throw new DeviceUnavailableError(
                behavior.errorMessage || "Simulated delivery failed before action."
            );
        }
        await this.sleep(
            behavior.delayMs ?? this.delays[command.commandType] ?? 0,
            signal
        );
        if (signal?.aborted) {
            const error = new Error("Simulated device delivery was cancelled.");
            error.name = "AbortError";
            throw error;
        }
        if (behavior.performAction === false) {
            return null;
        }

        const performedAt = this.clock().toISOString();
        const acknowledgement = createDeviceAcknowledgement({
            acknowledgementId:
                behavior.acknowledgementId
                || `device_ack_${command.commandId}_result`,
            commandId: command.commandId,
            deviceId: command.deviceId,
            acknowledgementType: `${command.commandType}_RESULT`,
            receivedAt: performedAt,
            deviceTimestamp: performedAt,
            result: behavior.result || "SUCCEEDED",
            measuredQuantity: command.commandType === "DISPENSE_FEED"
                ? behavior.measuredQuantity
                    ?? command.commandPayload?.quantity
                    ?? 1
                : null,
            errorCode: behavior.errorCode || null,
            errorMessage: behavior.errorMessage || null,
            metadata: {
                simulated: true,
                fencingToken: command.fencingToken,
                ...(behavior.metadata || {})
            }
        });
        const result = this.deviceCommandStore.recordSimulatedExecution(
            command,
            acknowledgement,
            performedAt
        );
        if (result.rejectedAsStale) {
            throw new StaleFencingTokenError(
                `Command fencing token ${command.fencingToken} is not newer than `
                + `device token ${result.highestFencingToken}.`
            );
        }
        const execution = result.execution;

        return behavior.dropAcknowledgement
            ? null
            : { ...execution.acknowledgement };
    }

    async reconcile(command) {
        const execution = this.deviceCommandStore.getSimulatedExecution(
            command.commandId
        );
        if (execution) {
            return {
                outcome: "PROCESSED",
                acknowledgement: { ...execution.acknowledgement }
            };
        }
        const behavior = this.commandBehaviors.get(command.commandId) || {};
        return {
            outcome: behavior.reconciliationOutcome || "CONFIRMED_NOT_PROCESSED",
            acknowledgement: null
        };
    }

    async shutdown() {
        this.stopped = true;
    }
}
