import { createHash, randomUUID } from "node:crypto";
import {
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { readBackupManifest } from "./backup-manifest.js";

const HOLD_TYPES = Object.freeze(["INCIDENT", "LEGAL"]);

function requireText(value, name, { maximumLength = 500 } = {}) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        throw new Error(`${name} is required.`);
    }
    if (normalized.length > maximumLength) {
        throw new Error(`${name} must not exceed ${maximumLength} characters.`);
    }
    return normalized;
}

function safeIdentifier(value, name) {
    const normalized = requireText(value, name, { maximumLength: 200 });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(normalized)) {
        throw new Error(`${name} contains unsupported characters.`);
    }
    return normalized;
}

function timestamp(value, name) {
    const normalized = requireText(value, name);
    if (Number.isNaN(Date.parse(normalized))) {
        throw new Error(`${name} must be an ISO-compatible timestamp.`);
    }
    return normalized;
}

function positiveInteger(value, name) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive safe integer.`);
    }
    return parsed;
}

function optionalDigest(value, name) {
    if (value === null) {
        return null;
    }
    const normalized = requireText(value, name);
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
        throw new Error(`${name} must be a SHA-256 digest.`);
    }
    return normalized;
}

function assertAllowedKeys(value) {
    const allowed = [
        "eventVersion",
        "sequence",
        "previousEventDigest",
        "eventId",
        "eventType",
        "holdId",
        "holdType",
        "backupId",
        "decisionId",
        "authorityReference",
        "reason",
        "occurredAt",
        "eventDigest"
    ];
    const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
    if (unexpected.length > 0) {
        throw new Error(`Backup hold event contains unsupported fields: ${unexpected.join(", ")}.`);
    }
}

function validateEvent(input) {
    assertAllowedKeys(input);
    const eventType = requireText(input.eventType, "eventType").toUpperCase();
    if (!["BACKUP_HOLD_APPLIED", "BACKUP_HOLD_RELEASED"].includes(eventType)) {
        throw new Error("eventType is not supported.");
    }
    const holdType = requireText(input.holdType, "holdType").toUpperCase();
    if (!HOLD_TYPES.includes(holdType)) {
        throw new Error(`holdType must be one of: ${HOLD_TYPES.join(", ")}.`);
    }
    const payload = {
        eventVersion: 1,
        sequence: positiveInteger(input.sequence, "sequence"),
        previousEventDigest: optionalDigest(
            input.previousEventDigest,
            "previousEventDigest"
        ),
        eventId: safeIdentifier(input.eventId, "eventId"),
        eventType,
        holdId: safeIdentifier(input.holdId, "holdId"),
        holdType,
        backupId: safeIdentifier(input.backupId, "backupId"),
        decisionId: safeIdentifier(input.decisionId, "decisionId"),
        authorityReference: safeIdentifier(
            input.authorityReference,
            "authorityReference"
        ),
        reason: requireText(input.reason, "reason", { maximumLength: 1000 }),
        occurredAt: timestamp(input.occurredAt, "occurredAt")
    };
    const eventDigest = createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");
    if (input.eventDigest && input.eventDigest !== eventDigest) {
        throw new Error("Backup hold event digest does not match its payload.");
    }
    return Object.freeze({ ...payload, eventDigest });
}

export class BackupHoldRegistry {
    constructor({ directory, clock = () => new Date(), idGenerator = randomUUID } = {}) {
        if (directory && !isAbsolute(directory)) {
            throw new Error("Backup hold registry directory must be an absolute path.");
        }
        this.directory = directory ? resolve(directory) : null;
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    events() {
        if (!this.directory) {
            return [];
        }
        let names;
        try {
            names = readdirSync(this.directory);
        } catch (error) {
            if (error.code === "ENOENT") {
                return [];
            }
            throw new Error("Backup hold evidence directory cannot be read.");
        }
        const events = names
            .filter(name => name.endsWith(".backup-hold-event.json"))
            .map(name => {
                try {
                    const parsed = JSON.parse(readFileSync(
                        resolve(this.directory, name),
                        "utf8"
                    ));
                    if (Number(parsed.eventVersion) !== 1) {
                        throw new Error("eventVersion is not supported");
                    }
                    return validateEvent(parsed);
                } catch (error) {
                    throw new Error(`Backup hold evidence ${name} is invalid: ${error.message}`);
                }
            })
            .sort((left, right) => left.sequence - right.sequence);
        events.forEach((event, index) => {
            const expectedSequence = index + 1;
            const expectedPreviousDigest = events[index - 1]?.eventDigest || null;
            if (
                event.sequence !== expectedSequence
                || event.previousEventDigest !== expectedPreviousDigest
            ) {
                throw new Error("Backup hold evidence chain is incomplete or out of order.");
            }
        });
        return events;
    }

    activeHolds() {
        const events = this.events();
        const released = new Set(events
            .filter(event => event.eventType === "BACKUP_HOLD_RELEASED")
            .map(event => event.holdId));
        return events.filter(event => (
            event.eventType === "BACKUP_HOLD_APPLIED"
            && !released.has(event.holdId)
        ));
    }

    holdsForBackup(backupId) {
        return this.activeHolds().filter(event => event.backupId === backupId);
    }

    isBackupHeld(backupId) {
        return this.holdsForBackup(backupId).length > 0;
    }

    apply({
        backupId,
        holdId,
        holdType,
        decisionId,
        authorityReference,
        reason
    }) {
        this.#requireDirectory();
        const normalizedBackupId = safeIdentifier(backupId, "backupId");
        const manifest = this.#manifest(normalizedBackupId);
        if (manifest.backupId !== normalizedBackupId) {
            throw new Error("The requested backup manifest identity does not match.");
        }
        const normalizedHoldId = safeIdentifier(holdId, "holdId");
        if (this.events().some(event => event.holdId === normalizedHoldId)) {
            throw new Error("The holdId has already been used and cannot be replayed.");
        }
        return this.#append({
            eventVersion: 1,
            eventId: `backup-hold-event-${this.idGenerator()}`,
            eventType: "BACKUP_HOLD_APPLIED",
            holdId: normalizedHoldId,
            holdType,
            backupId: normalizedBackupId,
            decisionId,
            authorityReference,
            reason,
            occurredAt: this.clock().toISOString()
        });
    }

    release({ holdId, decisionId, authorityReference, reason }) {
        this.#requireDirectory();
        const normalizedHoldId = safeIdentifier(holdId, "holdId");
        const active = this.activeHolds().find(event => event.holdId === normalizedHoldId);
        if (!active) {
            throw new Error("The backup hold is not active or does not exist.");
        }
        const manifest = this.#manifest(active.backupId);
        if (manifest.legalOrIncidentHold) {
            throw new Error(
                "The backup manifest contains a source hold that this registry cannot release."
            );
        }
        return this.#append({
            eventVersion: 1,
            eventId: `backup-hold-event-${this.idGenerator()}`,
            eventType: "BACKUP_HOLD_RELEASED",
            holdId: active.holdId,
            holdType: active.holdType,
            backupId: active.backupId,
            decisionId,
            authorityReference,
            reason,
            occurredAt: this.clock().toISOString()
        });
    }

    #manifest(backupId) {
        return readBackupManifest(resolve(this.directory, `${backupId}.manifest.json`));
    }

    #append(input) {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const lockPath = resolve(this.directory, ".backup-hold-registry.lock");
        let lock;
        try {
            lock = openSync(lockPath, "wx", 0o600);
        } catch (error) {
            if (error.code === "EEXIST") {
                throw new Error("Another backup hold operation is in progress.");
            }
            throw error;
        }
        try {
            const current = this.events();
            const event = validateEvent({
                ...input,
                sequence: current.length + 1,
                previousEventDigest: current.at(-1)?.eventDigest || null
            });
            const path = resolve(
                this.directory,
                `${event.eventId}.backup-hold-event.json`
            );
            writeFileSync(path, `${JSON.stringify(event, null, 2)}\n`, {
                encoding: "utf8",
                flag: "wx",
                mode: 0o600
            });
            return event;
        } finally {
            closeSync(lock);
            unlinkSync(lockPath);
        }
    }

    #requireDirectory() {
        if (!this.directory) {
            throw new Error("Backup hold registry directory is not configured.");
        }
    }
}
