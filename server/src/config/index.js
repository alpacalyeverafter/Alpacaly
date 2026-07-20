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
