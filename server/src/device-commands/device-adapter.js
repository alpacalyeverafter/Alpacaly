export class DeviceAdapter {
    start() {}

    async deliver() {
        throw new Error("DeviceAdapter.deliver must be implemented.");
    }

    async reconcile() {
        throw new Error("DeviceAdapter.reconcile must be implemented.");
    }

    async shutdown() {}
}

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
