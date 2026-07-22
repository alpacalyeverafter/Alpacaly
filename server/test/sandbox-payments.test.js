import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import request from "supertest";
import Stripe from "stripe";

import { createApp } from "../src/app.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { createTestLogger, testConfig } from "./helpers.js";

const WEBHOOK_SECRET = "whsec_alpacaly_fixture";
const stripeFixtures = new Stripe("sk_test_alpacaly_fixture");

function fixture(name) {
    return JSON.parse(readFileSync(
        new URL(`./fixtures/stripe/${name}.json`, import.meta.url),
        "utf8"
    ));
}

function createPaymentTestApp(t, overrides = {}) {
    const logger = createTestLogger();
    const config = {
        ...testConfig,
        paymentSandboxEnabled: true,
        stripeTestSecretKey: "sk_test_alpacaly_fixture",
        stripeTestWebhookSecret: WEBHOOK_SECRET,
        ...overrides.config
    };
    let eventSequence = 0;
    let paymentSequence = 0;
    const checkoutCalls = [];
    const eventEngine = new EventEngine({
        config,
        logger,
        clock: overrides.clock || (() => new Date("2026-07-22T12:00:00.000Z")),
        idGenerator: () => `payment-event-${++eventSequence}`,
        sleep: async () => {},
        autoProcess: overrides.autoProcess ?? false
    });
    const checkoutSessionCreator = async (parameters, options) => {
        checkoutCalls.push({ parameters, options });
        const suffix = parameters.client_reference_id.replace(/[^A-Za-z0-9]/g, "");
        return {
            id: `cs_test_${suffix}`,
            url: `https://checkout.stripe.test/session/${suffix}`,
            livemode: false,
            status: "open"
        };
    };
    const app = createApp({
        config,
        logger,
        eventEngine,
        checkoutSessionCreator,
        paymentIdGenerator: () => `payment-${++paymentSequence}`
    });
    t.after(async () => {
        app.locals.contributionLedgerServices.outboxWorker.stop();
        await app.locals.deviceCommandServices.worker.stop();
        eventEngine.close();
    });
    return { app, eventEngine, checkoutCalls };
}

async function createCheckout(app, clientRequestId = "client-request-001") {
    const response = await request(app)
        .post("/api/payments/checkout-sessions")
        .send({
            supporterName: "Sandbox Supporter",
            clientRequestId,
            amountMinor: 500,
            currency: "GBP"
        })
        .expect(201);
    return response.body;
}

function completionEvent(checkout, suffix = "completed") {
    const event = fixture("checkout-session-completed");
    event.id = `evt_${suffix}_${Date.now()}`;
    event.created = Math.floor(Date.now() / 1000);
    event.data.object.id = checkout.paymentRequest.paymentRequestId
        ? `cs_test_${checkout.paymentRequest.paymentRequestId.replace(/[^A-Za-z0-9]/g, "")}`
        : event.data.object.id;
    event.data.object.client_reference_id = checkout.paymentRequest.paymentRequestId;
    event.data.object.metadata.alpacaly_payment_request_id =
        checkout.paymentRequest.paymentRequestId;
    event.data.object.payment_intent = `pi_test_${suffix}_${Date.now()}`;
    return event;
}

function statusEvent(name, checkout, suffix) {
    const event = fixture(name);
    event.id = `evt_${suffix}_${Date.now()}`;
    event.created = Math.floor(Date.now() / 1000);
    event.data.object.metadata = {
        ...(event.data.object.metadata || {}),
        alpacaly_payment_request_id: checkout.paymentRequest.paymentRequestId
    };
    if (String(event.data.object.id).startsWith("cs_")) {
        event.data.object.id = `cs_test_${checkout.paymentRequest.paymentRequestId.replace(
            /[^A-Za-z0-9]/g,
            ""
        )}`;
        event.data.object.client_reference_id = checkout.paymentRequest.paymentRequestId;
    }
    return event;
}

function signEvent(event, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
    const payload = JSON.stringify(event);
    const signature = stripeFixtures.webhooks.generateTestHeaderString({
        payload,
        secret: WEBHOOK_SECRET,
        timestamp
    });
    return { payload, signature };
}

function postWebhook(app, event, options = {}) {
    const signed = signEvent(event, options);
    return request(app)
        .post("/api/payments/webhooks/stripe")
        .set("content-type", "application/json")
        .set("stripe-signature", signed.signature)
        .send(signed.payload);
}

