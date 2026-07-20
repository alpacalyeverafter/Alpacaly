import { DeviceControllerService } from "./device-controller-service.js";
import { InProcessDeviceTransport } from "./in-process-device-transport.js";
import { SqliteDeviceControllerStore } from "./sqlite-device-controller-store.js";
import { MqttDeviceTransport } from "../mqtt/mqtt-device-transport.js";
import { SimulatedMqttController } from "../mqtt/simulated-mqtt-controller.js";
import { createMqttSecurityContext } from "../mqtt/security-context.js";

export function createDeviceControllerServices({
    eventStore,
    deviceCommandStore,
    config,
    clock = () => new Date(),
    idGenerator,
    controllerSleep,
    logger,
    mqttConnect,
    transport = null,
    recoverySafetyService = null
}) {
    const store = new SqliteDeviceControllerStore({
        eventStore,
        deviceCommandStore,
        clock,
        heartbeatTimeoutMs: config.deviceTransport === "mqtt"
            ? config.mqttStaleThresholdMs
            : config.simulatedControllerHeartbeatTimeoutMs,
        offlineTimeoutMs: config.deviceTransport === "mqtt"
            ? config.mqttOfflineThresholdMs
            : Number.MAX_SAFE_INTEGER,
        authorityLeaseMs: config.mqttAuthorityLeaseMs || 30_000,
        ...(idGenerator ? { idGenerator } : {})
    });
    let deviceTransport = transport;
    if (!deviceTransport && config.deviceTransport === "mqtt") {
        const security = createMqttSecurityContext(config);
        deviceTransport = new MqttDeviceTransport({
            store,
            deviceCommandStore,
            config,
            logger,
            security,
            clock,
            ...(idGenerator ? { idGenerator } : {}),
            ...(mqttConnect ? { connect: mqttConnect } : {}),
            ...(config.nodeEnv !== "production"
                && config.enableSimulatedControllerConfiguration
                ? {
                    simulatedControllerFactory: controllerId => (
                        new SimulatedMqttController({
                            controllerId,
                            store,
                            deviceCommandStore,
                            config,
                            security,
                            logger,
                            clock,
                            ...(idGenerator ? { idGenerator } : {}),
                            ...(controllerSleep ? { sleep: controllerSleep } : {}),
                            ...(mqttConnect ? { connect: mqttConnect } : {})
                        })
                    )
                } : {})
        });
    }
    deviceTransport ||= new InProcessDeviceTransport({
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
        clock,
        recoverySafetyService
    });
    return {
        controllerStore: store,
        controllerService,
        deviceTransport
    };
}
