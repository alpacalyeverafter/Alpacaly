import { randomUUID } from "node:crypto";

const DEFAULT_CREATED_AT = "2026-07-19T00:00:00.000Z";

export const RESOURCE_TYPES = Object.freeze({
    BARN: "BARN",
    FEEDER: "FEEDER",
    CAMERA: "CAMERA",
    DEVICE: "DEVICE",
    QUEUE: "QUEUE"
});

export const DEFAULT_RESOURCE_IDS = Object.freeze({
    barnId: "barn_00000000-0000-4000-8000-000000000001",
    feederId: "feeder_00000000-0000-4000-8000-000000000002",
    queueId: "queue_00000000-0000-4000-8000-000000000003"
});

export const DEFAULT_RESOURCES = Object.freeze({
    barn: Object.freeze({
        barnId: DEFAULT_RESOURCE_IDS.barnId,
        name: "Default Barn",
        timezone: "Europe/London",
        createdAt: DEFAULT_CREATED_AT
    }),
    feeder: Object.freeze({
        feederId: DEFAULT_RESOURCE_IDS.feederId,
        barnId: DEFAULT_RESOURCE_IDS.barnId,
        name: "Default Feeder",
        createdAt: DEFAULT_CREATED_AT
    }),
    queue: Object.freeze({
        queueId: DEFAULT_RESOURCE_IDS.queueId,
        barnId: DEFAULT_RESOURCE_IDS.barnId,
        feederId: DEFAULT_RESOURCE_IDS.feederId,
        resourceType: RESOURCE_TYPES.FEEDER,
        resourceId: DEFAULT_RESOURCE_IDS.feederId,
        name: "Default Feeder Queue",
        createdAt: DEFAULT_CREATED_AT
    })
});

function requireText(value, name) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        throw new Error(`${name} is required.`);
    }
    return normalized;
}

function resourceId(prefix, explicitId, idGenerator) {
    return explicitId
        ? requireText(explicitId, `${prefix}Id`)
        : `${prefix}_${idGenerator()}`;
}

function createdAt(value, clock) {
    if (value === undefined) {
        return clock().toISOString();
    }

    const normalized = requireText(value, "createdAt");
    if (Number.isNaN(Date.parse(normalized))) {
        throw new Error("createdAt must be an ISO-compatible timestamp.");
    }
    return normalized;
}

export function createBarn(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    return Object.freeze({
        barnId: resourceId("barn", input?.barnId, idGenerator),
        name: requireText(input?.name, "name"),
        timezone: requireText(input?.timezone || "Europe/London", "timezone"),
        createdAt: createdAt(input?.createdAt, clock)
    });
}

export function createFeeder(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    return Object.freeze({
        feederId: resourceId("feeder", input?.feederId, idGenerator),
        barnId: requireText(input?.barnId, "barnId"),
        name: requireText(input?.name, "name"),
        createdAt: createdAt(input?.createdAt, clock)
    });
}

export function createCamera(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    return Object.freeze({
        cameraId: resourceId("camera", input?.cameraId, idGenerator),
        barnId: requireText(input?.barnId, "barnId"),
        name: requireText(input?.name, "name"),
        createdAt: createdAt(input?.createdAt, clock)
    });
}

export function createDevice(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    return Object.freeze({
        deviceId: resourceId("device", input?.deviceId, idGenerator),
        barnId: requireText(input?.barnId, "barnId"),
        name: requireText(input?.name, "name"),
        kind: requireText(input?.kind || "CONTROLLER", "kind").toUpperCase(),
        createdAt: createdAt(input?.createdAt, clock)
    });
}

export function createQueue(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const feederId = requireText(input?.feederId, "feederId");
    return Object.freeze({
        queueId: resourceId("queue", input?.queueId, idGenerator),
        barnId: requireText(input?.barnId, "barnId"),
        feederId,
        resourceType: RESOURCE_TYPES.FEEDER,
        resourceId: feederId,
        name: requireText(input?.name, "name"),
        createdAt: createdAt(input?.createdAt, clock)
    });
}
