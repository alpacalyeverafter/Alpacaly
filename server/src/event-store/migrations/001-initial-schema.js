const phaseFiveLifecycleStates = Object.freeze([
    "RECEIVED",
    "VALIDATED",
    "QUEUED",
    "APPROVED",
    "COUNTDOWN",
    "BELL",
    "DISPENSING",
    "COMPLETE",
    "ARCHIVED"
]);

const lifecycleStates = phaseFiveLifecycleStates
    .map(state => `'${state}'`)
    .join(", ");

export const migration001InitialSchema = Object.freeze({
    version: 1,
    name: "initial_event_store",
    up(database) {
        database.exec(`
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
                currentState TEXT NOT NULL CHECK (currentState IN (${lifecycleStates}))
            ) STRICT;

            CREATE TABLE IF NOT EXISTS LifecycleHistory (
                historyId INTEGER PRIMARY KEY AUTOINCREMENT,
                eventId TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                state TEXT NOT NULL CHECK (state IN (${lifecycleStates})),
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
        `);
    }
});