test("creates an idempotent server-side Stripe Test Mode Checkout Session", async t => {
    const { app, checkoutCalls } = createPaymentTestApp(t);
    const first = await createCheckout(app);
    const repeated = await request(app)
        .post("/api/payments/checkout-sessions")
        .send({
            supporterName: "Sandbox Supporter",
            clientRequestId: "client-request-001",
            amountMinor: 500,
            currency: "GBP"
        })
        .expect(200);

    assert.equal(first.sandbox, true);
    assert.match(first.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);
    assert.equal(repeated.body.duplicate, true);
    assert.equal(repeated.body.checkoutUrl, first.checkoutUrl);
    assert.equal(checkoutCalls.length, 1);
    assert.equal(checkoutCalls[0].parameters.mode, "payment");
    assert.equal(checkoutCalls[0].parameters.line_items[0].price_data.unit_amount, 500);
    assert.equal(checkoutCalls[0].parameters.line_items[0].price_data.currency, "gbp");
    assert.equal(
        checkoutCalls[0].parameters.metadata.alpacaly_payment_request_id,
        first.paymentRequest.paymentRequestId
    );
    assert.match(checkoutCalls[0].options.idempotencyKey, /^alpacaly-checkout-/);
    assert.match(first.welfareNotice, /not a guaranteed dispense/i);
});

test("signed completion creates ProviderEvent, Contribution, FeedIntent and Event once", async t => {
    const { app, eventEngine } = createPaymentTestApp(t);
    const checkout = await createCheckout(app, "client-request-flow");
    const event = completionEvent(checkout, "flow");
    await postWebhook(app, event).expect(200);

    const status = await request(app)
        .get(`/api/payments/requests/${checkout.paymentRequest.paymentRequestId}`)
        .expect(200);
    assert.equal(status.body.paymentRequest.status, "COMPLETED");
    assert.ok(status.body.paymentRequest.contribution.contributionId);
    assert.equal(status.body.paymentRequest.feedIntent.status, "COMPLETED");
    assert.equal(status.body.paymentRequest.event.state, "QUEUED");
    assert.equal(status.body.paymentRequest.event.queuePosition, 1);

    const storedPayment = eventEngine.eventStore.getPaymentRequest(
        checkout.paymentRequest.paymentRequestId
    );
    const providerEvent = eventEngine.eventStore.getProviderEvent(
        storedPayment.lastProviderEventId
    );
    assert.equal(providerEvent.provider, "STRIPE");
    assert.equal(providerEvent.verificationStatus, "VERIFIED");
    assert.equal(eventEngine.eventStore.getContribution(
        storedPayment.contributionId
    ).amountMinor, 500);
    assert.equal(eventEngine.getQueueSummary().length, 1);
    assert.equal(
        eventEngine.eventStore.database.prepare(
            "SELECT COUNT(*) AS count FROM DeviceCommands"
        ).get().count,
        0,
        "the payment provider must never create DeviceCommands"
    );
});

test("duplicate signed webhook delivery is provider-scoped and replay safe", async t => {
    const { app, eventEngine } = createPaymentTestApp(t);
    const checkout = await createCheckout(app, "client-request-replay");
    const event = completionEvent(checkout, "replay");
    await postWebhook(app, event).expect(200);
    const duplicate = await postWebhook(app, event).expect(200);

    assert.equal(duplicate.body.duplicate, true);
    for (const table of ["ProviderEvents", "Contributions", "FeedIntents", "Events"]) {
        assert.equal(
            eventEngine.eventStore.database.prepare(
                `SELECT COUNT(*) AS count FROM ${table}`
            ).get().count,
            1,
            `${table} must contain exactly one record`
        );
    }
});

test("bad and stale Stripe signatures are rejected before ingestion", async t => {
    const { app, eventEngine } = createPaymentTestApp(t);
    const checkout = await createCheckout(app, "client-request-signature");
    const event = completionEvent(checkout, "signature");
    await request(app)
        .post("/api/payments/webhooks/stripe")
        .set("content-type", "application/json")
        .set("stripe-signature", "t=1,v1=invalid")
        .send(JSON.stringify(event))
        .expect(400)
        .expect(response => {
            assert.match(response.body.error.code, /PAYMENT_WEBHOOK_/);
        });
    await postWebhook(app, event, {
        timestamp: Math.floor(Date.now() / 1000) - 301
    }).expect(400)
        .expect(response => {
            assert.equal(response.body.error.code, "PAYMENT_WEBHOOK_STALE");
        });
    assert.equal(
        eventEngine.eventStore.database.prepare(
            "SELECT COUNT(*) AS count FROM ProviderEvents"
        ).get().count,
        0
    );
});

