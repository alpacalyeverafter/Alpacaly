import { createDeviceAcknowledgement } from "../domain/device-commands.js";
import {
    DeviceCommandOutcomeUnknownError,
    DeviceUnavailableError,
    StaleFencingTokenError
} from "../device-commands/device-adapter.js";

function abortableDelay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            const error = new Error("Controller execution was cancelled.");
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
            signal?.removeEventListener("abort", abort);
            const error = new Error("Controller execution was cancelled.");
            error.name = "AbortError";
            reject(error);
        }
        signal?.addEventListener("abort", abort, { once: true });
    });
}

export class SimulatedDeviceController {
    constructor({
        controllerId,
        store,
        deviceCommandStore,
        clock = () => new Date(),
        sleep = abortableDelay,
        safetyService = null
    }) {
        this.controllerId = controllerId;
        this.store = store;
        this.deviceCommandStore = deviceCommandStore;
        this.clock = clock;
        this.sleep = sleep;
        this.safetyService = safetyService;
    }

    setSafetyService(safetyService) {
        this.safetyService = safetyService;
    }

    async receive(command, {
        signal,
        emitAcknowledgement,
        behaviourOverride = null
    }) {
        const controller = this.requireAvailableController(command);
        const behaviour = behaviourOverride || controller.simulationBehaviour;
        if (behaviour.mode === "DISCONNECT_BEFORE_RECEIPT") {
            this.store.setConnectionState(this.controllerId, "OFFLINE");
            throw new DeviceUnavailableError(
                "Simulated controller disconnected before command receipt."
            );
        }

        let { journal, created } = this.store.beginJournal(
            this.controllerId,
            command,
            this.clock().toISOString()
        );
        if (!created) {
            const recovered = await this.resumeExisting(
                journal,
                command,
                emitAcknowledgement
            );
            if (recovered) {
                return recovered;
            }
            journal = this.store.getJournalForCommand(command.commandId);
        }

        const emit = acknowledgement => this.emit(
            command,
            controller,
            behaviour,
            acknowledgement,
            emitAcknowledgement
        );

        if (journal.executionState === "RECEIVED") {
            await this.sleep(behaviour.acknowledgementDelayMs, signal);
            if (behaviour.mode === "COMMAND_REJECTION") {
                const rejected = this.acknowledgement(
                    command,
                    controller,
                    "REJECTED",
                    {
                        errorCode: "SIMULATED_COMMAND_REJECTION",
                        errorMessage: "Controller rejected the command by configuration."
                    }
                );
                this.store.transitionJournal(journal.journalId, "REJECTED", {
                    timestamp: rejected.receivedAt,
                    finalAcknowledgement: rejected,
                    failureReason: rejected.errorMessage
                });
                emit(rejected);
                return { delivered: true, controllerId: this.controllerId };
            }
            const accepted = this.acknowledgement(command, controller, "ACCEPTED");
            journal = this.store.transitionJournal(journal.journalId, "ACCEPTED", {
                timestamp: accepted.receivedAt
            });
            emit(accepted);
        }

        if (journal.executionState === "ACCEPTED") {
            const started = this.acknowledgement(command, controller, "STARTED");
            journal = this.store.transitionJournal(journal.journalId, "STARTED", {
                timestamp: started.receivedAt
            });
            emit(started);
        }

        if (behaviour.mode === "FAIL_BEFORE_DISPENSE") {
            const failed = this.acknowledgement(command, controller, "FAILED", {
                errorCode: "SIMULATED_FAILURE_BEFORE_ACTION",
                errorMessage: "Controller failed before the simulated action."
            });
            this.store.transitionJournal(journal.journalId, "FAILED", {
                timestamp: failed.receivedAt,
                finalAcknowledgement: failed,
                failureReason: failed.errorMessage,
                dispensePerformed: false
            });
            emit(failed);
            return { delivered: true, controllerId: this.controllerId };
        }

        if (behaviour.mode === "DISCONNECT_DURING_EXECUTION") {
            this.store.setConnectionState(this.controllerId, "OFFLINE");
            throw new DeviceUnavailableError(
                "Simulated controller disconnected before the physical action."
            );
        }

        await this.sleep(behaviour.completionDelayMs, signal);
        this.requireAvailableController(command);
        const succeeded = this.acknowledgement(command, controller, "SUCCEEDED");
        const performedAt = this.clock().toISOString();
        const action = this.store.recordPhysicalAction(
            command,
            succeeded,
            performedAt
        );
        if (action.rejectedAsStale) {
            throw new StaleFencingTokenError(
                `Controller rejected stale fencing token ${command.fencingToken}.`
            );
        }
        const dispensePerformed = command.commandType === "DISPENSE_FEED";
        journal = this.store.transitionJournal(journal.journalId, "STARTED", {
            timestamp: performedAt,
            dispensePerformed,
            details: { physicalActionRecorded: true, created: action.created }
        });

        if (["FAIL_AFTER_DISPENSE", "RESTART_DURING_EXECUTION"].includes(
            behaviour.mode
        )) {
            this.store.transitionJournal(journal.journalId, "OUTCOME_UNKNOWN", {
                timestamp: this.clock().toISOString(),
                dispensePerformed,
                failureReason: behaviour.mode === "RESTART_DURING_EXECUTION"
                    ? "Controller restarted after action before completion acknowledgement"
                    : "Controller failed after the simulated action"
            });
            throw new DeviceCommandOutcomeUnknownError(
                "The controller cannot prove the outcome after the physical action."
            );
        }

        journal = this.store.transitionJournal(journal.journalId, "COMPLETED", {
            timestamp: succeeded.receivedAt,
            dispensePerformed,
            finalAcknowledgement: succeeded
        });
        if (behaviour.mode !== "ACKNOWLEDGEMENT_LOSS") {
            try {
                emit(succeeded);
            } catch (error) {
                this.store.transitionJournal(journal.journalId, "OUTCOME_UNKNOWN", {
                    timestamp: this.clock().toISOString(),
                    dispensePerformed,
                    failureReason: String(error.message || error),
                    details: { acknowledgementRejected: true }
                });
                throw new DeviceCommandOutcomeUnknownError(
                    "Completion acknowledgement could not be validated."
                );
            }
        }
        return { delivered: true, controllerId: this.controllerId };
    }

