export const migration015SupporterAccounts = Object.freeze({
    version: 15,
    name: "supporter_accounts",
    up(database) {
        database.exec(`
            CREATE TABLE SupporterAccounts (
                accountId TEXT PRIMARY KEY,
                providerName TEXT NOT NULL,
                externalIdentityId TEXT NOT NULL,
                emailNormalized TEXT,
                emailVerified INTEGER NOT NULL CHECK (emailVerified IN (0, 1)),
                displayName TEXT,
                status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
                sessionsValidAfter TEXT NOT NULL,
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL,
                deletedAt TEXT,
                UNIQUE (providerName, externalIdentityId)
            ) STRICT;

            CREATE TABLE SupporterWalletLinks (
                linkId TEXT PRIMARY KEY,
                accountId TEXT NOT NULL,
                walletId TEXT NOT NULL,
                clientRequestId TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED')),
                linkedAt TEXT NOT NULL,
                releasedAt TEXT,
                releaseReason TEXT,
                FOREIGN KEY (accountId) REFERENCES SupporterAccounts(accountId)
                    ON DELETE RESTRICT,
                FOREIGN KEY (walletId) REFERENCES CreditWallets(walletId)
                    ON DELETE RESTRICT,
                UNIQUE (accountId, clientRequestId)
            ) STRICT;

            CREATE UNIQUE INDEX idx_supporter_wallet_links_active_wallet
                ON SupporterWalletLinks(walletId) WHERE status = 'ACTIVE';
            CREATE INDEX idx_supporter_wallet_links_account
                ON SupporterWalletLinks(accountId, status, linkedAt);

            CREATE TABLE SupporterSessions (
                providerSessionId TEXT PRIMARY KEY,
                accountId TEXT NOT NULL,
                authenticatedAt TEXT NOT NULL,
                lastSeenAt TEXT NOT NULL,
                revokedAt TEXT,
                FOREIGN KEY (accountId) REFERENCES SupporterAccounts(accountId)
                    ON DELETE RESTRICT
            ) STRICT;

            CREATE INDEX idx_supporter_sessions_account
                ON SupporterSessions(accountId, lastSeenAt DESC);

            CREATE TABLE SupporterAccountEvents (
                eventSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                eventId TEXT NOT NULL UNIQUE,
                accountId TEXT,
                walletId TEXT,
                eventType TEXT NOT NULL CHECK (eventType IN (
                    'ACCOUNT_CREATED', 'IDENTITY_REFRESHED',
                    'SESSION_AUTHENTICATED', 'SESSIONS_REVOKED',
                    'WALLET_LINKED', 'WALLET_LINK_REJECTED',
                    'ACCOUNT_SUSPENDED', 'ACCOUNT_RESTORED',
                    'ACCOUNT_DELETED', 'DATA_EXPORTED',
                    'ADMINISTRATOR_NOTE'
                )),
                actorType TEXT NOT NULL,
                actorReference TEXT,
                requestId TEXT,
                reason TEXT,
                metadataJson TEXT NOT NULL DEFAULT 'null',
                createdAt TEXT NOT NULL,
                FOREIGN KEY (accountId) REFERENCES SupporterAccounts(accountId)
                    ON DELETE RESTRICT,
                FOREIGN KEY (walletId) REFERENCES CreditWallets(walletId)
                    ON DELETE RESTRICT
            ) STRICT;

            CREATE INDEX idx_supporter_account_events_account
                ON SupporterAccountEvents(accountId, eventSequence DESC);
            CREATE INDEX idx_supporter_account_events_wallet
                ON SupporterAccountEvents(walletId, eventSequence DESC);

            CREATE TRIGGER supporter_account_events_append_only_update
            BEFORE UPDATE ON SupporterAccountEvents
            BEGIN
                SELECT RAISE(ABORT, 'SupporterAccountEvents are append-only');
            END;

            CREATE TRIGGER supporter_account_events_append_only_delete
            BEFORE DELETE ON SupporterAccountEvents
            BEGIN
                SELECT RAISE(ABORT, 'SupporterAccountEvents are append-only');
            END;
        `);
    }
});