test("amount, currency and metadata mismatches never create Contributions", async t => {
    const { app, eventEngine } = createPaymentTestApp(t);

    const amountCheckout = await createCheckout(app, "client-request-amount");
    const amountEvent = completionEvent(amountCheckout, "amount");
    amountEvent.data.object.amount_total = 499;
    await postWebhook(app, amountEvent).expect(200);

    const currencyCheckout = await createCheckout(app, "client-request-currency");
    const currencyEvent = completionEvent(currencyCheckout, "currency");
    currencyEvent.data.object.currency = "usd";
    await postWebhook(app, currencyEvent).expect(200);

    const metadataCheckout = await createCheckout(app, "client-request-metadata");
    const metadataEvent = completionEvent(metadataCheckout, "metadata");
    metadataEvent.data.object.metadata = {};
    await postWebhook(app, metadataEvent).expect(200);

    const payments = eventEngine.eventStore.listPaymentRequests({ limit: 10 });
    assert.equal(payments.find(item => item.clientRequestId === "client-request-amount").status, "FAILED");
    assert.equal(payments.find(item => item.clientRequestId === "client-request-currency").status, "FAILED");
    assert.equal(payments.find(item => item.clientRequestId === "client-request-metadata").status, "PENDING");
    assert.equal(
        eventEngine.eventStore.database.prepare(
            "SELECT COUNT(*) AS count FROM Contributions"
        ).get().count,
        0
    );
    assert.equal(
        eventEngine.eventStore.database.prepare(`
            SELECT COUNT(*) AS count FROM ProviderEvents
            WHERE verificationStatus = 'REJECTED'
        `).get().count,
        3
    );
});

test("failed and expired sandbox payments remain non-feeding status records", async t => {
    const { app } = createPaymentTestApp(t);
    const failedCheckout = await createCheckout(app, "client-request-failed");
    const failedEvent = statusEvent(
        "payment-intent-failed",
        failedCheckout,
        "failed"
    );
    failedEvent.data.object.id = "pi_test_failed";
    await postWebhook(app, failedEvent).expect(200);

    const expiredCheckout = await createCheckout(app, "client-request-expired");
    const expiredEvent = statusEvent(
        "checkout-session-expired",
        expiredCheckout,
        "expired"
    );
    await postWebhook(app, expiredEvent).expect(200);

    const failedStatus = await request(app).get(
        `/api/payments/requests/${failedCheckout.paymentRequest.paymentRequestId}`
    ).expect(200);
    const expiredStatus = await request(app).get(
        `/api/payments/requests/${expiredCheckout.paymentRequest.paymentRequestId}`
    ).expect(200);
    assert.equal(failedStatus.body.paymentRequest.status, "FAILED");
    assert.equal(expiredStatus.body.paymentRequest.status, "EXPIRED");
    assert.equal(failedStatus.body.paymentRequest.contribution, null);
    assert.equal(expiredStatus.body.paymentRequest.event, null);
});

test("refunds and disputes update payment status without directly touching hardware", async t => {
    const { app, eventEngine } = createPaymentTestApp(t);
    const refundedCheckout = await createCheckout(app, "client-request-refunded");
    const refundedCompletion = completionEvent(refundedCheckout, "refunded");
    await postWebhook(app, refundedCompletion).expect(200);
    const refundEvent = statusEvent(
        "charge-refunded",
        refundedCheckout,
        "refund"
    );
    refundEvent.data.object.payment_intent = refundedCompletion.data.object.payment_intent;
    await postWebhook(app, refundEvent).expect(200);

    const disputedCheckout = await createCheckout(app, "client-request-disputed");
    const disputedCompletion = completionEvent(disputedCheckout, "disputed");
    await postWebhook(app, disputedCompletion).expect(200);
    const disputeEvent = statusEvent(
        "charge-dispute-created",
        disputedCheckout,
        "dispute"
    );
    disputeEvent.data.object.payment_intent = disputedCompletion.data.object.payment_intent;
    await postWebhook(app, disputeEvent).expect(200);

    assert.equal(
        eventEngine.eventStore.getPaymentRequest(
            refundedCheckout.paymentRequest.paymentRequestId
        ).status,
        "REFUNDED"
    );
    assert.equal(
        eventEngine.eventStore.getPaymentRequest(
            disputedCheckout.paymentRequest.paymentRequestId
        ).status,
        "DISPUTED"
    );
    assert.equal(
        eventEngine.eventStore.database.prepare(
            "SELECT COUNT(*) AS count FROM DeviceCommands"
        ).get().count,
        0
    );
});

