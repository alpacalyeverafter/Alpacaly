import { randomUUID } from "node:crypto";

import {
    DEVICE_COMMAND_TYPES,
    createDeviceCommand
} from "../domain/device-commands.js";
import { ApplicationError } from "../errors/application-error.js";

export class DeviceCommandService {
    constructor({
        deviceCommandStore,
        eventStore,
        logger,
        maximumAttempts = 3,
        clock = () => new Date(),
        idGenerator = randomUUID,
        onCommandAcknowledged = () => {},
        onCommandOutcomeUnknown = () => {}
    }) {
        this.deviceCommandStore = deviceCommandStore;
        this.eventStore = eventStore;
        this.logger = logger;
        this.maximumAttempts = maximumAttempts;
        this.clock = clock;
        this.idGenerator = idGenerator;
        this.onCommandAcknowledged = onCommandAcknowledged;
        this.onCommandOutcomeUnknown = onCommandOutcomeUnknown;
        this.worker = null;
        this.safetyService = null;
    }

    setWorker(worker) {
        this.worker = worker;
    }

    setSafetyService(safetyService) {
        this.safetyService = safetyService;
    }

    ensureCommandForEvent(feedRequest, commandType) {
        const normalizedType = String(commandType || "").trim().toUpperCase();
        if (!DEVICE_COMMAND_TYPES.includes(normalizedType)) {
            throw new ApplicationError("Device command type is not supported.", {
                code: "DEVICE_COMMAND_TYPE_NOT_SUPPORTED",
                statusCode: 400,
                details: { commandType }
            });
        }
        const existing = this.deviceCommandStore.getCommandForEventAction(
            feedRequest.eventId,
            normalizedType
        );
        if (existing) {
            return { command: existing, created: false };
        }

        if (this.safetyService?.isFeederBlocked(
            feedRequest.feederId,
            feedRequest.barnId
        )) {
            throw new ApplicationError(
                "The feeder is blocked by an active safety condition.",
                {
                    code: "FEEDER_SAFETY_BLOCKED",
                    statusCode: 409
                }
            );
        }

        const now = this.clock().toISOString();
        const assignment = this.deviceCommandStore.ensureFeederDeviceAssignment({
            feederId: feedRequest.feederId,
            barnId: feedRequest.barnId,
            createdAt: now
        });
        const contribution = this.eventStore.getContribution(
            feedRequest.contributionId
        );
        const commandPayload = normalizedType === "RING_BELL"
            ? { pattern: "STANDARD_FEED_BELL" }
            : {
                quantity: contribution?.feedQuantity || 1,
                unit: "FEED_PORTION"
            };
        const command = createDeviceCommand({
            eventId: feedRequest.eventId,
            barnId: feedRequest.barnId,
            feederId: feedRequest.feederId,
            deviceId: assignment.deviceId,
            commandType: normalizedType,
            commandPayload,
            idempotencyKey: `${feedRequest.eventId}:${normalizedType}`,
            status: "PENDING",
            maximumAttempts: this.maximumAttempts,
            createdAt: now
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });
        const result = this.deviceCommandStore.createCommand(command);

        this.logger.info({
            event: "device_command_created",
            commandId: result.command.commandId,
            eventId: result.command.eventId,
            commandType: result.command.commandType,
            feederId: result.command.feederId,
            deviceId: result.command.deviceId,
            created: result.created
        }, "Durable DeviceCommand ready for delivery");

        return result;
    }

    createReplacementCommand({
        originalCommand,
        resolutionCase,
        approvalRequestId,
        welfareCheck
    }) {
        const existing = this.deviceCommandStore.getCommandsForEvent(
            originalCommand.eventId
        ).find(command => command.resolutionCaseId === resolutionCase.resolutionCaseId);
        if (existing) {
            return existing;
        }
        const now = this.clock().toISOString();
        const command = createDeviceCommand({
            eventId: originalCommand.eventId,
            barnId: originalCommand.barnId,
            feederId: originalCommand.feederId,
            deviceId: originalCommand.deviceId,
            commandType: "DISPENSE_FEED",
            commandPayload: originalCommand.commandPayload,
            idempotencyKey:
                `${originalCommand.eventId}:DISPENSE_FEED:replacement:${resolutionCase.resolutionCaseId}`,
            status: "PENDING",
            maximumAttempts: this.maximumAttempts,
            createdAt: now,
            replacementOfCommandId: originalCommand.commandId,
            resolutionCaseId: resolutionCase.resolutionCaseId
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });
        const result = this.deviceCommandStore.createReplacementCommand(command);
        this.logger.info({
            event: "replacement_device_command_created",
            commandId: result.command.commandId,
            replacementOfCommandId: originalCommand.commandId,
            resolutionCaseId: resolutionCase.resolutionCaseId,
            approvalRequestId,
            welfareCheck,
            created: result.created
        }, "Approved replacement DeviceCommand created");
        this.worker?.processCommand(result.command.commandId);
        return result.command;
    }

    async executeEventAction(feedRequest, commandType, { signal } = {}) {
        if (!this.worker) {
            throw new Error("Device Command worker is not configured.");
        }
        const { command } = this.ensureCommandForEvent(feedRequest, commandType);
        const resolved = await this.worker.driveCommandToResolution(
            command.commandId,
            { signal }
        );
        if (resolved === null) {
            return false;
        }
        if (resolved.status === "ACKNOWLEDGED") {
            return true;
        }

        throw new ApplicationError(
            resolved.status === "OUTCOME_UNKNOWN"
                ? "The device command outcome is unknown; lifecycle advancement is blocked."
                : "The device command failed; lifecycle advancement is blocked.",
            {
                code: resolved.status === "OUTCOME_UNKNOWN"
                    ? "DEVICE_COMMAND_OUTCOME_UNKNOWN"
                    : "DEVICE_COMMAND_FAILED",
                statusCode: 503,
                details: {
                    commandId: resolved.commandId,
                    commandType: resolved.commandType,
                    status: resolved.status,
                    attemptCount: resolved.attemptCount,
                    lastError: resolved.lastError
                }
            }
        );
    }

    commandAcknowledged(payload) {
        this.onCommandAcknowledged(payload);
    }

    commandOutcomeUnknown(payload) {
        this.onCommandOutcomeUnknown(payload);
    }

    setOutcomeUnknownHandler(handler) {
        this.onCommandOutcomeUnknown = handler;
    }

    prepareForReset() {
        this.worker?.cancelInFlight();
    }

    cancel(commandId, reason = "CANCELLED") {
        const command = this.deviceCommandStore.getCommand(commandId);
        if (!command) {
            throw new ApplicationError("Device command not found.", {
                code: "DEVICE_COMMAND_NOT_FOUND",
                statusCode: 404
            });
        }
        if (["ACKNOWLEDGED", "FAILED", "OUTCOME_UNKNOWN", "CANCELLED"].includes(
            command.status
        )) {
            return command;
        }
        return this.deviceCommandStore.transitionCommand(commandId, "CANCELLED", {
            timestamp: this.clock().toISOString(),
            details: { reason },
            lastError: reason
        });
    }
}
