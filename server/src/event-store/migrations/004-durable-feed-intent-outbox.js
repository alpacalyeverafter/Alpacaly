import { DEFAULT_RESOURCE_IDS } from "../../domain/resources.js";

const historyActions = [
    "FEED_INTENT_CREATED",
    "OUTBOX_QUEUED",
    "PROCESSING_STARTED",
    "FEED_REQUEST_CREATED",
    "QUEUE_INSERTION_COMPLETED",
    "PROCESSING_COMPLETED",
    "PROCESSING_FAILED",
    "PROCESSING_RECOVERED"
].map(value => `'${value}'`).join(", ");

export const migration004DurableFeedIntentOutbox = Object.freeze({
    version: 4,
    name: "durable_feed_intent_outbox",
    up(database) {
        database.exec(`
            CREATE TABLE FeedIntents (
                feedIntentId TEXT PRIMARY KEY,
                contributionId TEXT NOT NULL UNIQUE,
                barnId TEXT NOT NULL,
                feederId TEXT NOT NULL,
                queueId TEXT NOT NULL,
                message TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL
                    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
                createdAt TEXT NOT NULL,
                outboxQueuedAt TEXT NOT NULL,
                processingStartedAt TEXT,
                feedRequestCreatedAt TEXT,
                queueInsertionCompletedAt TEXT,
                processingCompletedAt TEXT,
                processingFailedAt TEXT,
                failureReason TEXT,
                attemptCount INTEGER NOT NULL DEFAULT 0 CHECK (attemptCount >= 0),
                updatedAt TEXT NOT NULL,
                FOREIGN KEY (contributionId)
                    REFERENCES Contributions(contributionId) ON DELETE RESTRICT,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT,
                FOREIGN KEY (feederId) REFERENCES Feeders(feederId) ON DELETE RESTRICT,
                FOREIGN KEY (queueId) REFERENCES Queues(queueId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE Outbox (
                outboxSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                outboxEntryId TEXT NOT NULL UNIQUE,
                feedIntentId TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL
                    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
                createdAt TEXT NOT NULL,
                availableAt TEXT NOT NULL,
                processingStartedAt TEXT,
                completedAt TEXT,
                failedAt TEXT,
                attemptCount INTEGER NOT NULL DEFAULT 0 CHECK (attemptCount >= 0),
                lastError TEXT,
                updatedAt TEXT NOT NULL,
                FOREIGN KEY (feedIntentId)
                    REFERENCES FeedIntents(feedIntentId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE FeedIntentHistory (
                historySequence INTEGER PRIMARY KEY AUTOINCREMENT,
                feedIntentId TEXT NOT NULL,
                action TEXT NOT NULL CHECK (action IN (${historyActions})),
                timestamp TEXT NOT NULL,
                detailsJson TEXT NOT NULL DEFAULT 'null',
                FOREIGN KEY (feedIntentId)
                    REFERENCES FeedIntents(feedIntentId) ON DELETE RESTRICT
            ) STRICT;

            ALTER TABLE Events
                ADD COLUMN feedIntentId TEXT REFERENCES FeedIntents(feedIntentId);
        `);

        const completedTimestamp = `COALESCE(
            (SELECT history.timestamp
             FROM LifecycleHistory AS history
             WHERE history.eventId = event.eventId
               AND history.state = 'QUEUED'
             LIMIT 1),
            event.requestedAt
        )`;

        database.exec(`
            INSERT INTO FeedIntents (
                feedIntentId,
                contributionId,
                barnId,
                feederId,
                queueId,
                message,
                status,
                createdAt,
                outboxQueuedAt,
                processingStartedAt,
                feedRequestCreatedAt,
                queueInsertionCompletedAt,
                processingCompletedAt,
                processingFailedAt,
                failureReason,
                attemptCount,
                updatedAt
            )
            SELECT
                'feed_intent_legacy_' || contribution.contributionId,
                contribution.contributionId,
                COALESCE(event.barnId, '${DEFAULT_RESOURCE_IDS.barnId}'),
                COALESCE(event.feederId, '${DEFAULT_RESOURCE_IDS.feederId}'),
                COALESCE(event.queueId, '${DEFAULT_RESOURCE_IDS.queueId}'),
                COALESCE(
                    event.message,
                    json_extract(providerEvent.rawMetadataJson, '$.message'),
                    ''
                ),
                CASE WHEN event.eventId IS NULL THEN 'PENDING' ELSE 'COMPLETED' END,
                contribution.createdAt,
                contribution.createdAt,
                event.requestedAt,
                event.requestedAt,
                CASE WHEN event.eventId IS NULL THEN NULL ELSE ${completedTimestamp} END,
                CASE WHEN event.eventId IS NULL THEN NULL ELSE ${completedTimestamp} END,
                NULL,
                NULL,
                CASE WHEN event.eventId IS NULL THEN 0 ELSE 1 END,
                COALESCE(event.updatedAt, contribution.updatedAt)
            FROM Contributions AS contribution
            JOIN ProviderEvents AS providerEvent
              ON providerEvent.providerEventId = contribution.providerEventId
            LEFT JOIN Events AS event
              ON event.contributionId = contribution.contributionId;

            INSERT INTO Outbox (
                outboxEntryId,
                feedIntentId,
                status,
                createdAt,
                availableAt,
                processingStartedAt,
                completedAt,
                failedAt,
                attemptCount,
                lastError,
                updatedAt
            )
            SELECT
                'outbox_legacy_' || feedIntentId,
                feedIntentId,
                status,
                createdAt,
                outboxQueuedAt,
                processingStartedAt,
                processingCompletedAt,
                processingFailedAt,
                attemptCount,
                failureReason,
                updatedAt
            FROM FeedIntents;

            UPDATE Events
            SET feedIntentId = 'feed_intent_legacy_' || contributionId;

            INSERT INTO FeedIntentHistory (
                feedIntentId,
                action,
                timestamp,
                detailsJson
            )
            SELECT feedIntentId, 'FEED_INTENT_CREATED', createdAt, 'null'
            FROM FeedIntents;

            INSERT INTO FeedIntentHistory (
                feedIntentId,
                action,
                timestamp,
                detailsJson
            )
            SELECT feedIntentId, 'OUTBOX_QUEUED', outboxQueuedAt, 'null'
            FROM FeedIntents;

            INSERT INTO FeedIntentHistory (
                feedIntentId,
                action,
                timestamp,
                detailsJson
            )
            SELECT feedIntentId, 'PROCESSING_STARTED', processingStartedAt, 'null'
            FROM FeedIntents
            WHERE processingStartedAt IS NOT NULL;

            INSERT INTO FeedIntentHistory (
                feedIntentId,
                action,
                timestamp,
                detailsJson
            )
            SELECT feedIntentId, 'FEED_REQUEST_CREATED', feedRequestCreatedAt, 'null'
            FROM FeedIntents
            WHERE feedRequestCreatedAt IS NOT NULL;

            INSERT INTO FeedIntentHistory (
                feedIntentId,
                action,
                timestamp,
                detailsJson
            )
            SELECT feedIntentId, 'QUEUE_INSERTION_COMPLETED', queueInsertionCompletedAt, 'null'
            FROM FeedIntents
            WHERE queueInsertionCompletedAt IS NOT NULL;

            INSERT INTO FeedIntentHistory (
                feedIntentId,
                action,
                timestamp,
                detailsJson
            )
            SELECT feedIntentId, 'PROCESSING_COMPLETED', processingCompletedAt, 'null'
            FROM FeedIntents
            WHERE processingCompletedAt IS NOT NULL;
        `);

        database.exec(`
            CREATE UNIQUE INDEX idx_events_feed_intent
                ON Events(feedIntentId);
            CREATE INDEX idx_feed_intents_status
                ON FeedIntents(status, createdAt);
            CREATE INDEX idx_feed_intents_resource
                ON FeedIntents(feederId, status, createdAt);
            CREATE INDEX idx_outbox_processable
                ON Outbox(status, availableAt, outboxSequence);
            CREATE INDEX idx_feed_intent_history
                ON FeedIntentHistory(feedIntentId, historySequence);

            CREATE TRIGGER events_validate_feed_intent_insert
            BEFORE INSERT ON Events
            BEGIN
                SELECT CASE
                    WHEN NEW.feedIntentId IS NULL
                    THEN RAISE(ABORT, 'Event feedIntentId is required')
                END;
                SELECT CASE
                    WHEN NOT EXISTS (
                        SELECT 1
                        FROM FeedIntents AS intent
                        WHERE intent.feedIntentId = NEW.feedIntentId
                          AND intent.contributionId = NEW.contributionId
                          AND intent.barnId = NEW.barnId
                          AND intent.feederId = NEW.feederId
                          AND intent.queueId = NEW.queueId
                          AND intent.status = 'PROCESSING'
                          AND EXISTS (
                              SELECT 1
                              FROM Outbox AS outbox
                              WHERE outbox.feedIntentId = intent.feedIntentId
                                AND outbox.status = 'PROCESSING'
                          )
                    )
                    THEN RAISE(ABORT, 'Event does not match its FeedIntent')
                END;
            END;

            CREATE TRIGGER events_validate_feed_intent_update
            BEFORE UPDATE OF feedIntentId, contributionId, barnId, feederId, queueId ON Events
            BEGIN
                SELECT CASE
                    WHEN NEW.feedIntentId IS NULL
                    THEN RAISE(ABORT, 'Event feedIntentId is required')
                END;
                SELECT CASE
                    WHEN NOT EXISTS (
                        SELECT 1
                        FROM FeedIntents AS intent
                        WHERE intent.feedIntentId = NEW.feedIntentId
                          AND intent.contributionId = NEW.contributionId
                          AND intent.barnId = NEW.barnId
                          AND intent.feederId = NEW.feederId
                          AND intent.queueId = NEW.queueId
                          AND intent.status = 'PROCESSING'
                          AND EXISTS (
                              SELECT 1
                              FROM Outbox AS outbox
                              WHERE outbox.feedIntentId = intent.feedIntentId
                                AND outbox.status = 'PROCESSING'
                          )
                    )
                    THEN RAISE(ABORT, 'Event does not match its FeedIntent')
                END;
            END;

            CREATE TRIGGER feed_intents_identity_immutable
            BEFORE UPDATE OF contributionId, barnId, feederId, queueId ON FeedIntents
            BEGIN
                SELECT RAISE(ABORT, 'FeedIntent identity and resource assignment are immutable');
            END;

            CREATE TRIGGER outbox_feed_intent_immutable
            BEFORE UPDATE OF feedIntentId ON Outbox
            BEGIN
                SELECT RAISE(ABORT, 'Outbox FeedIntent identity is immutable');
            END;
        `);
    }
});
