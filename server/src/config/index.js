import dotenv from "dotenv";

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

export function loadConfig(env = process.env, { loadEnvFile = true } = {}) {
    if (loadEnvFile) {
        dotenv.config({ quiet: true });
    }

    const requestBodyLimit = String(env.REQUEST_BODY_LIMIT || DEFAULTS.requestBodyLimit).trim();
    if (!requestBodyLimit) {
        throw new Error("REQUEST_BODY_LIMIT must not be empty.");
    }

    return Object.freeze({
        serviceName: DEFAULTS.serviceName,
        nodeEnv: String(env.NODE_ENV || DEFAULTS.nodeEnv),
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
        requestBodyLimit
    });
}
