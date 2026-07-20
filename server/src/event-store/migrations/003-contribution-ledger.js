const providerTypes = [
    "WEBSITE",
    "STRIPE",
    "YOUTUBE",
    "TIKTOK",
    "FACEBOOK",
    "QR_CODE",
    "MANUAL_ADMIN",
    "CORPORATE_SPONSOR",
    "FUTURE_API"
].map(value => `'${value}'`).join(", ");

const auditActions = [
    "PROVIDER_EVENT_RECEIVED",
    "DUPLICATE_DETECTED",
    "VERIFICATION_PASSED",
    "VERIFICATION_FAILED",
    "CONTRIBUTION_CREATED",
    "CONTRIBUTION_REJECTED",
    "FEED_REQUEST_CREATED"
].map(value => `'${value}'`).join(", ");

export const migration003ContributionLedger = Object.freeze({
    version: 3,
    name: "contribution_ledger",
    up(database) {
        database.exec(`
            CREATE TABLE ProviderEvents (
                providerEventId TEXT PRIMARY KEY,
                provider TEXT NOT NULL CHECK (provider IN (${providerTypes})),
                externalEventId TEXT NOT NULL,
                receivedAt TEXT NOT NULL,
                verificationStatus TEXT NOT NULL
                    CHECK (verificationStatus IN ('PENDING', 'VERIFIED', 'REJECTED')),
                rawMetadataJson TEXT NOT NULL DEFAULT 'null',
                rejectionReason TEXT,
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL,
                UNIQUE (provider, externalEventId)
            ) STRICT;

            CREATE TABLE Contributions (
                contributionId TEXT PRIMARY KEY,
                providerEventId TEXT NOT NULL UNIQUE,
                verifiedAt TEXT NOT NULL,
                amountMinor INTEGER NOT NULL CHECK (amountMinor >= 0),
                currency TEXT NOT NULL CHECK (length(currency) = 3),
                supporterDisplayName TEXT NOT NULL,
                eligibilityStatus TEXT NOT NULL
                    CHECK (eligibilityStatus IN ('ELIGIBLE', 'INELIGIBLE')),
                feedQuantity INTEGER NOT NULL CHECK (feedQuantity >= 0),
                metadataJson TEXT NOT NULL DEFAULT 'null',
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL,
                FOREIGN KEY (providerEventId)
                    REFERENCES ProviderEvents(providerEventId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE AuditRecords (
                auditSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                auditRecordId TEXT NOT NULL UNIQUE,
                action TEXT NOT NULL CHECK (action IN (${auditActions})),
                providerEventId TEXT,
                contributionId TEXT,
                eventId TEXT,
                occurredAt TEXT NOT NULL,
                detailsJson TEXT NOT NULL DEFAULT 'null',
                FOREIGN KEY (providerEventId)
                    REFERENCES ProviderEvents(providerEventId) ON DELETE RESTRICT,
                FOREIGN KEY (contributionId)
                    REFERENCES Contributions(contributionId) ON DELETE RESTRICT,
                FOREIGN KEY (eventId) REFERENCES Events(eventId) ON DELETE RESTRICT
            ) STRICT;

            ALTER TABLE Events
                ADD COLUMN contributionId TEXT REFERENCES Contributions(contributionId);
        `);

        database.exec(`
            INSERT INTO ProviderEvents (
                providerEventId,
                provider,
                externalEventId,
                receivedAt,
                verificationStatus,
                rawMetadataJson,
                rejectionReason,
                createdAt,
                updatedAt
            )
            SELECT
                'provider_event_legacy_' || eventId,
                'WEBSITE',
                'legacy:' || eventId,
                requestedAt,
                'VERIFIED',
                '{"migration":"phase_6c"}',
                NULL,
                requestedAt,
                updatedAt
            FROM Events;

            INSERT INTO Contributions (
                contributionId,
                providerEventId,
                verifiedAt,
                amountMinor,
                currency,
                supporterDisplayName,
                eligibilityStatus,
                feedQuantity,
                metadataJson,
                createdAt,
                updatedAt
            )
            SELECT
                'contribution_legacy_' || eventId,
                'provider_event_legacy_' || eventId,
                requestedAt,
                0,
                'GBP',
                supporterName,
                'ELIGIBLE',
                1,
                '{"migration":"phase_6c"}',
                requestedAt,
                updatedAt
            FROM Events;

            UPDATE Events
            SET contributionId = 'contribution_legacy_' || eventId;

            INSERT INTO AuditRecords (
                auditRecordId,
                action,
                providerEventId,
                contributionId,
                eventId,
                occurredAt,
                detailsJson
            )
            SELECT
                'audit_legacy_provider_' || eventId,
                'PROVIDER_EVENT_RECEIVED',
                'provider_event_legacy_' || eventId,
                NULL,
                NULL,
                requestedAt,
                '{"migration":"phase_6c"}'
            FROM Events;

            INSERT INTO AuditRecords (
                auditRecordId,
                action,
                providerEventId,
                contributionId,
                eventId,
                occurredAt,
                detailsJson
            )
            SELECT
                'audit_legacy_verification_' || eventId,
                'VERIFICATION_PASSED',
                'provider_event_legacy_' || eventId,
                NULL,
                NULL,
                requestedAt,
                '{"migration":"phase_6c"}'
            FROM Events;

            INSERT INTO AuditRecords (
                auditRecordId,
                action,
                providerEventId,
                contributionId,
                eventId,
                occurredAt,
                detailsJson
            )
            SELECT
                'audit_legacy_contribution_' || eventId,
                'CONTRIBUTION_CREATED',
                'provider_event_legacy_' || eventId,
                'contribution_legacy_' || eventId,
                NULL,
                requestedAt,
                '{"migration":"phase_6c"}'
            FROM Events;

            INSERT INTO AuditRecords (
                auditRecordId,
                action,
                providerEventId,
                contributionId,
                eventId,
                occurredAt,
                detailsJson
            )
            SELECT
                'audit_legacy_feed_' || eventId,
                'FEED_REQUEST_CREATED',
                'provider_event_legacy_' || eventId,
                'contribution_legacy_' || eventId,
                eventId,
                requestedAt,
                '{"migration":"phase_6c"}'
            FROM Events;
        `);

        database.exec(`
            CREATE UNIQUE INDEX idx_events_contribution
                ON Events(contributionId);
            CREATE INDEX idx_provider_events_status
                ON ProviderEvents(verificationStatus, receivedAt);
            CREATE INDEX idx_contributions_eligibility
                ON Contributions(eligibilityStatus, verifiedAt);
            CREATE INDEX idx_audit_provider_event
                ON AuditRecords(providerEventId, auditSequence);
            CREATE INDEX idx_audit_contribution
                ON AuditRecords(contributionId, auditSequence);
            CREATE INDEX idx_audit_event
                ON AuditRecords(eventId, auditSequence);

            CREATE TRIGGER events_validate_contribution_insert
            BEFORE INSERT ON Events
            BEGIN
                SELECT CASE
                    WHEN NEW.contributionId IS NULL
                    THEN RAISE(ABORT, 'Event contributionId is required')
                END;
                SELECT CASE
                    WHEN NOT EXISTS (
                        SELECT 1
                        FROM Contributions AS contribution
                        JOIN ProviderEvents AS providerEvent
                          ON providerEvent.providerEventId = contribution.providerEventId
                        WHERE contribution.contributionId = NEW.contributionId
                          AND contribution.eligibilityStatus = 'ELIGIBLE'
                          AND contribution.feedQuantity > 0
                          AND providerEvent.verificationStatus = 'VERIFIED'
                    )
                    THEN RAISE(ABORT, 'Event requires a verified eligible Contribution')
                END;
            END;

            CREATE TRIGGER events_validate_contribution_update
            BEFORE UPDATE OF contributionId ON Events
            BEGIN
                SELECT CASE
                    WHEN NEW.contributionId IS NULL
                    THEN RAISE(ABORT, 'Event contributionId is required')
                END;
                SELECT CASE
                    WHEN NOT EXISTS (
                        SELECT 1
                        FROM Contributions AS contribution
                        JOIN ProviderEvents AS providerEvent
                          ON providerEvent.providerEventId = contribution.providerEventId
                        WHERE contribution.contributionId = NEW.contributionId
                          AND contribution.eligibilityStatus = 'ELIGIBLE'
                          AND contribution.feedQuantity > 0
                          AND providerEvent.verificationStatus = 'VERIFIED'
                    )
                    THEN RAISE(ABORT, 'Event requires a verified eligible Contribution')
                END;
            END;

            CREATE TRIGGER provider_events_identity_immutable
            BEFORE UPDATE OF provider, externalEventId ON ProviderEvents
            BEGIN
                SELECT RAISE(ABORT, 'Provider event identity is immutable');
            END;

            CREATE TRIGGER provider_events_verified_immutable
            BEFORE UPDATE OF verificationStatus ON ProviderEvents
            WHEN OLD.verificationStatus = 'VERIFIED'
             AND NEW.verificationStatus <> 'VERIFIED'
            BEGIN
                SELECT RAISE(ABORT, 'Verified ProviderEvent cannot be downgraded');
            END;

            CREATE TRIGGER contributions_provider_event_immutable
            BEFORE UPDATE OF providerEventId ON Contributions
            BEGIN
                SELECT RAISE(ABORT, 'Contribution providerEventId is immutable');
            END;

            CREATE TRIGGER contributions_feed_eligibility_immutable
            BEFORE UPDATE OF eligibilityStatus, feedQuantity ON Contributions
            WHEN EXISTS (
                SELECT 1 FROM Events WHERE contributionId = OLD.contributionId
            )
            BEGIN
                SELECT RAISE(ABORT, 'Used Contribution eligibility is immutable');
            END;
        `);
    }
});
