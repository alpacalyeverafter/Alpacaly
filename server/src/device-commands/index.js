import { DeviceAcknowledgementService } from "./device-acknowledgement-service.js";
import { DeviceCommandService } from "./device-command-service.js";
import { DeviceCommandWorker } from "./device-command-worker.js";
import { SimulatedDeviceAdapter } from "./simulated-device-adapter.js";
import { SqliteDeviceCommandStore } from "./sqlite-device-command-store.js";

export function createDeviceCommandServices({
    eventEngine,
    eventStore = eventEngine.eventStore,
    config,
    logger,
    clock = eventEngine.clock,
    idGenerator,
    deviceAdapter = null,
    adapterSleep,
    workerSleep,
    startWorker = false
}) {
    const deviceCommandStore = new SqliteDeviceCommandStore({
        eventStore,
        ...(idGenerator ? { idGenerator } : {})
    });
    const simulatedDeviceAdapter = deviceAdapter || new SimulatedDeviceAdapter({
        deviceCommandStore,
        clock,
        bellDelayMs: config.lifecycleBellMs,
        dispensingDelayMs: config.lifecycleDispensingMs,
        ...(adapterSleep ? { sleep: adapterSleep } : {})
    });
    let deviceCommandService;
    const acknowledgementService = new DeviceAcknowledgementService({
        deviceCommandStore,
        logger,
        clock,
        ...(idGenerator ? { idGenerator } : {}),
        onSuccessfulAcknowledgement: payload => {
            const stage = payload.command.commandType === "RING_BELL"
                ? "BELL"
                : "DISPENSING";
            eventEngine.applyPersistedDeviceAcknowledgement(
                payload.command.eventId,
                stage,
                {
                    status: "ACKNOWLEDGED",
                    receivedAt: payload.acknowledgement.receivedAt,
                    details: payload.legacyAcknowledgement.details
                }
            );
            deviceCommandService.commandAcknowledged(payload);
            eventEngine.scheduleProcessing(payload.command.feederId);
        }
    });
    deviceCommandService = new DeviceCommandService({
        deviceCommandStore,
        eventStore,
        logger,
        clock,
        maximumAttempts: config.deviceCommandMaximumAttempts,
        ...(idGenerator ? { idGenerator } : {})
    });
    const worker = new DeviceCommandWorker({
        deviceCommandStore,
        deviceAdapter: simulatedDeviceAdapter,
        acknowledgementService,
        logger,
        clock,
        pollIntervalMs: config.deviceCommandPollIntervalMs,
        acknowledgementTimeoutMs: config.deviceAcknowledgementTimeoutMs,
        retryDelayMs: config.deviceCommandRetryDelayMs,
        ...(workerSleep ? { sleep: workerSleep } : {}),
        onOutcomeUnknown: command => {
            deviceCommandService.commandOutcomeUnknown(command);
        }
    });
    deviceCommandService.setWorker(worker);
    eventEngine.setDeviceCommandService(deviceCommandService);

    if (startWorker) {
        worker.start();
    }

    return {
        deviceCommandStore,
        deviceAdapter: simulatedDeviceAdapter,
        acknowledgementService,
        deviceCommandService,
        worker
    };
}
