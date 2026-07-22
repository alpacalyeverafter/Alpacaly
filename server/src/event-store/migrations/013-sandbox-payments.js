export const migration013SandboxPayments = Object.freeze({
    version: 13,
    name: "sandbox_payments",
    up(database) {
        database.exec(`
            CREATE TABLE PaymentRequests (
                paymentRequestId TEXT PRIMARY KEY,
                provider TEXT NOT NULL CHECK (provider = 'STRIPE'),
                mode TEXT NOT NULL CHECK (mode = 'TEST'),
                clientRequestId TEXT NOT NULL,
                checkoutSessionId TEXT UNIQUE,
                checkoutUrl TEXT,
                paymentIntentId TEXT,
                supporterDisplayName TEXT NOT NULL,
                amountMinor INTEGER NOT NULL CHECK (amountMinor > 0),
                currency TEXT NOT NULL CHECK (length(currency) = 3),
                status TEXT NOT NULL CHECK (status IN (
                    'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED',
                    'REFUNDED', 'DISPUTED'
                )),
                providerStatus TEXT NOT NULL,
                failureCode TEXT,
                lastProviderEventId TEXT,
                contributionId TEXT,
                feedIntentId TEXT,
                eventId TEXT,
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL,
                completedAt TEXT,
                UNIQUE (provider, clientRequestId),
                FOREIGN KEY (lastProviderEventId)
                    REFERENCES ProviderEvents(providerEventId) ON DELETE RESTRICT,
                FOREIGN KEY (contributionId)
                    REFERENCES Contributions(contributionId) ON DELETE RESTRICT,
                FOREIGN KEY (feedIntentId)
                    REFERENCES FeedIntents(feedIntentId) ON DELETE RESTRICT,
                FOREIGN KEY (eventId)
                    REFERENCES Events(eventId) ON DELETE RESTRICT
            ) STRICT;

            CREATE INDEX idx_payment_requests_created
                ON PaymentRequests(createdAt DESC, paymentRequestId DESC);
            CREATE INDEX idx_payment_requests_payment_intent
                ON PaymentRequests(provider, paymentIntentId);
            CREATE INDEX idx_payment_requests_status
                ON PaymentRequests(status, updatedAt DESC);
        `);
    }
});
