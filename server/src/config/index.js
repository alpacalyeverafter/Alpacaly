import dotenv from "dotenv";
import { resolve } from "node:path";

import { DEFAULTS } from "./defaults.js";

function parseInteger(value, fallback, name, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
    if (value === undefined || value === "") {
        return fallback;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }

    return parsed;
}

function parseBoolean(value, fallback, name) {
    if (value === undefined || value === "") {
        return fallback;
    }

    const normalized = String(value).trim().toLowerCase();
    if (normalized === "true") {
        return true;
    }

    if (normalized === "false") {
        return false;
    }

    throw new Error(`${name} must be either true or false.`);
}

function parseTime(value, fallback, name) {
    const candidate = String(value || fallback);
    const match = /^(\d{2}):(\d{2})$/.exec(candidate);

    if (!match) {
        throw new Error(`${name} must use 24-hour HH:MM format.`);
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) {
        throw new Error(`${name} must be a valid 24-hour time.`);
    }

    return candidate;
}

function parseDatabasePath(value) {
    const candidate = value === undefined
        ? DEFAULTS.databasePath
        : String(value).trim();
    if (!candidate) {
        throw new Error("DATABASE_PATH must not be empty.");
    }

    return candidate === ":memory:" ? candidate : resolve(candidate);
}

function parseChoice(value, fallback, name, choices) {
    const normalized = String(value || fallback).trim().toLowerCase();
    if (!choices.includes(normalized)) {
        throw new Error(`${name} must be one of: ${choices.join(", ")}.`);
    }
    return normalized;
}

function optionalString(value) {
    const normalized = value === undefined || value === null
        ? "" : String(value).trim();
    return normalized || null;
}

