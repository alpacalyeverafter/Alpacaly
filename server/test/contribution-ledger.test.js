import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createContributionLedgerServices } from "../src/contribution-ledger/index.js";
import { PROVIDER_TYPES } from "../src/domain/contributions.js";
import { DEFAULT_RESOURCE_IDS } from "../src/domain/resources.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { migration001InitialSchema } from "../src/event-store/migrations/001-initial-schema.js";
import { migration002ResourceModel } from "../src/event-store/migrations/002-resource-model.js";
import { SqliteEventStore } from "../src/event-store/sqlite-event-store.js";
import { createTestLogger, testConfig } from "./helpers.js";

const TEST_TIME = "2026-07-19T12:00:00.000Z";

function createLedgerContext(overrides = {}) {
    const logger = createTestLogger();
    const eventStore = new SqliteEventStore({
        databasePath: overrides.databasePath || ":memory:",
        logger
    });
    let nextEventId = 0;
    const eventEngine = new EventEngine({
        config: { ...testConfig, ...overrides.config },
        logger,
        eventStore,
        clock: () => new Date(TEST_TIME),
        idGenerator: () => `ledger-event-${++nextEventId}`,
        sleep: async () => {},
        autoProcess: overrides.autoProcess ?? false
    });
    const services = createContributionLedgerServices({
        eventEngine,
        eventStore,
        logger,
        clock: () => new Date(TEST_TIME)
    });
    return { eventStore, eventEngine, ...services };
}

function verifyEligible(context, providerEventId, overrides = {}) {
    return context.contributionVerificationService.verify(providerEventId, {
        verified: true,
        eligible: true,
        amountMinor: 500,
        currency: "GBP",
        supporterDisplayName: "Ledger Supporter",
        feedQuantity: 1,
        ...overrides
    });
}

function temporaryDatabase(t) {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-ledger-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return join(directory, "events.sqlite");
}

test("defines the provider-neutral domain without connecting providers", () => {
    assert.deepEqual(PROVIDER_TYPES, [
        "WEBSITE",
        "STRIPE",
        "YOUTUBE",
        "TIKTOK",
        "FACEBOOK",
        "QR_CODE",
        "MANUAL_ADMIN",
        "CORPORATE_SPONSOR",
        "FUTURE_API"
    ]);
});

test("deduplicates ProviderEvents by provider and externalEventId", () => {
    const context = createLedgerContext();
    const first = context.providerEventIngestionService.ingest({
        provider: "WEBSITE",
        externalEventId: "website-event-1",
        rawMetadata: { source: "test" }
    });
    const duplicate = context.providerEventIngestionService.ingest({
        provider: "WEBSITE",
        externalEventId: "website-event-1",
        rawMetadata: { source: "duplicate" }
    });

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.providerEvent.providerEventId, first.providerEvent.providerEventId);
    assert.deepEqual(
        context.eventStore.getAuditRecords({
            providerEventId: first.providerEvent.providerEventId
        }).map(record => record.action).sort(),
        ["DUPLICATE_DETECTED", "PROVIDER_EVENT_RECEIVED"].sort()
    );

    context.eventEngine.close();
});

test("scopes external event idempotency to each provider", () => {
    const context = createLedgerContext();
    const website = context.providerEventIngestionService.ingest({
        provider: "WEBSITE",
        externalEventId: "shared-external-id"
    });
    const stripe = context.providerEventIngestionService.ingest({
        provider: "STRIPE",
        externalEventId: "shared-external-id"
    });

    assert.notEqual(website.providerEvent.providerEventId, stripe.providerEvent.providerEventId);
    assert.equal(website.duplicate, false);
    assert.equal(stripe.duplicate, false);
    const websiteVerification = verifyEligible(
        context,
        website.providerEvent.providerEventId
    );
    const stripeVerification = verifyEligible(
        context,
        stripe.providerEvent.providerEventId
    );
    const websiteFeed = context.outboxWorker.processFeedIntent(
        websiteVerification.feedIntent.feedIntentId
    );
    const stripeFeed = context.outboxWorker.processFeedIntent(
        stripeVerification.feedIntent.feedIntentId
    );
    assert.notEqual(websiteFeed.feedRequest.eventId, stripeFeed.feedRequest.eventId);
    assert.equal(context.eventEngine.getQueueSummary().length, 2);

    context.eventEngine.close();
});

test("creates at most one Contribution for a verified ProviderEvent", () => {
    const context = createLedgerContext();
    const ingestion = context.providerEventIngestionService.ingest({
        provider: "FUTURE_API",
        externalEventId: "verified-once"
    });
    const first = verifyEligible(context, ingestion.providerEvent.providerEventId);
    const repeated = verifyEligible(context, ingestion.providerEvent.providerEventId);

    assert.equal(first.created, true);
    assert.equal(first.contribution.amountMinor, 500);
    assert.equal(first.contribution.currency, "GBP");
    assert.equal(first.contribution.eligibilityStatus, "ELIGIBLE");
    assert.equal(first.feedIntent.contributionId, first.contribution.contributionId);
    assert.equal(repeated.created, false);
    assert.equal(repeated.contribution.contributionId, first.contribution.contributionId);

    context.eventEngine.close();
});

