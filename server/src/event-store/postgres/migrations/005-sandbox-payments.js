export const migration005SandboxPayments = Object.freeze({
    version: 5,
    name: "sandbox_payments",
    sql: `
        CREATE TABLE PaymentRequests (
            paymentRequestId TEXT PRIMARY KEY,
            provider TEXT NOT NULL CHECK (provider = 'STRIPE'),
            mode TEXT NOT NULL CHECK (mode = 'TEST'),
            clientRequestId TEXT NOT NULL,
            checkoutSessionId TEXT UNIQUE,
            checkoutUrl TEXT,
            paymentIntentId TEXT,
            supporterDisplayName TEXT NOT NULL,
            amountMinor BIGINT NOT NULL CHECK (amountMinor > 0),
            currency TEXT NOT NULL CHECK (length(currency) = 3),
            status TEXT NOT NULL CHECK (status IN (
                'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED',
                'REFUNDED', 'DISPUTED'
            )),
            providerStatus TEXT NOT NULL,
            failureCode TEXT,
            lastProviderEventId TEXT REFERENCES ProviderEvents(providerEventId),
            contributionId TEXT REFERENCES Contributions(contributionId),
            feedIntentId TEXT REFERENCES FeedIntents(feedIntentId),
            eventId TEXT REFERENCES Events(eventId),
            createdAt TIMESTAMPTZ NOT NULL,
            updatedAt TIMESTAMPTZ NOT NULL,
            completedAt TIMESTAMPTZ,
            UNIQUE (provider, clientRequestId)
        );

        CREATE INDEX idx_payment_requests_created
            ON PaymentRequests(createdAt DESC, paymentRequestId DESC);
        CREATE INDEX idx_payment_requests_payment_intent
            ON PaymentRequests(provider, paymentIntentId);
        CREATE INDEX idx_payment_requests_status
            ON PaymentRequests(status, updatedAt DESC);
    `
});