test("successful payment remains visible when the Event Engine rejects feeding", async t => {
    const { app } = createPaymentTestApp(t, {
        config: { maxDailyFeeds: 1 }
    });
    await request(app)
        .post("/api/development/website-contributions")
        .send({
            supporterName: "Existing safe feed",
            clientRequestId: "existing-feed-limit"
        })
        .expect(202);

    const checkout = await createCheckout(app, "client-request-blocked");
    await postWebhook(app, completionEvent(checkout, "blocked")).expect(200);
    const response = await request(app).get(
        `/api/payments/requests/${checkout.paymentRequest.paymentRequestId}`
    ).expect(200);

    assert.equal(response.body.paymentRequest.status, "COMPLETED");
    assert.equal(response.body.paymentRequest.feedIntent.status, "FAILED");
    assert.equal(response.body.paymentRequest.event, null);
    assert.equal(response.body.paymentRequest.feeding.status, "DELAYED");
    assert.match(response.body.paymentRequest.feeding.message, /safely delayed/i);
});

test("a later welfare cancellation remains visible and never starts a replacement", async t => {
    const { app, eventEngine } = createPaymentTestApp(t);
    const checkout = await createCheckout(app, "client-request-welfare-cancelled");
    await postWebhook(app, completionEvent(checkout, "welfare-cancelled")).expect(200);

    const stored = eventEngine.eventStore.getPaymentRequest(
        checkout.paymentRequest.paymentRequestId
    );
    eventEngine.cancelForWelfare(stored.eventId, {
        reason: "Supervised sandbox welfare hold"
    });

    const response = await request(app).get(
        `/api/payments/requests/${stored.paymentRequestId}`
    ).expect(200);
    assert.equal(response.body.paymentRequest.status, "COMPLETED");
    assert.equal(
        response.body.paymentRequest.event.state,
        "CANCELLED_FOR_WELFARE"
    );
    assert.equal(
        response.body.paymentRequest.feeding.status,
        "CANCELLED_FOR_WELFARE"
    );
    assert.match(
        response.body.paymentRequest.feeding.message,
        /cancelled by an animal-welfare control/i
    );
    assert.equal(
        eventEngine.eventStore.database.prepare(
            "SELECT COUNT(*) AS count FROM DeviceCommands"
        ).get().count,
        0,
        "welfare cancellation must not create a replacement DeviceCommand"
    );
});

test("administrator payment view links sandbox payment, ledger and queue records", async t => {
    const { app } = createPaymentTestApp(t);
    const checkout = await createCheckout(app, "client-request-admin");
    await postWebhook(app, completionEvent(checkout, "admin")).expect(200);

    const response = await request(app)
        .get("/api/admin/payments")
        .set("authorization", "Development local-admin")
        .expect(200);
    assert.equal(response.body.sandbox, true);
    assert.equal(response.body.paymentRequests.length, 1);
    const payment = response.body.paymentRequests[0];
    assert.equal(payment.supporterDisplayName, "Sandbox Supporter");
    assert.ok(payment.providerEventId);
    assert.ok(payment.contribution.contributionId);
    assert.ok(payment.feedIntent.feedIntentId);
    assert.ok(payment.event.eventId);
});

test("sandbox validation rejects client-controlled amount and production/live settings", async t => {
    const { app } = createPaymentTestApp(t);
    const mismatch = await request(app)
        .post("/api/payments/checkout-sessions")
        .send({
            supporterName: "Wrong amount",
            clientRequestId: "client-request-wrong-amount",
            amountMinor: 100,
            currency: "GBP"
        })
        .expect(400);
    assert.equal(mismatch.body.error.code, "PAYMENT_AMOUNT_MISMATCH");

    const logger = createTestLogger();
    const config = { ...testConfig, nodeEnv: "production", paymentSandboxEnabled: false };
    const eventEngine = new EventEngine({
        config,
        logger,
        sleep: async () => {},
        autoProcess: false
    });
    const productionApp = createApp({ config, logger, eventEngine });
    t.after(() => eventEngine.close());
    const disabled = await request(productionApp)
        .post("/api/payments/checkout-sessions")
        .send({
            supporterName: "Production attempt",
            clientRequestId: "client-request-production",
            amountMinor: 500,
            currency: "GBP"
        })
        .expect(403);
    assert.equal(disabled.body.error.code, "PAYMENT_SANDBOX_DISABLED");
});
