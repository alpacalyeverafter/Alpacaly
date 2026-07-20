import { resolve } from "node:path";

import { DEFAULT_SIMULATED_CONTROLLER_ID } from "../domain/device-controllers.js";
import { DEFAULT_RESOURCE_IDS } from "../domain/resources.js";

function text(value, fallback, name) {
    const normalized = String(value ?? fallback ?? "").trim();
    if (!normalized) {
        throw new Error(`${name} is required.`);
    }
    return normalized;
}

function integer(value, fallback, name, minimum = 0) {
    const parsed = value === undefined || value === "" ? fallback : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        throw new Error(`${name} must be an integer of at least ${minimum}.`);
    }
    return parsed;
}

function boolean(value, fallback, name) {
    if (value === undefined || value === "") return fallback;
    if (String(value).toLowerCase() === "true") return true;
    if (String(value).toLowerCase() === "false") return false;
    throw new Error(`${name} must be true or false.`);
}

function jsonObject(value, fallback, name) {
    if (value === undefined || value === "") return fallback;
    let parsed;
    try {
        parsed = JSON.parse(String(value));
    } catch {
        throw new Error(`${name} must be valid JSON.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${name} must be a JSON object.`);
    }
    return parsed;
}

function path(value, fallback, name) {
    const selected = text(value, fallback, name);
    return selected === ":memory:" ? selected : resolve(selected);
}

