import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { FEED_LIFECYCLE_STATES } from "../event-engine/lifecycle.js";

const LIFECYCLE_STATE_SQL = FEED_LIFECYCLE_STATES
    .map(state => `'${state}'`)
    .join(", ");

function parseJson(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    return JSON.parse(value);
}

function serializeJson(value) {
    return JSON.stringify(value ?? null);
}

export class SqliteEventStore {
    constructor({ databasePath, logger }) {
        if (!databasePath) {
            throw new Error("SqliteEventStore requires a databasePath.");
        }

        this.databasePath = databasePath;
        this.logger = logger;
        this.closed = false;

        if (databasePath !== ":memory:") {
            mkdirSync(dirname(databasePath), { recursive: true });
        }

        this.database = new DatabaseSync(databasePath);
        this.configureConnection();
        this.createSchema();
        this.prepareStatements();

        this.logger.info({
            event: "event_store_connected",
            databasePath: databasePath === ":memory:" ? ":memory:" : databasePath
        }, "SQLite Event Store connected");
    }

    configureConnection() {
        this.database.exec("PRAGMA foreign_keys = ON;");
        this.database.exec("PRAGMA busy_timeout = 5000;");

        if (this.databasePath !== ":memory:") {
            this.database.exec("PRAGMA journal_mode = WAL;");
            this.database.exec("PRAGMA synchronous = FULL;");
        }
    }

    createSchema() {
        this.database.exec(`
            CREATE TABLE IF NOT EXISTS Events (
                eventId TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                sequenceNumber INTEGER NOT NULL UNIQUE,
                supporterName TEXT NOT NULL,
                source TEXT NOT NULL,
                message TEXT NOT NULL DEFAULT '',
                clientRequestId TEXT UNIQUE,
                requestedAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL,
                currentState TEXT NOT NULL CHECK (currentState IN (${LIFECYCLE_STATE_SQL}))
            ) STRICT;

            CREATE TABLE IF NOT EXISTS LifecycleHistory (
                historyId INTEGER PRIMARY KEY AUTOINCREMENT,
                eventId TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                state TEXT NOT NULL CHECK (state IN (${LIFECYCLE_STATE_SQL})),
                timestamp TEXT NOT NULL,
                detailsJson TEXT NOT NULL DEFAULT 'null',
                FOREIGN KEY (eventId) REFERENCES Events(eventId) ON DELETE CASCADE,
                UNIQUE (eventId, ordinal),
                UNIQUE (eventId, state)
            ) STRICT;

            CREATE TABLE IF NOT EXISTS Queue (
                eventId TEXT PRIMARY KEY,
                queuePosition INTEGER NOT NULL UNIQUE,
                enqueuedAt TEXT NOT NULL,
                FOREIGN KEY (eventId) REFERENCES Events(eventId) ON DELETE CASCADE
            ) STRICT;

            CREATE TABLE IF NOT EXISTS HardwareAcknowledgements (
                acknowledgementId INTEGER PRIMARY KEY AUTOINCREMENT,
                eventId TEXT NOT NULL,
                stage TEXT NOT NULL CHECK (stage IN ('BELL', 'DISPENSING')),
                status TEXT NOT NULL,
                receivedAt TEXT NOT NULL,
                detailsJson TEXT NOT NULL DEFAULT 'null',
                FOREIGN KEY (eventId) REFERENCES Events(eventId) ON DELETE CASCADE
            ) STRICT;

            CREATE INDEX IF NOT EXISTS idx_events_current_state
                ON Events(currentState);
            CREATE INDEX IF NOT EXISTS idx_lifecycle_history_event
                ON LifecycleHistory(eventId, ordinal);
            CREATE INDEX IF NOT EXISTS idx_queue_position
                ON Queue(queuePosition);
            CREATE INDEX IF NOT EXISTS idx_hardware_acknowledgements_event
                ON HardwareAcknowledgements(eventId, acknowledgementId);

            PRAGMA user_version = 1;
        `);
    }

