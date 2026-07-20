export class DeviceTransport {
    start() {}

    async deliver() {
        throw new Error("DeviceTransport.deliver must be implemented.");
    }

    async reconcile() {
        throw new Error("DeviceTransport.reconcile must be implemented.");
    }

    setSafetyService() {}

    async shutdown() {}
}

export class DeviceTransportError extends Error {
    constructor(message, {
        code = "DEVICE_TRANSPORT_ERROR",
        deliveryOutcome = "UNKNOWN",
        terminalFailure = false
    } = {}) {
        super(message);
        this.name = "DeviceTransportError";
        this.code = code;
        this.deliveryOutcome = deliveryOutcome;
        this.terminalFailure = terminalFailure;
    }
}
