import {
    DeviceCommandOutcomeUnknownError,
    DeviceUnavailableError
} from "../device-commands/device-adapter.js";
import { DeviceTransport } from "../device-commands/device-transport.js";
import { SimulatedDeviceController } from "./simulated-device-controller.js";

export class InProcessDeviceTransport extends DeviceTransport {
    constructor({
        store,
        deviceCommandStore,
        clock = () => new Date(),
        controllerSleep,
        heartbeatIntervalMs = 5000
    }) {
        super();
        this.store = store;
        this.deviceCommandStore = deviceCommandStore;
        this.clock = clock;
        this.controllerSleep = controllerSleep;
        this.heartbeatIntervalMs = heartbeatIntervalMs;
        this.controllers = new Map();
        this.deviceAvailability = new Map();
        this.commandBehaviours = new Map();
        this.safetyService = null;
        this.onAcknowledgement = () => {};
        this.onTransportError = () => {};
        this.started = false;
        this.heartbeatTimer = null;
    }

    start({ onAcknowledgement, onTransportError } = {}) {
        this.onAcknowledgement = onAcknowledgement || this.onAcknowledgement;
        this.onTransportError = onTransportError || this.onTransportError;
        if (this.started) {
            return;
        }
        this.started = true;
        this.heartbeatNow();
        this.scheduleHeartbeat();
    }

    setSafetyService(safetyService) {
        this.safetyService = safetyService;
        this.controllers.forEach(controller => (
            controller.setSafetyService(safetyService)
        ));
    }

    async deliver(command, { signal } = {}) {
        if (!this.started) {
            throw new DeviceUnavailableError("Device transport is not running.");
        }
        const controllerRecord = this.store.ensureControllerForFeeder({
            barnId: command.barnId,
            feederId: command.feederId,
            createdAt: this.clock().toISOString()
        });
        if (this.deviceAvailability.get(command.deviceId) === false) {
            throw new DeviceUnavailableError();
        }
        const compatibility = this.commandBehaviours.get(command.commandId);
        if (compatibility?.throwBeforeAction) {
            throw new DeviceUnavailableError(
                compatibility.errorMessage
                || "Simulated delivery failed before action."
            );
        }
        if (compatibility?.performAction === false) {
            return { delivered: true, controllerId: controllerRecord.controllerId };
        }
        const controller = this.runtime(controllerRecord.controllerId);
        try {
            return await controller.receive(command, {
                signal,
                emitAcknowledgement: envelope => this.receiveAcknowledgement(
                    command,
                    envelope
                ),
                behaviourOverride: this.compatibilityBehaviour(compatibility)
            });
        } catch (error) {
            this.onTransportError({
                controllerId: controllerRecord.controllerId,
                commandId: command.commandId,
                error
            });
            throw error;
        }
    }

    receiveAcknowledgement(command, envelope) {
        const controller = this.store.getController(envelope?.controllerId);
        if (
            !controller
            || controller.controllerId !== envelope.controllerId
            || controller.barnId !== command.barnId
            || envelope.barnId !== command.barnId
            || envelope.feederId !== command.feederId
            || !this.store.isAuthorized(controller.controllerId, command)
        ) {
            throw new DeviceCommandOutcomeUnknownError(
                "Controller acknowledgement resource identity is invalid."
            );
        }
        return this.onAcknowledgement(envelope.acknowledgement);
    }

    async reconcile(command) {
        const compatibility = this.commandBehaviours.get(command.commandId);
        if (compatibility?.reconciliationOutcome) {
            return {
                outcome: compatibility.reconciliationOutcome,
                acknowledgement: null
            };
        }
        const journal = this.store.getJournalForCommand(command.commandId);
        const execution = this.deviceCommandStore.getSimulatedExecution(
            command.commandId
        );
        if (journal?.executionState === "COMPLETED" && journal.finalAcknowledgement) {
            return {
                outcome: "PROCESSED",
                acknowledgement: journal.finalAcknowledgement
            };
        }
        if (
            journal?.executionState === "OUTCOME_UNKNOWN"
            || journal?.dispensePerformed
        ) {
            return { outcome: "UNKNOWN", acknowledgement: null };
        }
        if (execution?.acknowledgement) {
            return {
                outcome: "PROCESSED",
                acknowledgement: execution.acknowledgement
            };
        }
        return { outcome: "CONFIRMED_NOT_PROCESSED", acknowledgement: null };
    }

    runtime(controllerId) {
        if (!this.controllers.has(controllerId)) {
            this.controllers.set(controllerId, new SimulatedDeviceController({
                controllerId,
                store: this.store,
                deviceCommandStore: this.deviceCommandStore,
                clock: this.clock,
                safetyService: this.safetyService,
                ...(this.controllerSleep ? { sleep: this.controllerSleep } : {})
            }));
        }
        return this.controllers.get(controllerId);
    }

    restartController(controllerId) {
        const controller = this.store.requireController(controllerId);
        this.controllers.delete(controllerId);
        const uncertainCommandIds = this.store.getIncompleteJournals()
            .filter(journal => journal.controllerId === controllerId)
            .filter(journal => journal.dispensePerformed)
            .map(journal => {
                this.store.transitionJournal(
                    journal.journalId,
                    "OUTCOME_UNKNOWN",
                    {
                        timestamp: this.clock().toISOString(),
                        dispensePerformed: true,
                        failureReason:
                            "Controller restarted after dispense before completion acknowledgement"
                    }
                );
                return journal.commandId;
            });
        return { controller, uncertainCommandIds };
    }

    heartbeatNow() {
        if (!this.started || this.store.eventStore.closed) {
            return [];
        }
        return this.store.getControllers().map(controller => {
            if (
                controller.enabled
                && controller.connectionState === "ONLINE"
                && controller.simulationBehaviour.mode !== "HEARTBEAT_LOSS"
            ) {
                return this.store.heartbeat(
                    controller.controllerId,
                    this.clock().toISOString()
                );
            }
            return controller;
        });
    }

    scheduleHeartbeat() {
        if (!this.started || this.heartbeatIntervalMs <= 0) {
            return;
        }
        this.heartbeatTimer = setTimeout(() => {
            this.heartbeatTimer = null;
            try {
                this.heartbeatNow();
            } catch (error) {
                this.onTransportError({ error });
            }
            this.scheduleHeartbeat();
        }, this.heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();
    }

    setConnectionState(controllerId, state) {
        const controller = this.store.setConnectionState(
            controllerId,
            state,
            this.clock().toISOString()
        );
        return controller.connectionState === "ONLINE"
            ? this.store.heartbeat(controllerId, this.clock().toISOString())
            : controller;
    }

    setDeviceAvailable(deviceId, available) {
        this.deviceAvailability.set(deviceId, Boolean(available));
    }

    setCommandBehavior(commandId, behaviour) {
        this.commandBehaviours.set(commandId, { ...behaviour });
    }

    compatibilityBehaviour(behaviour) {
        if (!behaviour) {
            return null;
        }
        return {
            mode: behaviour.dropAcknowledgement
                ? "ACKNOWLEDGEMENT_LOSS"
                : behaviour.result === "REJECTED"
                    ? "COMMAND_REJECTION"
                    : behaviour.result === "FAILED"
                        ? "FAIL_BEFORE_DISPENSE"
                        : "NORMAL",
            acknowledgementDelayMs: 0,
            completionDelayMs: Math.max(0, Number(behaviour.delayMs) || 0)
        };
    }

    async shutdown() {
        this.started = false;
        if (this.heartbeatTimer) {
            clearTimeout(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.controllers.clear();
    }
}