    prepareStatements() {
        this.statements = {
            insertEvent: this.database.prepare(`
                INSERT INTO Events (
                    eventId,
                    type,
                    sequenceNumber,
                    supporterName,
                    source,
                    message,
                    clientRequestId,
                    requestedAt,
                    updatedAt,
                    currentState
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            insertHistory: this.database.prepare(`
                INSERT INTO LifecycleHistory (
                    eventId,
                    ordinal,
                    state,
                    timestamp,
                    detailsJson
                ) VALUES (?, ?, ?, ?, ?)
            `),
            insertQueue: this.database.prepare(`
                INSERT INTO Queue (eventId, queuePosition, enqueuedAt)
                VALUES (?, ?, ?)
            `),
            updateEventState: this.database.prepare(`
                UPDATE Events
                SET currentState = ?, updatedAt = ?
                WHERE eventId = ? AND currentState = ?
            `),
            deleteQueueEvent: this.database.prepare(`
                DELETE FROM Queue WHERE eventId = ?
            `),
            insertAcknowledgement: this.database.prepare(`
                INSERT INTO HardwareAcknowledgements (
                    eventId,
                    stage,
                    status,
                    receivedAt,
                    detailsJson
                ) VALUES (?, ?, ?, ?, ?)
            `),
            updateEventTimestamp: this.database.prepare(`
                UPDATE Events SET updatedAt = ? WHERE eventId = ?
            `),
            selectEvents: this.database.prepare(`
                SELECT
                    eventId,
                    type,
                    sequenceNumber,
                    supporterName,
                    source,
                    message,
                    clientRequestId,
                    requestedAt,
                    updatedAt,
                    currentState
                FROM Events
                ORDER BY sequenceNumber ASC
            `),
            selectHistory: this.database.prepare(`
                SELECT eventId, ordinal, state, timestamp, detailsJson
                FROM LifecycleHistory
                ORDER BY eventId ASC, ordinal ASC
            `),
            selectQueue: this.database.prepare(`
                SELECT eventId, queuePosition, enqueuedAt
                FROM Queue
                ORDER BY queuePosition ASC
            `),
            selectAcknowledgements: this.database.prepare(`
                SELECT
                    acknowledgementId,
                    eventId,
                    stage,
                    status,
                    receivedAt,
                    detailsJson
                FROM HardwareAcknowledgements
                ORDER BY eventId ASC, acknowledgementId ASC
            `)
        };
    }

    transaction(callback) {
        this.assertOpen();
        this.database.exec("BEGIN IMMEDIATE;");
        try {
            const result = callback();
            this.database.exec("COMMIT;");
            return result;
        } catch (error) {
            this.database.exec("ROLLBACK;");
            throw error;
        }
    }

    createQueuedEvent(feedRequest) {
        this.transaction(() => {
            this.statements.insertEvent.run(
                feedRequest.eventId,
                feedRequest.type,
                feedRequest.sequenceNumber,
                feedRequest.supporterName,
                feedRequest.source,
                feedRequest.message,
                feedRequest.clientRequestId,
                feedRequest.requestedAt,
                feedRequest.updatedAt,
                feedRequest.state
            );

            feedRequest.timeline.forEach((entry, index) => {
                this.statements.insertHistory.run(
                    feedRequest.eventId,
                    index + 1,
                    entry.state,
                    entry.timestamp,
                    serializeJson(entry.details)
                );
            });

            this.statements.insertQueue.run(
                feedRequest.eventId,
                feedRequest.sequenceNumber,
                feedRequest.stateTimestamps.QUEUED
            );
        });
    }

    appendLifecycleTransition(feedRequest, timelineEntry) {
        this.transaction(() => {
            this.statements.insertHistory.run(
                feedRequest.eventId,
                feedRequest.timeline.length + 1,
                timelineEntry.state,
                timelineEntry.timestamp,
                serializeJson(timelineEntry.details)
            );

            const result = this.statements.updateEventState.run(
                timelineEntry.state,
                timelineEntry.timestamp,
                feedRequest.eventId,
                feedRequest.state
            );

            if (Number(result.changes) !== 1) {
                throw new Error(
                    `Persistent state for ${feedRequest.eventId} did not match ${feedRequest.state}.`
                );
            }
        });
    }

    removeFromQueue(eventId) {
        this.assertOpen();
        this.statements.deleteQueueEvent.run(eventId);
    }

    addHardwareAcknowledgement(eventId, acknowledgement) {
        this.transaction(() => {
            this.statements.insertAcknowledgement.run(
                eventId,
                acknowledgement.stage,
                acknowledgement.status,
                acknowledgement.receivedAt,
                serializeJson(acknowledgement.details)
            );
            this.statements.updateEventTimestamp.run(
                acknowledgement.receivedAt,
                eventId
            );
        });
    }

    loadState() {
        this.assertOpen();
        const historiesByEvent = new Map();
        const acknowledgementsByEvent = new Map();

        this.statements.selectHistory.all().forEach(row => {
            const entries = historiesByEvent.get(row.eventId) || [];
            entries.push({
                state: row.state,
                timestamp: row.timestamp,
                details: parseJson(row.detailsJson)
            });
            historiesByEvent.set(row.eventId, entries);
        });

        this.statements.selectAcknowledgements.all().forEach(row => {
            const entries = acknowledgementsByEvent.get(row.eventId) || [];
            entries.push({
                stage: row.stage,
                status: row.status,
                receivedAt: row.receivedAt,
                details: parseJson(row.detailsJson)
            });
            acknowledgementsByEvent.set(row.eventId, entries);
        });

        const events = this.statements.selectEvents.all().map(row => {
            const timeline = historiesByEvent.get(row.eventId) || [];
            const acknowledgementHistory = acknowledgementsByEvent.get(row.eventId) || [];
            const stateTimestamps = Object.fromEntries(
                timeline.map(entry => [entry.state, entry.timestamp])
            );
            const hardwareAcknowledgements = {
                BELL: null,
                DISPENSING: null
            };
            acknowledgementHistory.forEach(entry => {
                hardwareAcknowledgements[entry.stage] = entry;
            });

            return {
                id: row.eventId,
                eventId: row.eventId,
                type: row.type,
                state: row.currentState,
                status: row.currentState,
                sequenceNumber: row.sequenceNumber,
                supporterName: row.supporterName,
                source: row.source,
                message: row.message,
                clientRequestId: row.clientRequestId,
                requestedAt: row.requestedAt,
                updatedAt: row.updatedAt,
                stateTimestamps,
                timeline,
                hardwareAcknowledgements,
                acknowledgementHistory
            };
        });

        return {
            events,
            queueEventIds: this.statements.selectQueue.all().map(row => row.eventId)
        };
    }

    clearAll() {
        this.assertOpen();
        this.database.exec("DELETE FROM Events;");
    }

    getTableNames() {
        this.assertOpen();
        return this.database.prepare(`
            SELECT name
            FROM sqlite_schema
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name ASC
        `).all().map(row => row.name);
    }

    close() {
        if (this.closed) {
            return;
        }

        this.database.close();
        this.closed = true;
    }

    assertOpen() {
        if (this.closed) {
            throw new Error("SQLite Event Store is closed.");
        }
    }
}
