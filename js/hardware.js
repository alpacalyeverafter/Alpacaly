// ==========================================
// Alpacaly Ever After
// Hardware Controller
// ==========================================

class HardwareController {
    constructor(config) {
        this.config = config;

        this.devices = {
            bell: {
                id: "bell-main",
                type: "bell",
                online: true,
                active: false
            },

            feeder: {
                id: "feeder-main",
                type: "feeder",
                online: true,
                active: false
            }
        };

        this.emergencyStopActive = false;
        this.lastFeedTime = null;
    }

    delay(milliseconds) {
        return new Promise(resolve => {
            setTimeout(resolve, milliseconds);
        });
    }

    getDevice(deviceName) {
        return this.devices[deviceName] || null;
    }

    getStatus() {
        return {
            simulationMode: this.config.simulationMode,
            emergencyStopActive: this.emergencyStopActive,
            bell: { ...this.devices.bell },
            feeder: { ...this.devices.feeder },
            lastFeedTime: this.lastFeedTime
        };
    }

    canOperate(deviceName) {
        const device = this.getDevice(deviceName);

        if (!device) {
            return {
                allowed: false,
                reason: "DEVICE_NOT_FOUND"
            };
        }

        if (!device.online) {
            return {
                allowed: false,
                reason: "DEVICE_OFFLINE"
            };
        }

        if (this.emergencyStopActive) {
            return {
                allowed: false,
                reason: "EMERGENCY_STOP_ACTIVE"
            };
        }

        if (device.active) {
            return {
                allowed: false,
                reason: "DEVICE_ALREADY_ACTIVE"
            };
        }

        return {
            allowed: true,
            reason: null
        };
    }

    async ringBell(eventId) {
        const check = this.canOperate("bell");

        if (!check.allowed) {
            return {
                success: false,
                eventId,
                device: "bell",
                error: check.reason
            };
        }

        const bell = this.devices.bell;
        bell.active = true;

        console.log(`[Hardware] Bell started for event ${eventId}`);

        try {
            await this.delay(this.config.bellDuration);

            return {
                success: true,
                eventId,
                device: "bell",
                confirmation: "BELL_COMPLETED",
                completedAt: new Date().toISOString()
            };
        } finally {
            bell.active = false;
            console.log(`[Hardware] Bell stopped for event ${eventId}`);
        }
    }

    async dispenseFeed(eventId) {
        const check = this.canOperate("feeder");

        if (!check.allowed) {
            return {
                success: false,
                eventId,
                device: "feeder",
                error: check.reason
            };
        }

        const feeder = this.devices.feeder;
        feeder.active = true;

        console.log(`[Hardware] Feeder started for event ${eventId}`);

        try {
            await this.delay(this.config.feedDuration);

            this.lastFeedTime = new Date().toISOString();

            return {
                success: true,
                eventId,
                device: "feeder",
                confirmation: "FEED_DISPENSED",
                completedAt: this.lastFeedTime
            };
        } finally {
            feeder.active = false;
            console.log(`[Hardware] Feeder stopped for event ${eventId}`);
        }
    }

    async runFeedSequence(eventId) {
        if (!eventId) {
            return {
                success: false,
                error: "EVENT_ID_REQUIRED"
            };
        }

        const bellResult = await this.ringBell(eventId);

        if (!bellResult.success) {
            return {
                success: false,
                stage: "BELL",
                bellResult
            };
        }

        const feedResult = await this.dispenseFeed(eventId);

        if (!feedResult.success) {
            return {
                success: false,
                stage: "FEEDER",
                bellResult,
                feedResult
            };
        }

        return {
            success: true,
            eventId,
            confirmation: "HARDWARE_SEQUENCE_CONFIRMED",
            bellResult,
            feedResult,
            completedAt: new Date().toISOString()
        };
    }

    setDeviceOnline(deviceName, online) {
        const device = this.getDevice(deviceName);

        if (!device) {
            return false;
        }

        device.online = Boolean(online);
        return true;
    }

    activateEmergencyStop() {
        this.emergencyStopActive = true;
        this.devices.bell.active = false;
        this.devices.feeder.active = false;

        console.warn("[Hardware] Emergency stop activated");
    }

    resetEmergencyStop() {
        this.emergencyStopActive = false;

        console.log("[Hardware] Emergency stop reset");
    }
}

const hardwareController = new HardwareController(CONFIG);