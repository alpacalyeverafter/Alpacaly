import { DEFAULT_RESOURCES } from "../../domain/resources.js";

function seedDefaultResources(database) {
    database.prepare(`
        INSERT OR IGNORE INTO Barns (barnId, name, timezone, createdAt)
        VALUES (?, ?, ?, ?)
    `).run(
        DEFAULT_RESOURCES.barn.barnId,
        DEFAULT_RESOURCES.barn.name,
        DEFAULT_RESOURCES.barn.timezone,
        DEFAULT_RESOURCES.barn.createdAt
    );

    database.prepare(`
        INSERT OR IGNORE INTO Feeders (feederId, barnId, name, createdAt)
        VALUES (?, ?, ?, ?)
    `).run(
        DEFAULT_RESOURCES.feeder.feederId,
        DEFAULT_RESOURCES.feeder.barnId,
        DEFAULT_RESOURCES.feeder.name,
        DEFAULT_RESOURCES.feeder.createdAt
    );

    database.prepare(`
        INSERT OR IGNORE INTO Queues (
            queueId,
            barnId,
            feederId,
            resourceType,
            resourceId,
            name,
            createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        DEFAULT_RESOURCES.queue.queueId,
        DEFAULT_RESOURCES.queue.barnId,
        DEFAULT_RESOURCES.queue.feederId,
        DEFAULT_RESOURCES.queue.resourceType,
        DEFAULT_RESOURCES.queue.resourceId,
        DEFAULT_RESOURCES.queue.name,
        DEFAULT_RESOURCES.queue.createdAt
    );
}

export const migration002ResourceModel = Object.freeze({
    version: 2,
    name: "resource_model",
    up(database) {
        database.exec(`
            CREATE TABLE Barns (
                barnId TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                timezone TEXT NOT NULL,
                createdAt TEXT NOT NULL
            ) STRICT;

            CREATE TABLE Feeders (
                feederId TEXT PRIMARY KEY,
                barnId TEXT NOT NULL,
                name TEXT NOT NULL,
                createdAt TEXT NOT NULL,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT,
                UNIQUE (feederId, barnId)
            ) STRICT;

            CREATE TABLE Cameras (
                cameraId TEXT PRIMARY KEY,
                barnId TEXT NOT NULL,
                name TEXT NOT NULL,
                createdAt TEXT NOT NULL,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE Devices (
                deviceId TEXT PRIMARY KEY,
                barnId TEXT NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                createdAt TEXT NOT NULL,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE Queues (
                queueId TEXT PRIMARY KEY,
                barnId TEXT NOT NULL,
                feederId TEXT NOT NULL UNIQUE,
                resourceType TEXT NOT NULL CHECK (resourceType = 'FEEDER'),
                resourceId TEXT NOT NULL,
                name TEXT NOT NULL,
                createdAt TEXT NOT NULL,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT,
                FOREIGN KEY (feederId, barnId)
                    REFERENCES Feeders(feederId, barnId) ON DELETE RESTRICT,
                UNIQUE (resourceType, resourceId),
                CHECK (resourceId = feederId)
            ) STRICT;
        `);

        seedDefaultResources(database);

        database.exec(`
            ALTER TABLE Events
                ADD COLUMN barnId TEXT REFERENCES Barns(barnId);
            ALTER TABLE Events
                ADD COLUMN feederId TEXT REFERENCES Feeders(feederId);
            ALTER TABLE Events
                ADD COLUMN queueId TEXT REFERENCES Queues(queueId);
        `);

        database.prepare(`
            UPDATE Events
            SET barnId = ?, feederId = ?, queueId = ?
        `).run(
            DEFAULT_RESOURCES.barn.barnId,
            DEFAULT_RESOURCES.feeder.feederId,
            DEFAULT_RESOURCES.queue.queueId
        );

        database.exec(`
            CREATE TABLE Queue_v2 (
                eventId TEXT PRIMARY KEY,
                queueId TEXT NOT NULL,
                queuePosition INTEGER NOT NULL,
                enqueuedAt TEXT NOT NULL,
                FOREIGN KEY (eventId) REFERENCES Events(eventId) ON DELETE CASCADE,
                FOREIGN KEY (queueId) REFERENCES Queues(queueId) ON DELETE RESTRICT,
                UNIQUE (queueId, queuePosition)
            ) STRICT;
        `);

        database.prepare(`
            INSERT INTO Queue_v2 (eventId, queueId, queuePosition, enqueuedAt)
            SELECT eventId, ?, queuePosition, enqueuedAt
            FROM Queue
        `).run(DEFAULT_RESOURCES.queue.queueId);

        database.exec(`
            DROP TABLE Queue;
            ALTER TABLE Queue_v2 RENAME TO Queue;

            CREATE INDEX idx_events_barn_feeder
                ON Events(barnId, feederId);
            CREATE INDEX idx_events_queue
                ON Events(queueId, currentState);
            CREATE INDEX idx_feeders_barn
                ON Feeders(barnId, feederId);
            CREATE INDEX idx_cameras_barn
                ON Cameras(barnId, cameraId);
            CREATE INDEX idx_devices_barn
                ON Devices(barnId, deviceId);
            CREATE INDEX idx_queues_barn
                ON Queues(barnId, queueId);
            CREATE INDEX idx_queue_position
                ON Queue(queueId, queuePosition);

            CREATE TRIGGER events_validate_resources_insert
            BEFORE INSERT ON Events
            BEGIN
                SELECT CASE
                    WHEN NEW.barnId IS NULL OR NEW.feederId IS NULL OR NEW.queueId IS NULL
                    THEN RAISE(ABORT, 'Event resource IDs are required')
                END;
                SELECT CASE
                    WHEN NOT EXISTS (
                        SELECT 1
                        FROM Queues
                        WHERE queueId = NEW.queueId
                          AND barnId = NEW.barnId
                          AND feederId = NEW.feederId
                    )
                    THEN RAISE(ABORT, 'Event resources do not belong together')
                END;
            END;

            CREATE TRIGGER events_validate_resources_update
            BEFORE UPDATE OF barnId, feederId, queueId ON Events
            BEGIN
                SELECT CASE
                    WHEN NEW.barnId IS NULL OR NEW.feederId IS NULL OR NEW.queueId IS NULL
                    THEN RAISE(ABORT, 'Event resource IDs are required')
                END;
                SELECT CASE
                    WHEN NOT EXISTS (
                        SELECT 1
                        FROM Queues
                        WHERE queueId = NEW.queueId
                          AND barnId = NEW.barnId
                          AND feederId = NEW.feederId
                    )
                    THEN RAISE(ABORT, 'Event resources do not belong together')
                END;
            END;

            CREATE TRIGGER queue_validate_event_resource_insert
            BEFORE INSERT ON Queue
            WHEN NOT EXISTS (
                SELECT 1
                FROM Events
                WHERE eventId = NEW.eventId
                  AND queueId = NEW.queueId
            )
            BEGIN
                SELECT RAISE(ABORT, 'Queue entry does not match Event queue');
            END;

            CREATE TRIGGER queue_validate_event_resource_update
            BEFORE UPDATE OF eventId, queueId ON Queue
            WHEN NOT EXISTS (
                SELECT 1
                FROM Events
                WHERE eventId = NEW.eventId
                  AND queueId = NEW.queueId
            )
            BEGIN
                SELECT RAISE(ABORT, 'Queue entry does not match Event queue');
            END;
        `);
    }
});

export { seedDefaultResources };
