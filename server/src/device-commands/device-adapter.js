import { DeviceTransport } from "./device-transport.js";

// Backward-compatible Phase 7A name. New delivery implementations use the
// transport contract, while existing injected adapters remain valid transports.
export class DeviceAdapter extends DeviceTransport {}

export class DeviceUnavailableError extends Error {
    constructor(message = "The target device is unavailable.") {
        super(message);
        this.name = "DeviceUnavailableError";
        this.code = "DEVICE_UNAVAILABLE";
        this.deliveryOutcome = "CONFIRMED_NOT_PROCESSED";
    }
}

export class StaleFencingTokenError extends Error {
    constructor(message = "A newer command has already fenced this command out.") {
        super(message);
        this.name = "StaleFencingTokenError";
        this.code = "STALE_FENCING_TOKEN";
        this.deliveryOutcome = "CONFIRMED_NOT_PROCESSED";
        this.terminalFailure = true;
    }
}

export class DeviceCommandOutcomeUnknownError extends Error {
    constructor(message = "The device command outcome is unknown.") {
        super(message);
        this.name = "DeviceCommandOutcomeUnknownError";
        this.code = "DEVICE_COMMAND_OUTCOME_UNKNOWN";
        this.deliveryOutcome = "UNKNOWN";
    }
}
