const DAY_MS = 24 * 60 * 60 * 1000;

function positiveInteger(value, name) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive safe integer.`);
    }
    return parsed;
}

export function normalizeRetentionPolicy(policy = {}) {
    return Object.freeze({
        dailyDays: positiveInteger(policy.dailyDays ?? 14, "dailyDays"),
        weeklyWeeks: positiveInteger(policy.weeklyWeeks ?? 8, "weeklyWeeks"),
        monthlyMonths: positiveInteger(policy.monthlyMonths ?? 12, "monthlyMonths"),
        minimumDays: positiveInteger(policy.minimumDays ?? 7, "minimumDays")
    });
}

export function calculateRetentionExpiry({
    createdAt,
    cadence = "daily",
    policy = {},
    legalOrIncidentHold = false
}) {
    const createdTime = Date.parse(createdAt);
    if (!Number.isFinite(createdTime)) {
        throw new Error("createdAt must be an ISO-compatible timestamp.");
    }
    if (legalOrIncidentHold) {
        return null;
    }
    const normalized = normalizeRetentionPolicy(policy);
    const normalizedCadence = String(cadence).trim().toLowerCase();
    let retentionMs;
    if (normalizedCadence === "daily") {
        retentionMs = normalized.dailyDays * DAY_MS;
    } else if (normalizedCadence === "weekly") {
        retentionMs = normalized.weeklyWeeks * 7 * DAY_MS;
    } else if (normalizedCadence === "monthly") {
        const expiry = new Date(createdTime);
        expiry.setUTCMonth(expiry.getUTCMonth() + normalized.monthlyMonths);
        retentionMs = expiry.getTime() - createdTime;
    } else {
        throw new Error("cadence must be daily, weekly or monthly.");
    }
    return new Date(
        createdTime + Math.max(retentionMs, normalized.minimumDays * DAY_MS)
    ).toISOString();
}

export function isBackupExpired(manifest, now = new Date()) {
    if (manifest.legalOrIncidentHold || !manifest.retentionExpiresAt) {
        return false;
    }
    return Date.parse(manifest.retentionExpiresAt) <= now.getTime();
}
