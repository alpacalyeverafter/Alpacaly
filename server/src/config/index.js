import dotenv from "dotenv";
import { isAbsolute, resolve } from "node:path";

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

function parseHttpUrl(value, fallback, name) {
    const candidate = String(value || fallback).trim();
    let parsed;
    try {
        parsed = new URL(candidate);
    } catch {
        throw new Error(`${name} must be a valid HTTP or HTTPS URL.`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error(`${name} must use http:// or https://.`);
    }
    if (parsed.username || parsed.password || parsed.hash) {
        throw new Error(`${name} must not contain credentials or a fragment.`);
    }
    return parsed.toString().replace(/\/$/, "");
}

function isLoopbackUrl(value) {
    const hostname = new URL(value).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}

function optionalAbsolutePath(value, name) {
    const normalized = optionalString(value);
    if (!normalized) {
        return null;
    }
    if (!isAbsolute(normalized)) {
        throw new Error(`${name} must be an absolute path.`);
    }
    return resolve(normalized);
}

function parsePostgresUrl(value, { production }) {
    const candidate = optionalString(value);
    if (!candidate) {
        return null;
    }
    let parsed;
    try {
        parsed = new URL(candidate);
    } catch {
        throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
    }
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
        throw new Error("DATABASE_URL must use the postgres:// or postgresql:// scheme.");
    }
    if (production) {
        const developmentMarker = /(^|[-_.])(dev(elopment)?|test|local)([-_.]|$)/i;
        if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
            throw new Error("Production PostgreSQL cannot use a loopback host.");
        }
        if (developmentMarker.test(decodeURIComponent(parsed.username || ""))
            || developmentMarker.test(decodeURIComponent(parsed.pathname.slice(1)))) {
            throw new Error("Production PostgreSQL rejects development database credentials.");
        }
    }
    return candidate;
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
    const stripeTestSecretKey = optionalString(env.STRIPE_TEST_SECRET_KEY);
    const stripeTestWebhookSecret = optionalString(env.STRIPE_TEST_WEBHOOK_SECRET);
    if (stripeTestSecretKey && !stripeTestSecretKey.startsWith("sk_test_")) {
        throw new Error("STRIPE_TEST_SECRET_KEY must be a Stripe test-mode key.");
    }
    if (
        stripeTestWebhookSecret
        && !stripeTestWebhookSecret.startsWith("whsec_")
    ) {
        throw new Error("STRIPE_TEST_WEBHOOK_SECRET must be a Stripe webhook secret.");
    }
    const paymentDonationCurrency = String(
        env.PAYMENT_DONATION_CURRENCY || DEFAULTS.paymentDonationCurrency
    ).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(paymentDonationCurrency)) {
        throw new Error("PAYMENT_DONATION_CURRENCY must be a three-letter code.");
    }

    const centralDatabaseType = parseChoice(
        env.CENTRAL_DATABASE_TYPE,
        DEFAULTS.centralDatabaseType,
        "CENTRAL_DATABASE_TYPE",
        ["sqlite", "postgres"]
    );
    if (nodeEnv === "production" && centralDatabaseType !== "postgres") {
        throw new Error("Production requires CENTRAL_DATABASE_TYPE=postgres.");
    }
    const postgresUrl = parsePostgresUrl(env.DATABASE_URL, {
        production: nodeEnv === "production"
    });
    if (centralDatabaseType === "postgres" && !postgresUrl) {
        throw new Error("DATABASE_URL is required when CENTRAL_DATABASE_TYPE=postgres.");
    }
    const postgresSslMode = parseChoice(
        env.POSTGRES_SSL_MODE,
        nodeEnv === "production" ? "verify-full" : DEFAULTS.postgresSslMode,
        "POSTGRES_SSL_MODE",
        ["disable", "require", "verify-full"]
    );
    if (nodeEnv === "production" && postgresSslMode !== "verify-full") {
        throw new Error("Production PostgreSQL requires POSTGRES_SSL_MODE=verify-full.");
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

    const config = Object.freeze({
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
        paymentSandboxEnabled: nodeEnv !== "production"
            && parseBoolean(
                env.ENABLE_PAYMENT_SANDBOX,
                DEFAULTS.paymentSandboxEnabled,
                "ENABLE_PAYMENT_SANDBOX"
            ),
        paymentDonationAmountMinor: parseInteger(
            env.PAYMENT_DONATION_AMOUNT_MINOR,
            DEFAULTS.paymentDonationAmountMinor,
            "PAYMENT_DONATION_AMOUNT_MINOR",
            { minimum: 1, maximum: 1_000_000 }
        ),
        paymentDonationCurrency,
        paymentPublicBaseUrl: parseHttpUrl(
            env.PAYMENT_PUBLIC_BASE_URL,
            DEFAULTS.paymentPublicBaseUrl,
            "PAYMENT_PUBLIC_BASE_URL"
        ),
        paymentProviderTimeoutMs: parseInteger(
            env.PAYMENT_PROVIDER_TIMEOUT_MS,
            DEFAULTS.paymentProviderTimeoutMs,
            "PAYMENT_PROVIDER_TIMEOUT_MS",
            { minimum: 100, maximum: 120_000 }
        ),
        paymentWebhookToleranceSeconds: parseInteger(
            env.PAYMENT_WEBHOOK_TOLERANCE_SECONDS,
            DEFAULTS.paymentWebhookToleranceSeconds,
            "PAYMENT_WEBHOOK_TOLERANCE_SECONDS",
            { minimum: 1, maximum: 900 }
        ),
        paymentWebhookBodyLimit: String(
            env.PAYMENT_WEBHOOK_BODY_LIMIT || DEFAULTS.paymentWebhookBodyLimit
        ).trim(),
        feedCreditReservationLifetimeMs: parseInteger(
            env.FEED_CREDIT_RESERVATION_LIFETIME_MS,
            DEFAULTS.feedCreditReservationLifetimeMs,
            "FEED_CREDIT_RESERVATION_LIFETIME_MS",
            { minimum: 10_000, maximum: 24 * 60 * 60_000 }
        ),
        feedCreditConfirmationTimeoutMs: parseInteger(
            env.FEED_CREDIT_CONFIRMATION_TIMEOUT_MS,
            DEFAULTS.feedCreditConfirmationTimeoutMs,
            "FEED_CREDIT_CONFIRMATION_TIMEOUT_MS",
            { minimum: 5_000, maximum: 10 * 60_000 }
        ),
        feedCreditPresenceTtlMs: parseInteger(
            env.FEED_CREDIT_PRESENCE_TTL_MS,
            DEFAULTS.feedCreditPresenceTtlMs,
            "FEED_CREDIT_PRESENCE_TTL_MS",
            { minimum: 1_000, maximum: 60_000 }
        ),
        feedCreditReconciliationIntervalMs: parseInteger(
            env.FEED_CREDIT_RECONCILIATION_INTERVAL_MS,
            DEFAULTS.feedCreditReconciliationIntervalMs,
            "FEED_CREDIT_RECONCILIATION_INTERVAL_MS",
            { minimum: 100, maximum: 60_000 }
        ),
        stripeTestSecretKey,
        stripeTestWebhookSecret,
        centralDatabaseType,
        databasePath: parseDatabasePath(env.DATABASE_PATH),
        postgresUrl,
        postgresSslMode,
        postgresTlsCaPath: optionalString(env.POSTGRES_TLS_CA_PATH),
        postgresPoolMinimum: parseInteger(
            env.POSTGRES_POOL_MINIMUM,
            DEFAULTS.postgresPoolMinimum,
            "POSTGRES_POOL_MINIMUM",
            { minimum: 0, maximum: 100 }
        ),
        postgresPoolMaximum: parseInteger(
            env.POSTGRES_POOL_MAXIMUM,
            DEFAULTS.postgresPoolMaximum,
            "POSTGRES_POOL_MAXIMUM",
            { minimum: 1, maximum: 200 }
        ),
        postgresConnectionTimeoutMs: parseInteger(
            env.POSTGRES_CONNECTION_TIMEOUT_MS,
            DEFAULTS.postgresConnectionTimeoutMs,
            "POSTGRES_CONNECTION_TIMEOUT_MS",
            { minimum: 100, maximum: 120_000 }
        ),
        postgresStatementTimeoutMs: parseInteger(
            env.POSTGRES_STATEMENT_TIMEOUT_MS,
            DEFAULTS.postgresStatementTimeoutMs,
            "POSTGRES_STATEMENT_TIMEOUT_MS",
            { minimum: 100, maximum: 300_000 }
        ),
        postgresLockTimeoutMs: parseInteger(
            env.POSTGRES_LOCK_TIMEOUT_MS,
            DEFAULTS.postgresLockTimeoutMs,
            "POSTGRES_LOCK_TIMEOUT_MS",
            { minimum: 100, maximum: 300_000 }
        ),
        postgresIdleTransactionTimeoutMs: parseInteger(
            env.POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS,
            DEFAULTS.postgresIdleTransactionTimeoutMs,
            "POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS",
            { minimum: 100, maximum: 300_000 }
        ),
        postgresApplicationName: String(
            env.POSTGRES_APPLICATION_NAME || DEFAULTS.postgresApplicationName
        ).trim(),
        recoverySafetyMode: parseBoolean(
            env.RECOVERY_SAFETY_MODE,
            DEFAULTS.recoverySafetyMode,
            "RECOVERY_SAFETY_MODE"
        ),
        backupCatalogueDirectory: optionalAbsolutePath(
            env.BACKUP_CATALOGUE_DIRECTORY,
            "BACKUP_CATALOGUE_DIRECTORY"
        ),
        backupRetentionDailyDays: parseInteger(
            env.BACKUP_RETENTION_DAILY_DAYS,
            DEFAULTS.backupRetentionDailyDays,
            "BACKUP_RETENTION_DAILY_DAYS"
        ),
        backupRetentionWeeklyWeeks: parseInteger(
            env.BACKUP_RETENTION_WEEKLY_WEEKS,
            DEFAULTS.backupRetentionWeeklyWeeks,
            "BACKUP_RETENTION_WEEKLY_WEEKS"
        ),
        backupRetentionMonthlyMonths: parseInteger(
            env.BACKUP_RETENTION_MONTHLY_MONTHS,
            DEFAULTS.backupRetentionMonthlyMonths,
            "BACKUP_RETENTION_MONTHLY_MONTHS"
        ),
        backupMinimumRetentionDays: parseInteger(
            env.BACKUP_MINIMUM_RETENTION_DAYS,
            DEFAULTS.backupMinimumRetentionDays,
            "BACKUP_MINIMUM_RETENTION_DAYS"
        ),
        backupMaximumAgeHours: parseInteger(
            env.BACKUP_MAXIMUM_AGE_HOURS,
            DEFAULTS.backupMaximumAgeHours,
            "BACKUP_MAXIMUM_AGE_HOURS"
        ),
        restoreDrillMaximumAgeDays: parseInteger(
            env.RESTORE_DRILL_MAXIMUM_AGE_DAYS,
            DEFAULTS.restoreDrillMaximumAgeDays,
            "RESTORE_DRILL_MAXIMUM_AGE_DAYS"
        ),
        managedBackupOperationsEnabled: parseBoolean(
            env.MANAGED_BACKUP_OPERATIONS_ENABLED,
            DEFAULTS.managedBackupOperationsEnabled,
            "MANAGED_BACKUP_OPERATIONS_ENABLED"
        ),
        managedBackupEvidenceDirectory: optionalAbsolutePath(
            env.MANAGED_BACKUP_EVIDENCE_DIRECTORY,
            "MANAGED_BACKUP_EVIDENCE_DIRECTORY"
        ),
        managedBackupExpectedEnvironment: parseChoice(
            env.MANAGED_BACKUP_EXPECTED_ENVIRONMENT,
            ["staging", "production"].includes(nodeEnv) ? nodeEnv : "staging",
            "MANAGED_BACKUP_EXPECTED_ENVIRONMENT",
            ["staging", "production"]
        ),
        managedBackupExpectedDatabaseIdentity: optionalString(
            env.MANAGED_BACKUP_EXPECTED_DATABASE_IDENTITY
        ),
        managedBackupExpectedRegion: optionalString(
            env.MANAGED_BACKUP_EXPECTED_REGION
        ),
        managedBackupMaximumEvidenceAgeMinutes: parseInteger(
            env.MANAGED_BACKUP_MAXIMUM_EVIDENCE_AGE_MINUTES,
            DEFAULTS.managedBackupMaximumEvidenceAgeMinutes,
            "MANAGED_BACKUP_MAXIMUM_EVIDENCE_AGE_MINUTES"
        ),
        managedBackupRecoveryPointObjectiveMinutes: parseInteger(
            env.MANAGED_BACKUP_RPO_MINUTES,
            DEFAULTS.managedBackupRecoveryPointObjectiveMinutes,
            "MANAGED_BACKUP_RPO_MINUTES"
        ),
        managedBackupMinimumRetentionDays: parseInteger(
            env.MANAGED_BACKUP_MINIMUM_RETENTION_DAYS,
            DEFAULTS.managedBackupMinimumRetentionDays,
            "MANAGED_BACKUP_MINIMUM_RETENTION_DAYS"
        ),
        workerId: optionalString(env.WORKER_ID),
        workerInstanceId: optionalString(env.WORKER_INSTANCE_ID),
        workerSoftwareVersion: String(env.SOFTWARE_VERSION || "1.0.0").trim(),
        workerLeaseDurationMs: parseInteger(
            env.WORKER_LEASE_DURATION_MS,
            DEFAULTS.workerLeaseDurationMs,
            "WORKER_LEASE_DURATION_MS",
            { minimum: 100, maximum: 60 * 60_000 }
        ),
        workerHeartbeatIntervalMs: parseInteger(
            env.WORKER_HEARTBEAT_INTERVAL_MS,
            DEFAULTS.workerHeartbeatIntervalMs,
            "WORKER_HEARTBEAT_INTERVAL_MS",
            { minimum: 50, maximum: 10 * 60_000 }
        ),
        workerStaleThresholdMs: parseInteger(
            env.WORKER_STALE_THRESHOLD_MS,
            DEFAULTS.workerStaleThresholdMs,
            "WORKER_STALE_THRESHOLD_MS",
            { minimum: 100, maximum: 60 * 60_000 }
        ),
        workerReclaimDelayMs: parseInteger(
            env.WORKER_RECLAIM_DELAY_MS,
            DEFAULTS.workerReclaimDelayMs,
            "WORKER_RECLAIM_DELAY_MS",
            { minimum: 0, maximum: 10 * 60_000 }
        ),
        workerMaximumClaimDurationMs: parseInteger(
            env.WORKER_MAXIMUM_CLAIM_DURATION_MS,
            DEFAULTS.workerMaximumClaimDurationMs,
            "WORKER_MAXIMUM_CLAIM_DURATION_MS",
            { minimum: 100, maximum: 24 * 60 * 60_000 }
        ),
        workerClockSkewToleranceMs: parseInteger(
            env.WORKER_CLOCK_SKEW_TOLERANCE_MS,
            DEFAULTS.workerClockSkewToleranceMs,
            "WORKER_CLOCK_SKEW_TOLERANCE_MS",
            { minimum: 0, maximum: 60_000 }
        ),
        workerMaximumAttempts: parseInteger(
            env.WORKER_MAXIMUM_ATTEMPTS,
            DEFAULTS.workerMaximumAttempts,
            "WORKER_MAXIMUM_ATTEMPTS",
            { minimum: 1, maximum: 1000 }
        ),
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

    if (config.postgresPoolMinimum > config.postgresPoolMaximum) {
        throw new Error("POSTGRES_POOL_MINIMUM must not exceed POSTGRES_POOL_MAXIMUM.");
    }
    if (config.workerHeartbeatIntervalMs >= config.workerLeaseDurationMs) {
        throw new Error("WORKER_HEARTBEAT_INTERVAL_MS must be shorter than the worker lease.");
    }
    if (config.workerLeaseDurationMs > config.workerMaximumClaimDurationMs) {
        throw new Error("WORKER_LEASE_DURATION_MS must not exceed the maximum claim duration.");
    }
    if (config.workerStaleThresholdMs < config.workerLeaseDurationMs) {
        throw new Error("WORKER_STALE_THRESHOLD_MS must be at least the worker lease duration.");
    }
    if (config.paymentSandboxEnabled && !isLoopbackUrl(config.paymentPublicBaseUrl)) {
        throw new Error(
            "PAYMENT_PUBLIC_BASE_URL must use a loopback host when the payment sandbox is enabled."
        );
    }
    if (!config.postgresApplicationName) {
        throw new Error("POSTGRES_APPLICATION_NAME must not be empty.");
    }
    if (
        config.managedBackupOperationsEnabled
        && !config.managedBackupEvidenceDirectory
    ) {
        throw new Error(
            "MANAGED_BACKUP_EVIDENCE_DIRECTORY is required when managed backup operations are enabled."
        );
    }
    if (config.managedBackupOperationsEnabled) {
        if (!/^sha256:[a-f0-9]{64}$/.test(
            config.managedBackupExpectedDatabaseIdentity || ""
        )) {
            throw new Error(
                "MANAGED_BACKUP_EXPECTED_DATABASE_IDENTITY must be a sanitized SHA-256 identity when managed backup operations are enabled."
            );
        }
        if (!config.managedBackupExpectedRegion) {
            throw new Error(
                "MANAGED_BACKUP_EXPECTED_REGION is required when managed backup operations are enabled."
            );
        }
    }

    return config;
}