function parseJsonObject(value, fallback, name) {
    if (value === undefined || value === "") {
        return fallback;
    }
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

export function loadConfig(env = process.env, { loadEnvFile = true } = {}) {
    if (loadEnvFile) {
        dotenv.config({ quiet: true });
    }

    const nodeEnv = String(env.NODE_ENV || DEFAULTS.nodeEnv);
    const requestBodyLimit = String(env.REQUEST_BODY_LIMIT || DEFAULTS.requestBodyLimit).trim();
    if (!requestBodyLimit) {
        throw new Error("REQUEST_BODY_LIMIT must not be empty.");
    }

    const corsOrigin = String(env.CORS_ORIGIN || DEFAULTS.corsOrigin).trim();
    if (!corsOrigin) {
        throw new Error("CORS_ORIGIN must not be empty.");
    }

    const deviceTransport = parseChoice(
        env.DEVICE_TRANSPORT,
        DEFAULTS.deviceTransport,
        "DEVICE_TRANSPORT",
        ["in_process", "mqtt"]
    );
    const mqttProtocolVersion = parseInteger(
        env.MQTT_PROTOCOL_VERSION,
        DEFAULTS.mqttProtocolVersion,
        "MQTT_PROTOCOL_VERSION",
        { minimum: 4, maximum: 5 }
    );
    const mqttDevelopmentKeysRequested = parseBoolean(
        env.MQTT_DEVELOPMENT_KEYS,
        true,
        "MQTT_DEVELOPMENT_KEYS"
    );
    const mqtt = {
        mqttEnvironment: String(
            env.MQTT_ENVIRONMENT || (nodeEnv === "production" ? "production" : nodeEnv)
        ).trim().toLowerCase(),
        mqttProtocolVersion,
        mqttCommandQos: parseInteger(
            env.MQTT_COMMAND_QOS,
            DEFAULTS.mqttCommandQos,
            "MQTT_COMMAND_QOS",
            { minimum: 0, maximum: 2 }
        ),
        mqttBrokerUrl: optionalString(env.MQTT_BROKER_URL),
        mqttClientId: String(env.MQTT_CLIENT_ID || DEFAULTS.mqttClientId).trim(),
        mqttConnectTimeoutMs: parseInteger(
            env.MQTT_CONNECT_TIMEOUT_MS,
            DEFAULTS.mqttConnectTimeoutMs,
            "MQTT_CONNECT_TIMEOUT_MS"
        ),
        mqttReconnectPeriodMs: parseInteger(
            env.MQTT_RECONNECT_PERIOD_MS,
            DEFAULTS.mqttReconnectPeriodMs,
            "MQTT_RECONNECT_PERIOD_MS",
            { minimum: 0 }
        ),
        mqttCommandExpiryMs: parseInteger(
            env.MQTT_COMMAND_EXPIRY_MS,
            DEFAULTS.mqttCommandExpiryMs,
            "MQTT_COMMAND_EXPIRY_MS",
            { minimum: 100 }
        ),
        mqttAuthorityLeaseMs: parseInteger(
            env.MQTT_AUTHORITY_LEASE_MS,
            DEFAULTS.mqttAuthorityLeaseMs,
            "MQTT_AUTHORITY_LEASE_MS",
            { minimum: 100 }
        ),
        mqttHeartbeatIntervalMs: parseInteger(
            env.MQTT_HEARTBEAT_INTERVAL_MS,
            DEFAULTS.mqttHeartbeatIntervalMs,
            "MQTT_HEARTBEAT_INTERVAL_MS",
            { minimum: 10 }
        ),
        mqttStaleThresholdMs: parseInteger(
            env.MQTT_STALE_THRESHOLD_MS,
            DEFAULTS.mqttStaleThresholdMs,
            "MQTT_STALE_THRESHOLD_MS",
            { minimum: 10 }
        ),
        mqttOfflineThresholdMs: parseInteger(
            env.MQTT_OFFLINE_THRESHOLD_MS,
            DEFAULTS.mqttOfflineThresholdMs,
            "MQTT_OFFLINE_THRESHOLD_MS",
            { minimum: 10 }
        ),
        mqttClockDriftToleranceMs: parseInteger(
            env.MQTT_CLOCK_DRIFT_TOLERANCE_MS,
            DEFAULTS.mqttClockDriftToleranceMs,
            "MQTT_CLOCK_DRIFT_TOLERANCE_MS",
            { minimum: 0 }
        ),
        mqttTlsCaPath: optionalString(env.MQTT_TLS_CA_PATH),
        mqttTlsCertificatePath: optionalString(env.MQTT_TLS_CERTIFICATE_PATH),
        mqttTlsPrivateKeyPath: optionalString(env.MQTT_TLS_PRIVATE_KEY_PATH),
        mqttServerSigningKeyId: String(
            env.MQTT_SERVER_SIGNING_KEY_ID || DEFAULTS.mqttServerSigningKeyId
        ).trim(),
        mqttServerSigningPrivateKey: optionalString(
            env.MQTT_SERVER_SIGNING_PRIVATE_KEY
        ),
        mqttServerSigningPublicKeys: parseJsonObject(
            env.MQTT_SERVER_SIGNING_PUBLIC_KEYS,
            {},
            "MQTT_SERVER_SIGNING_PUBLIC_KEYS"
        ),
        mqttControllerSigningKeyId: String(
            env.MQTT_CONTROLLER_SIGNING_KEY_ID
                || DEFAULTS.mqttControllerSigningKeyId
        ).trim(),
        mqttControllerSigningPrivateKey: optionalString(
            env.MQTT_CONTROLLER_SIGNING_PRIVATE_KEY
        ),
        mqttControllerSigningPublicKeys: parseJsonObject(
            env.MQTT_CONTROLLER_SIGNING_PUBLIC_KEYS,
            {},
            "MQTT_CONTROLLER_SIGNING_PUBLIC_KEYS"
        ),
        mqttDevelopmentKeys: nodeEnv !== "production"
            && mqttDevelopmentKeysRequested
    };

    if (deviceTransport === "mqtt") {
        if (!mqtt.mqttBrokerUrl) {
            throw new Error("MQTT_BROKER_URL is required for the MQTT transport.");
        }
        if (nodeEnv === "production") {
            if (mqttProtocolVersion !== 5) {
                throw new Error("Production MQTT transport requires MQTT 5.");
            }
            if (!mqtt.mqttBrokerUrl.startsWith("mqtts://")) {
                throw new Error("Production MQTT transport requires an mqtts:// broker URL.");
            }
            const missingSecurity = [
                ["MQTT_TLS_CA_PATH", mqtt.mqttTlsCaPath],
                ["MQTT_TLS_CERTIFICATE_PATH", mqtt.mqttTlsCertificatePath],
                ["MQTT_TLS_PRIVATE_KEY_PATH", mqtt.mqttTlsPrivateKeyPath],
                ["MQTT_SERVER_SIGNING_PRIVATE_KEY", mqtt.mqttServerSigningPrivateKey],
                ["MQTT_SERVER_SIGNING_KEY_ID", optionalString(
                    env.MQTT_SERVER_SIGNING_KEY_ID
                )]
            ].filter(([, value]) => !value).map(([name]) => name);
            if (missingSecurity.length > 0) {
                throw new Error(
                    `Production MQTT security settings are missing: ${missingSecurity.join(", ")}.`
                );
            }
            if (Object.keys(mqtt.mqttControllerSigningPublicKeys).length === 0) {
                throw new Error(
                    "MQTT_CONTROLLER_SIGNING_PUBLIC_KEYS is required in production."
                );
            }
            if (
                mqttDevelopmentKeysRequested
                || mqtt.mqttServerSigningKeyId.startsWith("alpacaly-development-")
            ) {
                throw new Error("Production MQTT transport rejects development signing keys.");
            }
            if (mqtt.mqttControllerSigningPrivateKey) {
                throw new Error(
                    "Production servers must not be configured with controller private keys."
                );
            }
        }
    }

    return Object.freeze({
        serviceName: DEFAULTS.serviceName,
        nodeEnv,
        port: parseInteger(env.PORT, DEFAULTS.port, "PORT", { maximum: 65535 }),
        logLevel: String(env.LOG_LEVEL || DEFAULTS.logLevel),
        maxDailyFeeds: parseInteger(env.MAX_DAILY_FEEDS, DEFAULTS.maxDailyFeeds, "MAX_DAILY_FEEDS"),
        enforceFeedingWindow: parseBoolean(
            env.ENFORCE_FEEDING_WINDOW,
            DEFAULTS.enforceFeedingWindow,
            "ENFORCE_FEEDING_WINDOW"
        ),
        feedingWindowStart: parseTime(
            env.FEEDING_WINDOW_START,
            DEFAULTS.feedingWindowStart,
            "FEEDING_WINDOW_START"
        ),
        feedingWindowEnd: parseTime(
            env.FEEDING_WINDOW_END,
            DEFAULTS.feedingWindowEnd,
            "FEEDING_WINDOW_END"
        ),
        requestBodyLimit,
        corsOrigin,
        databasePath: parseDatabasePath(env.DATABASE_PATH),
        enableDemoReset: parseBoolean(
            env.ENABLE_DEMO_RESET,
            nodeEnv !== "production",
            "ENABLE_DEMO_RESET"
        ),
        enableDevelopmentContributionSimulation: nodeEnv !== "production"
            && parseBoolean(
                env.ENABLE_DEVELOPMENT_CONTRIBUTION_SIMULATION,
                true,
                "ENABLE_DEVELOPMENT_CONTRIBUTION_SIMULATION"
            ),
        enableDevelopmentAuthentication: nodeEnv !== "production"
            && parseBoolean(
                env.ENABLE_DEVELOPMENT_AUTHENTICATION,
                DEFAULTS.enableDevelopmentAuthentication,
                "ENABLE_DEVELOPMENT_AUTHENTICATION"
            ),
        managedIdentityProviderConfigured: parseBoolean(
            env.MANAGED_IDENTITY_PROVIDER_CONFIGURED,
            DEFAULTS.managedIdentityProviderConfigured,
            "MANAGED_IDENTITY_PROVIDER_CONFIGURED"
        ),
        criticalApprovalLifetimeMs: parseInteger(
            env.CRITICAL_APPROVAL_LIFETIME_MS,
            DEFAULTS.criticalApprovalLifetimeMs,
            "CRITICAL_APPROVAL_LIFETIME_MS",
            { minimum: 60_000, maximum: 60 * 60 * 1000 }
        ),
        outboxPollIntervalMs: parseInteger(
            env.OUTBOX_POLL_INTERVAL_MS,
            DEFAULTS.outboxPollIntervalMs,
            "OUTBOX_POLL_INTERVAL_MS",
            { minimum: 10 }
        ),
        outboxRetryDelayMs: parseInteger(
            env.OUTBOX_RETRY_DELAY_MS,
            DEFAULTS.outboxRetryDelayMs,
            "OUTBOX_RETRY_DELAY_MS",
            { minimum: 0 }
        ),
        deviceCommandPollIntervalMs: parseInteger(
            env.DEVICE_COMMAND_POLL_INTERVAL_MS,
            DEFAULTS.deviceCommandPollIntervalMs,
            "DEVICE_COMMAND_POLL_INTERVAL_MS",
            { minimum: 10 }
        ),
        deviceCommandRetryDelayMs: parseInteger(
            env.DEVICE_COMMAND_RETRY_DELAY_MS,
            DEFAULTS.deviceCommandRetryDelayMs,
            "DEVICE_COMMAND_RETRY_DELAY_MS",
            { minimum: 0 }
        ),
        deviceCommandMaximumAttempts: parseInteger(
            env.DEVICE_COMMAND_MAXIMUM_ATTEMPTS,
            DEFAULTS.deviceCommandMaximumAttempts,
            "DEVICE_COMMAND_MAXIMUM_ATTEMPTS",
            { minimum: 1, maximum: 100 }
        ),
        deviceAcknowledgementTimeoutMs: parseInteger(
            env.DEVICE_ACKNOWLEDGEMENT_TIMEOUT_MS,
            DEFAULTS.deviceAcknowledgementTimeoutMs,
            "DEVICE_ACKNOWLEDGEMENT_TIMEOUT_MS",
            { minimum: 0 }
        ),
        deviceTransport,
        ...mqtt,
        simulatedControllerHeartbeatIntervalMs: parseInteger(
            env.SIMULATED_CONTROLLER_HEARTBEAT_INTERVAL_MS,
            DEFAULTS.simulatedControllerHeartbeatIntervalMs,
            "SIMULATED_CONTROLLER_HEARTBEAT_INTERVAL_MS",
            { minimum: 10 }
        ),
        simulatedControllerHeartbeatTimeoutMs: parseInteger(
            env.SIMULATED_CONTROLLER_HEARTBEAT_TIMEOUT_MS,
            DEFAULTS.simulatedControllerHeartbeatTimeoutMs,
            "SIMULATED_CONTROLLER_HEARTBEAT_TIMEOUT_MS",
            { minimum: 10 }
        ),
        enableSimulatedControllerConfiguration: nodeEnv !== "production"
            && parseBoolean(
                env.ENABLE_SIMULATED_CONTROLLER_CONFIGURATION,
                DEFAULTS.enableSimulatedControllerConfiguration,
                "ENABLE_SIMULATED_CONTROLLER_CONFIGURATION"
            ),
        edgeCalibrationVersion: String(
            env.EDGE_CALIBRATION_VERSION || DEFAULTS.edgeCalibrationVersion
        ).trim(),
        edgeWelfareConfigurationVersion: String(
            env.EDGE_WELFARE_CONFIGURATION_VERSION
                || DEFAULTS.edgeWelfareConfigurationVersion
        ).trim(),
        lifecycleCountdownMs: parseInteger(
            env.LIFECYCLE_COUNTDOWN_MS,
            DEFAULTS.lifecycleCountdownMs,
            "LIFECYCLE_COUNTDOWN_MS",
            { minimum: 0 }
        ),
        lifecycleBellMs: parseInteger(
            env.LIFECYCLE_BELL_MS,
            DEFAULTS.lifecycleBellMs,
            "LIFECYCLE_BELL_MS",
            { minimum: 0 }
        ),
        lifecycleDispensingMs: parseInteger(
            env.LIFECYCLE_DISPENSING_MS,
            DEFAULTS.lifecycleDispensingMs,
            "LIFECYCLE_DISPENSING_MS",
            { minimum: 0 }
        ),
        lifecycleArchiveDelayMs: parseInteger(
            env.LIFECYCLE_ARCHIVE_DELAY_MS,
            DEFAULTS.lifecycleArchiveDelayMs,
            "LIFECYCLE_ARCHIVE_DELAY_MS",
            { minimum: 0 }
        )
    });
}