    async resumeExisting(journal, command, emitAcknowledgement) {
        if (["COMPLETED", "REJECTED", "FAILED"].includes(
            journal.executionState
        )) {
            if (journal.finalAcknowledgement) {
                emitAcknowledgement(this.envelope(command, journal.finalAcknowledgement));
            }
            return {
                delivered: true,
                duplicateDelivery: true,
                controllerId: this.controllerId
            };
        }
        if (
            journal.executionState === "OUTCOME_UNKNOWN"
            || (journal.executionState === "STARTED" && journal.dispensePerformed)
        ) {
            if (journal.executionState !== "OUTCOME_UNKNOWN") {
                this.store.transitionJournal(journal.journalId, "OUTCOME_UNKNOWN", {
                    timestamp: this.clock().toISOString(),
                    dispensePerformed: true,
                    failureReason: "Recovered after action without final acknowledgement"
                });
            }
            throw new DeviceCommandOutcomeUnknownError(
                "Controller recovery found an uncertain physical outcome."
            );
        }
        return null;
    }

    emit(command, controller, behaviour, acknowledgement, emitAcknowledgement) {
        let envelope = this.envelope(command, acknowledgement);
        const corruptFinalAcknowledgement = acknowledgement.result === "SUCCEEDED";
        if (
            corruptFinalAcknowledgement
            && behaviour.mode === "WRONG_CONTROLLER_IDENTITY"
        ) {
            envelope = { ...envelope, controllerId: "controller_wrong_identity" };
        } else if (
            corruptFinalAcknowledgement
            && behaviour.mode === "WRONG_FEEDER_IDENTITY"
        ) {
            envelope = { ...envelope, feederId: "feeder_wrong_identity" };
        } else if (
            corruptFinalAcknowledgement
            && behaviour.mode === "MALFORMED_ACKNOWLEDGEMENT"
        ) {
            envelope = {
                ...envelope,
                acknowledgement: { ...acknowledgement, result: "MALFORMED" }
            };
        }
        emitAcknowledgement(envelope);
        if (behaviour.mode === "DUPLICATE_ACKNOWLEDGEMENT") {
            emitAcknowledgement(envelope);
        }
    }

    envelope(command, acknowledgement) {
        return {
            controllerId: this.controllerId,
            barnId: command.barnId,
            feederId: command.feederId,
            acknowledgement
        };
    }

    acknowledgement(command, controller, result, overrides = {}) {
        const timestamp = this.clock().toISOString();
        return createDeviceAcknowledgement({
            acknowledgementId:
                `controller_ack_${command.commandId}_${result.toLowerCase()}`,
            commandId: command.commandId,
            deviceId: command.deviceId,
            acknowledgementType: `${command.commandType}_${result}`,
            receivedAt: timestamp,
            deviceTimestamp: timestamp,
            result,
            measuredQuantity: result === "SUCCEEDED"
                && command.commandType === "DISPENSE_FEED"
                ? command.commandPayload?.quantity ?? 1
                : null,
            errorCode: overrides.errorCode || null,
            errorMessage: overrides.errorMessage || null,
            metadata: {
                simulated: true,
                controllerId: controller.controllerId,
                feederId: command.feederId,
                protocolVersion: controller.protocolVersion,
                fencingToken: command.fencingToken
            }
        });
    }

    requireAvailableController(command) {
        const controller = this.store.requireController(this.controllerId);
        if (!controller.enabled || controller.status === "DISABLED") {
            throw new DeviceUnavailableError("The simulated controller is disabled.");
        }
        if (controller.status !== "ONLINE") {
            throw new DeviceUnavailableError("The simulated controller is offline.");
        }
        if (!this.store.isAuthorized(this.controllerId, command)) {
            const error = new DeviceUnavailableError(
                "The controller is not authorised for the command resource."
            );
            error.code = "CONTROLLER_RESOURCE_NOT_AUTHORISED";
            error.terminalFailure = true;
            throw error;
        }
        if (
            this.deviceCommandStore.getDeviceOperationalStatus(command.deviceId)
                ?.operationalStatus !== "AVAILABLE"
        ) {
            throw new DeviceUnavailableError("The assigned device is unavailable.");
        }
        this.assertSafety(command);
        return controller;
    }

    assertSafety(command) {
        this.safetyService?.assertCommandMayProgress(command);
    }
}
