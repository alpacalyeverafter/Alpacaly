import { DeviceAcknowledgementService } from "./device-acknowledgement-service.js";
import { DeviceCommandService } from "./device-command-service.js";
import { DeviceCommandWorker } from "./device-command-worker.js";
import { SqliteDeviceCommandStore } from "./sqlite-device-command-store.js";
import { createDeviceControllerServices } from "../device-controllers/index.js";

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
    const controllerServices = createDeviceControllerServices({
        eventStore,
        deviceCommandStore,
        config,
        clock,
        transport: deviceAdapter,
        ...(idGenerator ? { idGenerator } : {}),
        ...(adapterSleep ? { controllerSleep: adapterSleep } : {})
    });
    const deviceTransport = controllerServices.deviceTransport;
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
        deviceTransport,
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
    controllerServices.controllerService.setWorker(worker);
    eventEngine.setDeviceCommandService(deviceCommandService);

    if (startWorker) {
        worker.start();
    }

    return {
        deviceCommandStore,
        deviceTransport,
        deviceAdapter: deviceTransport,
        ...controllerServices,
        acknowledgementService,
        deviceCommandService,
        worker
    };
}
