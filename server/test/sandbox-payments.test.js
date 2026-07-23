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
        feedCreditReconciliationIntervalMs: 60_000,
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
        app.locals.feedCreditServices.service.stop();
        app.locals.contributionLedgerServices.outboxWorker.stop();
        await app.locals.deviceCommandServices.worker.stop();
        eventEngine.close();
    });
    return { app, eventEngine, checkoutCalls };
}

async function createWallet(app, supporterName = "Sandbox Supporter") {
    const response = await request(app)
        .post("/api/feed-credits/wallets")
        .send({ supporterName })
        .expect(201);
    return {
        token: response.body.recoveryToken,
        wallet: response.body.wallet
    };
}

function walletAuthorization(token) {
    return `Wallet ${token}`;
}

async function createCheckout(
    app,
    wallet,
    clientRequestId = "client-request-001",
    packId = "feed_credit_1"
) {
    const response = await request(app)
        .post("/api/feed-credits/checkout-sessions")
        .set("authorization", walletAuthorization(wallet.token))
        .send({ clientRequestId, packId })
        .expect(201);
    return response.body;
}

function completionEvent(checkout, suffix = "completed") {
    const event = fixture("checkout-session-completed");
    event.id = `evt_${suffix}_${Date.now()}`;
    event.created = Math.floor(Date.now() / 1000);
    event.data.object.id = `cs_test_${checkout.paymentRequest.paymentRequestId.replace(
        /[^A-Za-z0-9]/g,
        ""
    )}`;
    event.data.object.client_reference_id = checkout.paymentRequest.paymentRequestId;
    event.data.object.metadata.alpacaly_payment_request_id =
        checkout.paymentRequest.paymentRequestId;
    event.data.object.payment_intent = `pi_test_${suffix}_${Date.now()}`;
    event.data.object.amount_total = checkout.paymentRequest.amountMinor;
    event.data.object.currency = checkout.paymentRequest.currency.toLowerCase();
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

async function getWallet(app, wallet) {
    return request(app)
        .get("/api/feed-credits/wallet")
        .set("authorization", walletAuthorization(wallet.token))
        .expect(200);
}

async function getPayment(app, wallet, paymentRequestId) {
    return request(app)
        .get(`/api/payments/requests/${paymentRequestId}`)
        .set("authorization", walletAuthorization(wallet.token))
        .expect(200);
}

test("creates an idempotent server-calculated Stripe Test Mode credit checkout", async t => {
    const { app, checkoutCalls } = createPaymentTestApp(t);
    const wallet = await createWallet(app);
    const first = await createCheckout(app, wallet);
    const repeated = await request(app)
        .post("/api/feed-credits/checkout-sessions")
        .set("authorization", walletAuthorization(wallet.token))
        .send({ clientRequestId: "client-request-001", packId: "feed_credit_1" })
        .expect(200);

    assert.equal(first.sandbox, true);
    assert.match(first.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);
    assert.equal(repeated.body.duplicate, true);
    assert.equal(repeated.body.checkoutUrl, first.checkoutUrl);
    assert.equal(checkoutCalls.length, 1);
    assert.equal(checkoutCalls[0].parameters.mode, "payment");
    assert.equal(checkoutCalls[0].parameters.line_items[0].price_data.unit_amount, 500);
    assert.equal(checkoutCalls[0].parameters.line_items[0].price_data.currency, "gbp");
    assert.match(checkoutCalls[0].parameters.line_items[0].price_data.product_data.name, /Feed Credit/i);
    assert.match(first.notice, /never starts a countdown or feed/i);
});

test("verified checkout credits the wallet and never starts a feed", async t => {
    const { app, eventEngine } = createPaymentTestApp(t);
    const wallet = await createWallet(app);
    const checkout = await createCheckout(app, wallet, "client-request-flow");
    await postWebhook(app, completionEvent(checkout, "flow")).expect(200);

    const status = await getPayment(
        app,
        wallet,
        checkout.paymentRequest.paymentRequestId
    );
    assert.equal(status.body.paymentRequest.status, "COMPLETED");
    assert.equal(status.body.paymentRequest.creditPurchase.status, "CREDITED");
    assert.equal(status.body.paymentRequest.creditPurchase.credits, 1);
    assert.deepEqual(status.body.paymentRequest.walletBalance, {
        available: 1,
        reserved: 0,
        spent: 0
    });
    assert.equal(status.body.paymentRequest.contribution, null);
    assert.equal(status.body.paymentRequest.feedIntent, null);
    assert.equal(status.body.paymentRequest.event, null);
    assert.equal(status.body.paymentRequest.feeding.status, "CREDITS_ADDED");

    for (const table of ["Contributions", "FeedIntents", "Events", "DeviceCommands"]) {
        assert.equal(
            eventEngine.eventStore.database.prepare(
                `SELECT COUNT(*) AS count FROM ${table}`
            ).get().count,
            0,
            `checkout completion must not create ${table}`
        );
    }
});

test("duplicate completion webhook credits exactly once", async t => {
    const { app, eventEngine } = createPaymentTestApp(t);
    const wallet = await createWallet(app);
    const checkout = await createCheckout(app, wallet, "client-request-replay");
    const event = completionEvent(checkout, "replay");
    await postWebhook(app, event).expect(200);
    const duplicate = await postWebhook(app, event).expect(200);

    assert.equal(duplicate.body.duplicate, true);
    assert.equal(
        eventEngine.eventStore.database.prepare(
            "SELECT COUNT(*) AS count FROM ProviderEvents"
        ).get().count,
        1
    );
    assert.equal(
        eventEngine.eventStore.database.prepare(
            "SELECT COUNT(*) AS count FROM CreditPurchases"
        ).get().count,
        1
    );
    assert.equal(
        eventEngine.eventStore.database.prepare(
            "SELECT COUNT(*) AS count FROM CreditLedgerEntries WHERE entryType = 'PURCHASE'"
        ).get().count,
        1
    );
    assert.equal((await getWallet(app, wallet)).body.wallet.balance.available, 1);
});

test("bad and stale Stripe signatures are rejected before ingestion", async t => {
    const { app, eventEngine } = createPaymentTestApp(t);
    const wallet = await createWallet(app);
    const checkout = await createCheckout(app, wallet, "client-request-signature");
    const event = completionEvent(checkout, "signature");
    await request(app)
        .post("/api/payments/webhooks/stripe")
        .set("content-type", "application/json")
        .set("stripe-signature", "t=1,v1=invalid")
        .send(JSON.stringify(event))
        .expect(400);
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

test("live-mode and unlisted Stripe events are rejected", async t => {
    const { app, eventEngine } = createPaymentTestApp(t);
    const wallet = await createWallet(app);
    const checkout = await createCheckout(app, wallet, "client-request-live-event");
    const live = completionEvent(checkout, "live-event");
    live.livemode = true;
    const liveResponse = await postWebhook(app, live).expect(400);
    assert.equal(liveResponse.body.error.code, "LIVE_PAYMENT_EVENT_REJECTED");

    const unlisted = completionEvent(checkout, "unlisted-event");
    unlisted.type = "customer.created";
    const unlistedResponse = await postWebhook(app, unlisted).expect(400);
    assert.equal(unlistedResponse.body.error.code, "PAYMENT_EVENT_NOT_ALLOWED");
    assert.equal(
        eventEngine.eventStore.database.prepare(
            "SELECT COUNT(*) AS count FROM ProviderEvents"
        ).get().count,
        0
    );
});

test("amount, currency and metadata mismatches never add credits", async t => {
    const { app, eventEngine } = createPaymentTestApp(t);
    const wallet = await createWallet(app);

    const amountCheckout = await createCheckout(app, wallet, "client-request-amount");
    const amountEvent = completionEvent(amountCheckout, "amount");
    amountEvent.data.object.amount_total = 499;
    await postWebhook(app, amountEvent).expect(200);

    const currencyCheckout = await createCheckout(app, wallet, "client-request-currency");
    const currencyEvent = completionEvent(currencyCheckout, "currency");
    currencyEvent.data.object.currency = "usd";
    await postWebhook(app, currencyEvent).expect(200);

    const metadataCheckout = await createCheckout(app, wallet, "client-request-metadata");
    const metadataEvent = completionEvent(metadataCheckout, "metadata");
    metadataEvent.data.object.metadata = {};
    await postWebhook(app, metadataEvent).expect(200);

    assert.equal((await getWallet(app, wallet)).body.wallet.balance.available, 0);
    assert.equal(
        eventEngine.eventStore.database.prepare(`
            SELECT COUNT(*) AS count FROM CreditLedgerEntries
            WHERE entryType = 'PURCHASE'
        `).get().count,
        0
    );
});

test("failed and expired payments add no Feed Credits", async t => {
    const { app } = createPaymentTestApp(t);
    const failedWallet = await createWallet(app, "Failed Supporter");
    const failedCheckout = await createCheckout(
        app,
        failedWallet,
        "client-request-failed"
    );
    const failedEvent = statusEvent("payment-intent-failed", failedCheckout, "failed");
    failedEvent.data.object.id = "pi_test_failed";
    await postWebhook(app, failedEvent).expect(200);

    const expiredWallet = await createWallet(app, "Expired Supporter");
    const expiredCheckout = await createCheckout(
        app,
        expiredWallet,
        "client-request-expired"
    );
    await postWebhook(
        app,
        statusEvent("checkout-session-expired", expiredCheckout, "expired")
    ).expect(200);

    assert.equal((await getPayment(
        app,
        failedWallet,
        failedCheckout.paymentRequest.paymentRequestId
    )).body.paymentRequest.status, "FAILED");
    assert.equal((await getPayment(
        app,
        expiredWallet,
        expiredCheckout.paymentRequest.paymentRequestId
    )).body.paymentRequest.status, "EXPIRED");
    assert.equal((await getWallet(app, failedWallet)).body.wallet.balance.available, 0);
    assert.equal((await getWallet(app, expiredWallet)).body.wallet.balance.available, 0);
});

test("full refunds and disputes adjust unused credits without hardware actions", async t => {
    const { app, eventEngine } = createPaymentTestApp(t);
    for (const scenario of [
        ["refunded", "charge-refunded", "REFUNDED"],
        ["disputed", "charge-dispute-created", "DISPUTED"]
    ]) {
        const [suffix, fixtureName, expectedStatus] = scenario;
        const wallet = await createWallet(app, `${suffix} supporter`);
        const checkout = await createCheckout(app, wallet, `client-request-${suffix}`);
        const completion = completionEvent(checkout, suffix);
        await postWebhook(app, completion).expect(200);
        const adjustment = statusEvent(fixtureName, checkout, `${suffix}-adjustment`);
        adjustment.data.object.payment_intent = completion.data.object.payment_intent;
        await postWebhook(app, adjustment).expect(200);

        assert.equal((await getPayment(
            app,
            wallet,
            checkout.paymentRequest.paymentRequestId
        )).body.paymentRequest.status, expectedStatus);
        assert.equal((await getWallet(app, wallet)).body.wallet.balance.available, 0);
    }
    assert.equal(
        eventEngine.eventStore.database.prepare(
            "SELECT COUNT(*) AS count FROM DeviceCommands"
        ).get().count,
        0
    );
});

test("partial refunds remain flagged without silently revoking a whole credit pack", async t => {
    const { app, eventEngine } = createPaymentTestApp(t);
    const wallet = await createWallet(app);
    const checkout = await createCheckout(app, wallet, "client-request-partial-refund");
    const completion = completionEvent(checkout, "partial-refund");
    await postWebhook(app, completion).expect(200);
    const refundEvent = statusEvent("charge-refunded", checkout, "partial-refund-event");
    refundEvent.data.object.payment_intent = completion.data.object.payment_intent;
    refundEvent.data.object.refunded = false;
    refundEvent.data.object.amount_refunded = 100;
    await postWebhook(app, refundEvent).expect(200);

    const payment = eventEngine.eventStore.getPaymentRequest(
        checkout.paymentRequest.paymentRequestId
    );
    assert.equal(payment.status, "COMPLETED");
    assert.equal(payment.providerStatus, "partially_refunded");
    assert.equal((await getWallet(app, wallet)).body.wallet.balance.available, 1);
    assert.equal(
        eventEngine.eventStore.database.prepare(
            "SELECT COUNT(*) AS count FROM DeviceCommands"
        ).get().count,
        0
    );
});

test("wallet ownership protects payment status and purchase references", async t => {
    const { app } = createPaymentTestApp(t);
    const owner = await createWallet(app, "Owner");
    const stranger = await createWallet(app, "Stranger");
    const checkout = await createCheckout(app, owner, "client-request-owned");

    await request(app)
        .get(`/api/payments/requests/${checkout.paymentRequest.paymentRequestId}`)
        .set("authorization", walletAuthorization(stranger.token))
        .expect(404);
    await request(app)
        .post("/api/feed-credits/checkout-sessions")
        .set("authorization", walletAuthorization(stranger.token))
        .send({ clientRequestId: "client-request-owned", packId: "feed_credit_1" })
        .expect(409);
    await request(app)
        .get("/api/feed-credits/wallet")
        .set("authorization", "Wallet malformed")
        .expect(401);
});

test("administrator payment and credit views are linked and secret-free", async t => {
    const { app } = createPaymentTestApp(t);
    const wallet = await createWallet(app);
    const checkout = await createCheckout(app, wallet, "client-request-admin");
    await postWebhook(app, completionEvent(checkout, "admin")).expect(200);

    const payments = await request(app)
        .get("/api/admin/payments")
        .set("authorization", "Development local-admin")
        .expect(200);
    assert.equal(payments.body.paymentRequests.length, 1);
    assert.equal(payments.body.paymentRequests[0].creditPurchase.credits, 1);
    assert.equal(payments.body.paymentRequests[0].contribution, null);
    assert.equal(payments.body.paymentRequests[0].event, null);

    const credits = await request(app)
        .get("/api/admin/feed-credits")
        .set("authorization", "Development local-admin")
        .expect(200);
    assert.equal(credits.body.feedCredits.wallets.length, 1);
    assert.equal(credits.body.feedCredits.purchases.length, 1);
    assert.equal(credits.body.feedCredits.ledgerEntries[0].entryType, "PURCHASE");
    assert.doesNotMatch(JSON.stringify(credits.body), /sk_test_|whsec_|recoveryToken/i);
});

test("sandbox diagnostics remain read-only and secret-free", async t => {
    const { app } = createPaymentTestApp(t);
    const wallet = await createWallet(app);
    const checkout = await createCheckout(app, wallet, "client-request-diagnostics");
    await postWebhook(app, completionEvent(checkout, "diagnostics")).expect(200);
    const received = await request(app)
        .get("/api/admin/diagnostics/sandbox")
        .set("authorization", "Development local-admin")
        .expect(200);
    const diagnostics = received.body.sandboxDiagnostics;
    assert.equal(diagnostics.webhook.status, "RECEIVING");
    assert.equal(diagnostics.latestEvent.status, "ACCEPTED");
    assert.equal(diagnostics.latestEvent.eventType, "checkout.session.completed");
    assert.doesNotMatch(JSON.stringify(diagnostics), /sk_test_|whsec_|Sandbox Supporter/);
});

test("checkout rejects browser-controlled pricing, invalid packs and live settings", async t => {
    const { app } = createPaymentTestApp(t);
    const wallet = await createWallet(app);
    await request(app)
        .post("/api/feed-credits/checkout-sessions")
        .set("authorization", walletAuthorization(wallet.token))
        .send({
            clientRequestId: "client-request-wrong-amount",
            packId: "feed_credit_1",
            amountMinor: 100
        })
        .expect(201)
        .expect(response => {
            assert.equal(response.body.paymentRequest.amountMinor, 500);
        });
    await request(app)
        .post("/api/feed-credits/checkout-sessions")
        .set("authorization", walletAuthorization(wallet.token))
        .send({ clientRequestId: "client-request-invalid-pack", packId: "£1,000" })
        .expect(400);

    const logger = createTestLogger();
    const config = {
        ...testConfig,
        nodeEnv: "production",
        paymentSandboxEnabled: false
    };
    const eventEngine = new EventEngine({
        config,
        logger,
        sleep: async () => {},
        autoProcess: false
    });
    const productionApp = createApp({ config, logger, eventEngine });
    t.after(async () => {
        productionApp.locals.feedCreditServices.service.stop();
        productionApp.locals.contributionLedgerServices.outboxWorker.stop();
        await productionApp.locals.deviceCommandServices.worker.stop();
        eventEngine.close();
    });
    await request(productionApp)
        .post("/api/feed-credits/checkout-sessions")
        .set("authorization", walletAuthorization(wallet.token))
        .send({ clientRequestId: "client-request-production", packId: "feed_credit_1" })
        .expect(403)
        .expect(response => {
            assert.equal(response.body.error.code, "PAYMENT_SANDBOX_DISABLED");
        });
});