test("records rejected and ineligible ProviderEvents without Contributions", () => {
    const context = createLedgerContext();
    const rejectedEvent = context.providerEventIngestionService.ingest({
        provider: "MANUAL_ADMIN",
        externalEventId: "rejected-event"
    }).providerEvent;
    const rejected = context.contributionVerificationService.verify(
        rejectedEvent.providerEventId,
        { verified: false, rejectionReason: "INVALID_TEST_EVENT" }
    );
    assert.equal(rejected.contribution, null);
    assert.equal(rejected.providerEvent.verificationStatus, "REJECTED");
    assert.equal(rejected.providerEvent.rejectionReason, "INVALID_TEST_EVENT");

    const ineligibleEvent = context.providerEventIngestionService.ingest({
        provider: "CORPORATE_SPONSOR",
        externalEventId: "ineligible-event"
    }).providerEvent;
    const ineligible = context.contributionVerificationService.verify(
        ineligibleEvent.providerEventId,
        { verified: true, eligible: false, rejectionReason: "NO_FEED_BENEFIT" }
    );
    assert.equal(ineligible.contribution, null);
    assert.equal(ineligible.providerEvent.verificationStatus, "VERIFIED");
    assert.equal(
        context.eventStore.getContributionByProviderEvent(ineligibleEvent.providerEventId),
        null
    );
    assert.deepEqual(
        new Set(context.eventStore.getAuditRecords({
            providerEventId: rejectedEvent.providerEventId
        }).map(record => record.action)),
        new Set([
            "PROVIDER_EVENT_RECEIVED",
            "VERIFICATION_FAILED",
            "CONTRIBUTION_REJECTED"
        ])
    );

    context.eventEngine.close();
});

test("creates Feed Requests only from verified eligible Contributions", () => {
    const context = createLedgerContext();
    const verifiedEvent = context.providerEventIngestionService.ingest({
        provider: "QR_CODE",
        externalEventId: "eligible-feed"
    }).providerEvent;
    const verified = verifyEligible(context, verifiedEvent.providerEventId);
    const created = context.outboxWorker.processFeedIntent(
        verified.feedIntent.feedIntentId
    );
    const repeated = context.outboxWorker.processFeedIntent(
        verified.feedIntent.feedIntentId
    );

    assert.equal(created.created, true);
    assert.equal(created.feedRequest.contributionId, verified.contribution.contributionId);
    assert.equal(repeated.created, false);
    assert.equal(repeated.feedRequest.eventId, created.feedRequest.eventId);
    assert.equal(context.eventEngine.getQueueSummary().length, 1);

    context.eventEngine.close();
});

