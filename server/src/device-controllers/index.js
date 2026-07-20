import { DeviceControllerService } from "./device-controller-service.js";
import { InProcessDeviceTransport } from "./in-process-device-transport.js";
import { SqliteDeviceControllerStore } from "./sqlite-device-controller-store.js";

export function createDeviceControllerServices({
    eventStore,
    deviceCommandStore,
    config,
    clock = () => new Date(),
    idGenerator,
    controllerSleep,
    transport = null
}) {
    const store = new SqliteDeviceControllerStore({
        eventStore,
        deviceCommandStore,
        clock,
        heartbeatTimeoutMs: config.simulatedControllerHeartbeatTimeoutMs,
        ...(idGenerator ? { idGenerator } : {})
    });
    const deviceTransport = transport || new InProcessDeviceTransport({
        store,
        deviceCommandStore,
        clock,
        heartbeatIntervalMs: config.simulatedControllerHeartbeatIntervalMs,
        ...(controllerSleep ? { controllerSleep } : {})
    });
    const controllerService = new DeviceControllerService({
        store,
        transport: deviceTransport,
        config,
        clock
    });
    return {
        controllerStore: store,
        controllerService,
        deviceTransport
    };
}
