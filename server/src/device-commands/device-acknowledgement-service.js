import {
    createDeviceAcknowledgement,
    isTerminalDeviceCommandState
} from "../domain/device-commands.js";
import { ApplicationError } from "../errors/application-error.js";

const RESULT_ORDER = Object.freeze({
    ACCEPTED: 1,
    STARTED: 2,
    SUCCEEDED: 3,
    REJECTED: 3,
    FAILED: 3
});

export class DeviceAcknowledgementService {
    constructor({
        deviceCommandStore,
        logger,
        clock = () => new Date(),
        idGenerator,
        onSuccessfulAcknowledgement = () => {}
    }) {
        this.deviceCommandStore = deviceCommandStore;
        this.logger = logger;
        this.clock = clock;
        this.idGenerator = idGenerator;
        this.onSuccessfulAcknowledgement = onSuccessfulAcknowledgement;
    }

    record(input) {
        const acknowledgement = createDeviceAcknowledgement(input, {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        });
        const command = this.deviceCommandStore.getCommand(
            acknowledgement.commandId
        );
        if (!command) {
            throw new ApplicationError("Device command not found.", {
                code: "DEVICE_COMMAND_NOT_FOUND",
                statusCode: 404
            });
        }
        if (command.deviceId !== acknowledgement.deviceId) {
            throw new ApplicationError(
                "Acknowledgement device does not match the command target.",
                {
                    code: "DEVICE_ACKNOWLEDGEMENT_DEVICE_MISMATCH",
                    statusCode: 409
                }
            );
        }

        const duplicate = this.deviceCommandStore.getAcknowledgement(
            acknowledgement.acknowledgementId
        );
        if (duplicate) {
            this.deviceCommandStore.appendAuditRecord(
                command.commandId,
                "DUPLICATE_ACKNOWLEDGEMENT",
                acknowledgement.receivedAt,
                { acknowledgementId: acknowledgement.acknowledgementId },
                duplicate.acknowledgementId
            );
            return {
                acknowledgement: duplicate,
                command: this.deviceCommandStore.getCommand(command.commandId),
                duplicate: true,
                late: false,
                outOfOrder: false
            };
        }

        const priorAcknowledgements = this.deviceCommandStore
            .getAcknowledgementsForCommand(command.commandId);
        const highestPriorOrder = priorAcknowledgements.reduce(
            (highest, item) => Math.max(highest, RESULT_ORDER[item.result] || 0),
            0
        );
        const outOfOrder = (RESULT_ORDER[acknowledgement.result] || 0)
            < highestPriorOrder;
        const deadline = Date.parse(command.acknowledgementDeadline);
        const late = isTerminalDeviceCommandState(command.status)
            || (Number.isFinite(deadline)
                && Date.parse(acknowledgement.receivedAt) > deadline);
        const transitions = [];
        let legacyAcknowledgement = null;

        if (acknowledgement.result === "SUCCEEDED") {
            if (!["FAILED", "CANCELLED", "ACKNOWLEDGED"].includes(command.status)) {
                transitions.push({
                    status: "ACKNOWLEDGED",
                    timestamp: acknowledgement.receivedAt,
                    details: {
                        acknowledgementId: acknowledgement.acknowledgementId,
                        result: acknowledgement.result,
                        late
                    }
                });
                legacyAcknowledgement = {
                    stage: command.commandType === "RING_BELL"
                        ? "BELL"
                        : "DISPENSING",
                    status: "ACKNOWLEDGED",
                    details: {
                        commandId: command.commandId,
                        deviceId: command.deviceId,
                        result: acknowledgement.result,
                        measuredQuantity: acknowledgement.measuredQuantity,
                        simulated: acknowledgement.metadata?.simulated === true
                    }
                };
            }
        } else if (["REJECTED", "FAILED"].includes(acknowledgement.result)) {
            if (!isTerminalDeviceCommandState(command.status)) {
                transitions.push({
                    status: "FAILED",
                    timestamp: acknowledgement.receivedAt,
                    details: {
                        acknowledgementId: acknowledgement.acknowledgementId,
                        result: acknowledgement.result,
                        errorCode: acknowledgement.errorCode
                    },
                    lastError:
                        acknowledgement.errorMessage
                        || acknowledgement.errorCode
                        || `Device returned ${acknowledgement.result}`
                });
            }
        }

        const result = this.deviceCommandStore.recordAcknowledgement(
            acknowledgement,
            {
                transitions,
                late,
                outOfOrder,
                legacyAcknowledgement
            }
        );
        if (
            result.command.status === "ACKNOWLEDGED"
            && transitions.some(transition => transition.status === "ACKNOWLEDGED")
        ) {
            this.onSuccessfulAcknowledgement({
                command: result.command,
                acknowledgement: result.acknowledgement,
                legacyAcknowledgement
            });
        }

        this.logger.info({
            event: "device_acknowledgement_recorded",
            commandId: command.commandId,
            acknowledgementId: acknowledgement.acknowledgementId,
            result: acknowledgement.result,
            duplicate: result.duplicate,
            late,
            outOfOrder
        }, "Device acknowledgement recorded");

        return result;
    }
}
