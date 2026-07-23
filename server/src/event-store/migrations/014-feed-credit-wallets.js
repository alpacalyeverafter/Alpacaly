export const migration014FeedCreditWallets = Object.freeze({
    version: 14,
    name: "feed_credit_wallets",
    up(database) {
        database.exec(`
            CREATE TABLE CreditWallets (
                walletId TEXT PRIMARY KEY,
                recoveryTokenHash TEXT NOT NULL UNIQUE,
                supporterDisplayName TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'LOCKED')),
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL,
                lastSeenAt TEXT NOT NULL
            ) STRICT;

            CREATE TABLE CreditPurchases (
                purchaseId TEXT PRIMARY KEY,
                walletId TEXT NOT NULL,
                paymentRequestId TEXT NOT NULL UNIQUE,
                packId TEXT NOT NULL CHECK (packId IN (
                    'feed_credit_1', 'feed_credit_3', 'feed_credit_5'
                )),
                credits INTEGER NOT NULL CHECK (credits IN (1, 3, 5)),
                amountMinor INTEGER NOT NULL CHECK (amountMinor IN (500, 1500, 2500)),
                currency TEXT NOT NULL CHECK (currency = 'GBP'),
                status TEXT NOT NULL CHECK (status IN (
                    'PENDING', 'CREDITED', 'REFUNDED', 'DISPUTED'
                )),
                creditedAt TEXT,
                adjustedCredits INTEGER NOT NULL DEFAULT 0 CHECK (adjustedCredits >= 0),
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL,
                FOREIGN KEY (walletId) REFERENCES CreditWallets(walletId) ON DELETE RESTRICT,
                FOREIGN KEY (paymentRequestId)
                    REFERENCES PaymentRequests(paymentRequestId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE CreditReservations (
                reservationId TEXT PRIMARY KEY,
                walletId TEXT NOT NULL,
                clientRequestId TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN (
                    'WAITING', 'YOUR_TURN', 'CONFIRMED', 'REDEEMED',
                    'RELEASED', 'OUTCOME_UNKNOWN'
                )),
                contributionId TEXT,
                feedIntentId TEXT,
                eventId TEXT,
                expiresAt TEXT NOT NULL,
                turnStartedAt TEXT,
                confirmationExpiresAt TEXT,
                confirmedAt TEXT,
                redeemedAt TEXT,
                releasedAt TEXT,
                releaseReason TEXT,
                lastHeartbeatAt TEXT NOT NULL,
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL,
                UNIQUE (walletId, clientRequestId),
                UNIQUE (contributionId),
                UNIQUE (feedIntentId),
                UNIQUE (eventId),
                FOREIGN KEY (walletId) REFERENCES CreditWallets(walletId) ON DELETE RESTRICT,
                FOREIGN KEY (contributionId)
                    REFERENCES Contributions(contributionId) ON DELETE RESTRICT,
                FOREIGN KEY (feedIntentId)
                    REFERENCES FeedIntents(feedIntentId) ON DELETE RESTRICT,
                FOREIGN KEY (eventId) REFERENCES Events(eventId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE CreditLedgerEntries (
                ledgerSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                ledgerEntryId TEXT NOT NULL UNIQUE,
                walletId TEXT NOT NULL,
                entryType TEXT NOT NULL CHECK (entryType IN (
                    'PURCHASE', 'RESERVATION', 'REDEMPTION', 'RELEASE',
                    'REFUND_ADJUSTMENT', 'ADMIN_CORRECTION'
                )),
                availableDelta INTEGER NOT NULL,
                reservedDelta INTEGER NOT NULL,
                spentDelta INTEGER NOT NULL,
                paymentRequestId TEXT,
                reservationId TEXT,
                eventId TEXT,
                idempotencyKey TEXT NOT NULL UNIQUE,
                reason TEXT,
                metadataJson TEXT NOT NULL DEFAULT 'null',
                createdAt TEXT NOT NULL,
                FOREIGN KEY (walletId) REFERENCES CreditWallets(walletId) ON DELETE RESTRICT,
                FOREIGN KEY (paymentRequestId)
                    REFERENCES PaymentRequests(paymentRequestId) ON DELETE RESTRICT,
                FOREIGN KEY (reservationId)
                    REFERENCES CreditReservations(reservationId) ON DELETE RESTRICT,
                FOREIGN KEY (eventId) REFERENCES Events(eventId) ON DELETE RESTRICT
            ) STRICT;

            CREATE INDEX idx_credit_wallets_seen
                ON CreditWallets(lastSeenAt DESC);
            CREATE INDEX idx_credit_purchases_wallet
                ON CreditPurchases(walletId, createdAt DESC);
            CREATE INDEX idx_credit_reservations_wallet
                ON CreditReservations(walletId, createdAt DESC);
            CREATE INDEX idx_credit_reservations_active
                ON CreditReservations(status, expiresAt, confirmationExpiresAt);
            CREATE INDEX idx_credit_ledger_wallet
                ON CreditLedgerEntries(walletId, ledgerSequence);

            CREATE TRIGGER credit_ledger_entries_append_only_update
            BEFORE UPDATE ON CreditLedgerEntries
            BEGIN
                SELECT RAISE(ABORT, 'CreditLedgerEntries are append-only');
            END;

            CREATE TRIGGER credit_ledger_entries_append_only_delete
            BEFORE DELETE ON CreditLedgerEntries
            BEGIN
                SELECT RAISE(ABORT, 'CreditLedgerEntries are append-only');
            END;
        `);
    }
});