test("rejects unverified and ineligible Contribution records", () => {
    const context = createLedgerContext();
    const pendingEvent = context.providerEventIngestionService.ingest({
        provider: "FACEBOOK",
        externalEventId: "pending-contribution"
    }).providerEvent;
    context.eventStore.database.prepare(`
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "contribution_unverified_test",
        pendingEvent.providerEventId,
        TEST_TIME,
        100,
        "GBP",
        "Unverified Supporter",
        "ELIGIBLE",
        1,
        "null",
        TEST_TIME,
        TEST_TIME
    );

    assert.throws(
        () => context.feedIntentService.ensureForContribution(
            "contribution_unverified_test"
        ),
        error => error.code === "CONTRIBUTION_NOT_VERIFIED"
    );

    context.eventStore.database.prepare(`
        UPDATE ProviderEvents SET verificationStatus = 'VERIFIED' WHERE providerEventId = ?
    `).run(pendingEvent.providerEventId);
    context.eventStore.database.prepare(`
        UPDATE Contributions SET eligibilityStatus = 'INELIGIBLE' WHERE contributionId = ?
    `).run("contribution_unverified_test");
    assert.throws(
        () => context.feedIntentService.ensureForContribution(
            "contribution_unverified_test"
        ),
        error => error.code === "CONTRIBUTION_NOT_ELIGIBLE"
    );
    assert.equal(context.eventEngine.getQueueSummary().length, 0);

    context.eventEngine.close();
});

test("rejects client-controlled trust decisions in website simulation", () => {
    const context = createLedgerContext();
    assert.throws(
        () => context.developmentWebsiteContributionService.simulate({
            supporterName: "Untrusted client",
            clientRequestId: "client-verification",
            verificationStatus: "VERIFIED"
        }),
        error => error.code === "CLIENT_VERIFICATION_FORBIDDEN"
            && error.details.field === "verificationStatus"
    );
    assert.equal(context.eventEngine.getQueueSummary().length, 0);

    context.eventEngine.close();
});

test("persists ledger idempotency, Contribution links and audit history across restart", t => {
    const databasePath = temporaryDatabase(t);
    const first = createLedgerContext({ databasePath });
    const initial = first.developmentWebsiteContributionService.simulate({
        supporterName: "Restart Ledger Supporter",
        clientRequestId: "restart-ledger-event",
        amountMinor: 1250,
        currency: "GBP"
    });
    const eventId = initial.feedRequest.eventId;
    const providerEventId = initial.providerEvent.providerEventId;
    const contributionId = initial.contribution.contributionId;
    first.eventEngine.close();

    const restored = createLedgerContext({ databasePath });
    const duplicate = restored.developmentWebsiteContributionService.simulate({
        supporterName: "Restart Ledger Supporter",
        clientRequestId: "restart-ledger-event",
        amountMinor: 1250,
        currency: "GBP"
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.providerEvent.providerEventId, providerEventId);
    assert.equal(duplicate.contribution.contributionId, contributionId);
    assert.equal(duplicate.feedRequest.eventId, eventId);
    assert.equal(restored.eventEngine.getQueueSummary().length, 1);
    assert.equal(restored.eventEngine.getFeedRequest(eventId).contributionId, contributionId);
    assert.deepEqual(
        new Set(restored.eventStore.getAuditRecords({ providerEventId })
            .map(record => record.action)),
        new Set([
            "PROVIDER_EVENT_RECEIVED",
            "DUPLICATE_DETECTED",
            "VERIFICATION_PASSED",
            "CONTRIBUTION_CREATED",
            "FEED_REQUEST_CREATED"
        ])
    );
    assert.equal(restored.eventStore.getSchemaVersion(), 4);

    restored.eventEngine.close();
});

test("migrates the Phase 6B schema without changing persisted Event data", t => {
    const databasePath = temporaryDatabase(t);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("PRAGMA foreign_keys = ON;");
    migration001InitialSchema.up(legacy);
    migration002ResourceModel.up(legacy);
    legacy.exec("PRAGMA user_version = 2;");
    legacy.prepare(`
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
            currentState,
            barnId,
            feederId,
            queueId
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "feed_phase_6b",
        "FEED_REQUEST",
        17,
        "Phase 6B Supporter",
        "website",
        "Preserved message",
        "phase-6b-client",
        TEST_TIME,
        TEST_TIME,
        "QUEUED",
        DEFAULT_RESOURCE_IDS.barnId,
        DEFAULT_RESOURCE_IDS.feederId,
        DEFAULT_RESOURCE_IDS.queueId
    );
    ["RECEIVED", "VALIDATED", "QUEUED"].forEach((state, index) => {
        legacy.prepare(`
            INSERT INTO LifecycleHistory (
                eventId,
                ordinal,
                state,
                timestamp,
                detailsJson
            ) VALUES (?, ?, ?, ?, ?)
        `).run("feed_phase_6b", index + 1, state, TEST_TIME, "null");
    });
    legacy.prepare(`
        INSERT INTO Queue (eventId, queueId, queuePosition, enqueuedAt)
        VALUES (?, ?, ?, ?)
    `).run("feed_phase_6b", DEFAULT_RESOURCE_IDS.queueId, 12, TEST_TIME);
    legacy.close();

    const migrated = createLedgerContext({ databasePath });
    const feedRequest = migrated.eventEngine.getFeedRequest("feed_phase_6b");
    assert.equal(feedRequest.eventId, "feed_phase_6b");
    assert.equal(feedRequest.sequenceNumber, 17);
    assert.equal(feedRequest.barnId, DEFAULT_RESOURCE_IDS.barnId);
    assert.equal(feedRequest.queueId, DEFAULT_RESOURCE_IDS.queueId);
    assert.deepEqual(
        feedRequest.timeline.map(entry => entry.state),
        ["RECEIVED", "VALIDATED", "QUEUED"]
    );
    assert.equal(
        migrated.eventStore.getQueueEntries(DEFAULT_RESOURCE_IDS.queueId)[0].queuePosition,
        12
    );
    const contribution = migrated.eventStore.getContribution(feedRequest.contributionId);
    assert.equal(contribution.supporterDisplayName, "Phase 6B Supporter");
    assert.equal(
        migrated.eventStore.getProviderEvent(contribution.providerEventId).verificationStatus,
        "VERIFIED"
    );
    assert.equal(migrated.eventStore.getSchemaVersion(), 4);
    assert.deepEqual(
        migrated.eventStore.database.prepare("PRAGMA foreign_key_check;").all(),
        []
    );

    migrated.eventEngine.close();
});