export function loadEdgeConfig(env = process.env) {
    const mode = text(env.EDGE_MODE, env.NODE_ENV || "development", "EDGE_MODE")
        .toLowerCase();
    if (!["development", "test", "production"].includes(mode)) {
        throw new Error("EDGE_MODE must be development, test or production.");
    }
    const simulatedHardware = boolean(
        env.EDGE_SIMULATED_HARDWARE,
        mode !== "production",
        "EDGE_SIMULATED_HARDWARE"
    );
    const developmentIdentity = boolean(
        env.EDGE_DEVELOPMENT_IDENTITY,
        mode !== "production",
        "EDGE_DEVELOPMENT_IDENTITY"
    );
    const developmentKeys = boolean(
        env.MQTT_DEVELOPMENT_KEYS,
        mode !== "production",
        "MQTT_DEVELOPMENT_KEYS"
    );
    const brokerUrl = text(env.MQTT_BROKER_URL, "mqtt://127.0.0.1:1883", "MQTT_BROKER_URL");
    const protocolVersion = integer(env.MQTT_PROTOCOL_VERSION, 5, "MQTT_PROTOCOL_VERSION", 4);
    const barnTimezone = text(
        env.EDGE_BARN_TIMEZONE,
        "Europe/London",
        "EDGE_BARN_TIMEZONE"
    );
    try {
        new Intl.DateTimeFormat("en-GB", { timeZone: barnTimezone }).format(new Date());
    } catch {
        throw new Error("EDGE_BARN_TIMEZONE must be a supported IANA timezone.");
    }
    const config = {
        mode,
        serviceName: "alpacaly-barn-edge-controller",
        controllerId: text(
            env.EDGE_CONTROLLER_ID,
            DEFAULT_SIMULATED_CONTROLLER_ID,
            "EDGE_CONTROLLER_ID"
        ),
        barnId: text(env.EDGE_BARN_ID, DEFAULT_RESOURCE_IDS.barnId, "EDGE_BARN_ID"),
        barnTimezone,
        feederIds: text(
            env.EDGE_FEEDER_IDS,
            DEFAULT_RESOURCE_IDS.feederId,
            "EDGE_FEEDER_IDS"
        ).split(",").map(item => item.trim()).filter(Boolean),
        databasePath: path(
            env.EDGE_DATABASE_PATH,
            "./data/barn-edge.sqlite",
            "EDGE_DATABASE_PATH"
        ),
        simulatedHardware,
        developmentIdentity,
        bootstrapSimulatedFixtures: boolean(
            env.EDGE_BOOTSTRAP_SIMULATED_FIXTURES,
            false,
            "EDGE_BOOTSTRAP_SIMULATED_FIXTURES"
        ),
        mqttDevelopmentKeys: developmentKeys,
        mqttEnvironment: text(
            env.MQTT_ENVIRONMENT,
            mode === "production" ? "production" : mode,
            "MQTT_ENVIRONMENT"
        ).toLowerCase(),
        mqttProtocolVersion: protocolVersion,
        mqttBrokerUrl: brokerUrl,
        mqttClientId: text(
            env.EDGE_MQTT_CLIENT_ID,
            `alpacaly-edge-${env.EDGE_CONTROLLER_ID || DEFAULT_SIMULATED_CONTROLLER_ID}`,
            "EDGE_MQTT_CLIENT_ID"
        ),
        mqttConnectTimeoutMs: integer(
            env.MQTT_CONNECT_TIMEOUT_MS, 5000, "MQTT_CONNECT_TIMEOUT_MS", 100
        ),
        mqttReconnectPeriodMs: integer(
            env.MQTT_RECONNECT_PERIOD_MS, 1000, "MQTT_RECONNECT_PERIOD_MS", 0
        ),
        mqttHeartbeatIntervalMs: integer(
            env.MQTT_HEARTBEAT_INTERVAL_MS, 5000, "MQTT_HEARTBEAT_INTERVAL_MS", 10
        ),
        mqttStaleThresholdMs: integer(
            env.MQTT_STALE_THRESHOLD_MS, 15000, "MQTT_STALE_THRESHOLD_MS", 10
        ),
        mqttOfflineThresholdMs: integer(
            env.MQTT_OFFLINE_THRESHOLD_MS, 30000, "MQTT_OFFLINE_THRESHOLD_MS", 10
        ),
        mqttClockDriftToleranceMs: integer(
            env.MQTT_CLOCK_DRIFT_TOLERANCE_MS, 2000,
            "MQTT_CLOCK_DRIFT_TOLERANCE_MS", 0
        ),
        mqttTlsCaPath: env.MQTT_TLS_CA_PATH || null,
        mqttTlsCertificatePath: env.MQTT_TLS_CERTIFICATE_PATH || null,
        mqttTlsPrivateKeyPath: env.MQTT_TLS_PRIVATE_KEY_PATH || null,
        mqttServerSigningPublicKeys: jsonObject(
            env.MQTT_SERVER_SIGNING_PUBLIC_KEYS, {}, "MQTT_SERVER_SIGNING_PUBLIC_KEYS"
        ),
        mqttControllerSigningKeyId: env.MQTT_CONTROLLER_SIGNING_KEY_ID || null,
        mqttControllerSigningPrivateKey: env.MQTT_CONTROLLER_SIGNING_PRIVATE_KEY || null,
        bellDurationMs: integer(env.EDGE_BELL_DURATION_MS, 3000, "EDGE_BELL_DURATION_MS"),
        countdownDurationMs: integer(
            env.EDGE_COUNTDOWN_DURATION_MS, 10000, "EDGE_COUNTDOWN_DURATION_MS"
        ),
        watchdogPulseMs: integer(
            env.EDGE_WATCHDOG_PULSE_MS, 100, "EDGE_WATCHDOG_PULSE_MS", 1
        ),
        maintenanceMaximumJogMs: integer(
            env.EDGE_MAINTENANCE_MAXIMUM_JOG_MS,
            500,
            "EDGE_MAINTENANCE_MAXIMUM_JOG_MS",
            1
        ),
        bellFailurePolicy: text(
            env.EDGE_BELL_FAILURE_POLICY,
            "CANCEL",
            "EDGE_BELL_FAILURE_POLICY"
        ).toUpperCase()
    };
    if (!["CANCEL", "CONTINUE"].includes(config.bellFailurePolicy)) {
        throw new Error("EDGE_BELL_FAILURE_POLICY must be CANCEL or CONTINUE.");
    }
    if (config.feederIds.length === 0 || new Set(config.feederIds).size !== config.feederIds.length) {
        throw new Error("EDGE_FEEDER_IDS must contain unique feeder identities.");
    }
    if (mode === "production") {
        const missing = [
            ["MQTT_TLS_CA_PATH", config.mqttTlsCaPath],
            ["MQTT_TLS_CERTIFICATE_PATH", config.mqttTlsCertificatePath],
            ["MQTT_TLS_PRIVATE_KEY_PATH", config.mqttTlsPrivateKeyPath],
            ["MQTT_CONTROLLER_SIGNING_KEY_ID", config.mqttControllerSigningKeyId],
            ["MQTT_CONTROLLER_SIGNING_PRIVATE_KEY", config.mqttControllerSigningPrivateKey]
        ].filter(([, value]) => !value).map(([name]) => name);
        if (missing.length) {
            throw new Error(`Production edge security settings are missing: ${missing.join(", ")}.`);
        }
        if (protocolVersion !== 5 || !brokerUrl.startsWith("mqtts://")) {
            throw new Error("Production edge mode requires MQTT 5 over mqtts://.");
        }
        if (simulatedHardware) {
            throw new Error("Production edge mode rejects the simulated hardware adapter.");
        }
        if (config.bootstrapSimulatedFixtures) {
            throw new Error("Production edge mode rejects simulated bootstrap fixtures.");
        }
        if (developmentIdentity || developmentKeys
            || String(config.mqttControllerSigningKeyId).includes("development")) {
            throw new Error("Production edge mode rejects development identities and keys.");
        }
        if (Object.keys(config.mqttServerSigningPublicKeys).length === 0) {
            throw new Error("Production edge mode requires server signing public keys.");
        }
    }
    return Object.freeze(config);
}

export const DEFAULT_EDGE_WELFARE_CONFIGURATION = Object.freeze({
    version: "edge-welfare-v1",
    maximumMotorDurationMs: 2000,
    minimumIntervalMs: 0,
    rollingPeriodMs: 60 * 60 * 1000,
    maximumCyclesPerRollingPeriod: 20,
    maximumCyclesPerSession: 10,
    maximumQuantityPerSession: 20,
    maximumConsecutiveFailures: 3,
    maximumSensorDisagreements: 2,
    permittedWindows: [{ start: "00:00", end: "23:59" }],
    maximumConfigurationAgeMs: 24 * 60 * 60 * 1000,
    cooldownAfterFailureMs: 1000,
    maximumBellRepetitions: 1,
    maximumCountdownAttempts: 1,
    quantityTolerance: 0.25
});
