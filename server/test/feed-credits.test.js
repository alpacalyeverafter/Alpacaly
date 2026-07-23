import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import request from "supertest";
import Stripe from "stripe";

import { createApp } from "../src/app.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { createTestLogger, testConfig } from "./helpers.js";

const WEBHOOK_SECRET = "whsec_alpacaly_fixture";
const stripeFixtures = new Stripe("sk_test_alpacaly_fixture");

function createCreditApp(t, {
    autoProcess = false,
    clock = () => new Date(),
    config: configOverrides = {},
    databasePath = ":memory:"
} = {}) {
    const logger = createTestLogger();
    const config = {
        ...testConfig,
        databasePath,
        paymentSandboxEnabled: true,
        stripeTestSecretKey: "sk_test_alpacaly_fixture",
        stripeTestWebhookSecret: WEBHOOK_SECRET,
        feedCreditReconciliationIntervalMs: 60_000,
        ...configOverrides
    };
    let eventSequence = 0;
    let entitySequence = 0;
    const eventEngine = new EventEngine({
        config,
        logger,
        clock,
        idGenerator: () => `credit-event-${++eventSequence}`,
        sleep: async () => {},
        autoProcess
    });
    const checkoutSessionCreator = async parameters => ({
        id: `cs_test_${parameters.client_reference_id.replace(/[^A-Za-z0-9]/g, "")}`,
        url: `https://checkout.stripe.test/${parameters.client_reference_id}`,
        livemode: false,
        status: "open"
    });
    const app = createApp({
        config,
        logger,
        eventEngine,
        checkoutSessionCreator,
        paymentIdGenerator: () => `credit-entity-${++entitySequence}`
    });
    let closed = false;
    const close = async () => {
        if (closed) {
            return;
        }
        closed = true;
        app.locals.feedCreditServices.service.stop();
        app.locals.contributionLedgerServices.outboxWorker.stop();
        await app.locals.deviceCommandServices.worker.stop();
        eventEngine.close();
    };
    t.after(close);
    return { app, eventEngine, close };
}

function auth(token) {
    return `Wallet ${token}`;
}

async function createWallet(app, supporterName = "Feed Credit Tester") {
    const response = await request(app)
        .post("/api/feed-credits/wallets")
        .send({ supporterName })
        .expect(201);
    return {
        token: response.body.recoveryToken,
        walletId: response.body.wallet.walletId,
        wallet: response.body.wallet
    };
}

async function walletView(app, wallet) {
    const response = await request(app)
        .get("/api/feed-credits/wallet")
        .set("authorization", auth(wallet.token))
        .expect(200);
    return response.body.wallet;
}

function grantCredits(app, wallet, credits = 1, key = "grant-credit-001") {
    return app.locals.feedCreditServices.service.applyAdministrativeCorrection(
        wallet.walletId,
        {
            creditDelta: credits,
            reason: "Focused Phase 8C test credit",
            clientRequestId: key
        },
        "test-administrator"
    );
}

async function reserve(app, wallet, clientRequestId = "feed-request-001") {
    return request(app)
        .post("/api/feed-credits/reservations")
        .set("authorization", auth(wallet.token))
        .send({ clientRequestId })
        .expect(202);
}

async function waitFor(check, message, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) {
            return last;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`${message}${last ? `: ${JSON.stringify(last)}` : ""}`);
}

async function purchaseCredits(app, wallet, {
    packId = "feed_credit_1",
    clientRequestId = "credit-purchase-001"
} = {}) {
    const checkout = await request(app)
        .post("/api/feed-credits/checkout-sessions")
        .set("authorization", auth(wallet.token))
        .send({ packId, clientRequestId })
        .expect(201);
    const event = JSON.parse(readFileSync(
        new URL("./fixtures/stripe/checkout-session-completed.json", import.meta.url),
        "utf8"
    ));
    const paymentId = checkout.body.paymentRequest.paymentRequestId;
    event.id = `evt_${clientRequestId}`;
    event.created = Math.floor(Date.now() / 1000);
    event.data.object.id = `cs_test_${paymentId.replace(/[^A-Za-z0-9]/g, "")}`;
    event.data.object.client_reference_id = paymentId;
    event.data.object.amount_total = checkout.body.paymentRequest.amountMinor;
    event.data.object.currency = "gbp";
    event.data.object.payment_intent = `pi_${clientRequestId}`;
    event.data.object.metadata.alpacaly_payment_request_id = paymentId;
    const payload = JSON.stringify(event);
    const signature = stripeFixtures.webhooks.generateTestHeaderString({
        payload,
        secret: WEBHOOK_SECRET,
        timestamp: Math.floor(Date.now() / 1000)
    });
    await request(app)
        .post("/api/payments/webhooks/stripe")
        .set("content-type", "application/json")
        .set("stripe-signature", signature)
        .send(payload)
        .expect(200);
    return checkout.body;
}

test("offers only the approved £5, £15 and £25 server-side Feed Credit packs", async t => {
    const { app } = createCreditApp(t);
    const response = await request(app).get("/api/feed-credits/packs").expect(200);
    assert.deepEqual(
        response.body.packs.map(pack => [pack.packId, pack.amountMinor, pack.credits]),
        [
            ["feed_credit_1", 500, 1],
            ["feed_credit_3", 1500, 3],
            ["feed_credit_5", 2500, 5]
        ]
    );
    assert.match(response.body.notice, /right to request a feed/i);
});

test("purchase to wallet to explicit confirmation to simulated feed redeems exactly once", async t => {
    const { app, eventEngine } = createCreditApp(t, { autoProcess: true });
    const wallet = await createWallet(app, "Present Supporter");
    await purchaseCredits(app, wallet);
    assert.deepEqual((await walletView(app, wallet)).balance, {
        available: 1,
        reserved: 0,
        spent: 0
    });

    const reservationResponse = await reserve(app, wallet);
    const reservationId = reservationResponse.body.reservation.reservationId;
    const yourTurn = await waitFor(async () => {
        const view = await walletView(app, wallet);
        return view.reservations.find(item => (
            item.reservationId === reservationId && item.status === "YOUR_TURN"
        )) || null;
    }, "reservation did not reach YOUR_TURN");
    assert.equal(yourTurn.event.state, "AWAITING_SUPPORTER_CONFIRMATION");

    const feedBeforeConfirmation = eventEngine.getFeedRequest(yourTurn.event.eventId);
    assert.equal(feedBeforeConfirmation.lifecycleState, "QUEUED");
    assert.equal(feedBeforeConfirmation.stateTimestamps.COUNTDOWN, undefined);

    await request(app)
        .post(`/api/feed-credits/reservations/${reservationId}/presence`)
        .set("authorization", auth(wallet.token))
        .send({ active: true })
        .expect(200);
    await request(app)
        .post(`/api/feed-credits/reservations/${reservationId}/confirm`)
        .set("authorization", auth(wallet.token))
        .send({})
        .expect(202);

    const redeemed = await waitFor(async () => {
        const view = await walletView(app, wallet);
        return view.reservations.find(item => (
            item.reservationId === reservationId && item.status === "REDEEMED"
        )) ? view : null;
    }, "confirmed feed was not redeemed", 5000);
    assert.deepEqual(redeemed.balance, { available: 0, reserved: 0, spent: 1 });
    assert.equal(
        redeemed.ledgerEntries.filter(entry => entry.entryType === "REDEMPTION").length,
        1
    );
    const completed = await waitFor(() => {
        const feed = eventEngine.getFeedRequest(yourTurn.event.eventId);
        return ["COMPLETE", "ARCHIVED"].includes(feed?.lifecycleState)
            ? feed
            : null;
    }, `feed lifecycle did not finish (${JSON.stringify(
        eventEngine.getFeedRequest(yourTurn.event.eventId)
    )})`);
    assert.ok(completed.stateTimestamps.COUNTDOWN);
    assert.ok(["COMPLETE", "ARCHIVED"].includes(completed.lifecycleState));
});

test("checkout completion alone cannot create a queue entry or countdown", async t => {
    const { app, eventEngine } = createCreditApp(t, { autoProcess: true });
    const wallet = await createWallet(app);
    await purchaseCredits(app, wallet, {
        packId: "feed_credit_3",
        clientRequestId: "credit-purchase-no-feed"
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    const view = await walletView(app, wallet);
    assert.deepEqual(view.balance, { available: 3, reserved: 0, spent: 0 });
    assert.equal(view.reservations.length, 0);
    assert.equal(eventEngine.getQueueSummary().length, 0);
    assert.equal(
        eventEngine.eventStore.database.prepare(
            "SELECT COUNT(*) AS count FROM Events"
        ).get().count,
        0
    );
});

test("double clicks and multiple tabs cannot reserve more than one credit", async t => {
    const { app, eventEngine } = createCreditApp(t);
    const wallet = await createWallet(app);
    grantCredits(app, wallet, 3);
    const first = await reserve(app, wallet, "feed-double-click-001");
    const repeated = await request(app)
        .post("/api/feed-credits/reservations")
        .set("authorization", auth(wallet.token))
        .send({ clientRequestId: "feed-double-click-001" })
        .expect(200);
    await request(app)
        .post("/api/feed-credits/reservations")
        .set("authorization", auth(wallet.token))
        .send({ clientRequestId: "feed-second-tab-001" })
        .expect(409)
        .expect(response => {
            assert.equal(response.body.error.code, "FEED_CREDIT_ACTIVE_RESERVATION_EXISTS");
        });
    assert.equal(repeated.body.duplicate, true);
    assert.equal(
        repeated.body.reservation.reservationId,
        first.body.reservation.reservationId
    );
    assert.deepEqual((await walletView(app, wallet)).balance, {
        available: 2,
        reserved: 1,
        spent: 0
    });
    assert.equal(eventEngine.getQueueSummary().length, 1);
});

test("the credit ledger is database-enforced append-only and demo reset cannot erase it", async t => {
    const { app, eventEngine } = createCreditApp(t);
    const wallet = await createWallet(app);
    grantCredits(app, wallet, 1);
    const entry = eventEngine.eventStore.database.prepare(`
        SELECT ledgerEntryId FROM CreditLedgerEntries LIMIT 1
    `).get();
    assert.throws(() => {
        eventEngine.eventStore.database.prepare(`
            UPDATE CreditLedgerEntries SET reason = 'tampered'
            WHERE ledgerEntryId = ?
        `).run(entry.ledgerEntryId);
    }, /append-only/i);
    assert.throws(() => {
        eventEngine.eventStore.database.prepare(`
            DELETE FROM CreditLedgerEntries WHERE ledgerEntryId = ?
        `).run(entry.ledgerEntryId);
    }, /append-only/i);
    await request(app)
        .post("/api/event-engine/reset")
        .set("authorization", "Development local-admin")
        .send({ reason: "LOCAL_DEVELOPMENT_RESET" })
        .expect(409)
        .expect(response => {
            assert.equal(response.body.error.code, "FEED_CREDIT_LEDGER_RESET_FORBIDDEN");
        });
    assert.equal((await walletView(app, wallet)).balance.available, 1);
});

test("supporter cancellation and welfare cancellation return an unspent credit", async t => {
    const { app, eventEngine } = createCreditApp(t);
    const firstWallet = await createWallet(app, "Cancel Supporter");
    grantCredits(app, firstWallet, 1, "grant-cancel-001");
    const first = await reserve(app, firstWallet, "feed-cancel-001");
    await request(app)
        .post(`/api/feed-credits/reservations/${first.body.reservation.reservationId}/cancel`)
        .set("authorization", auth(firstWallet.token))
        .send({})
        .expect(200);
    assert.deepEqual((await walletView(app, firstWallet)).balance, {
        available: 1,
        reserved: 0,
        spent: 0
    });

    const welfareWallet = await createWallet(app, "Welfare Supporter");
    grantCredits(app, welfareWallet, 1, "grant-welfare-001");
    const welfare = await reserve(app, welfareWallet, "feed-welfare-001");
    eventEngine.cancelForWelfare(welfare.body.reservation.event.eventId, {
        reason: "Test welfare hold"
    });
    const welfareView = await walletView(app, welfareWallet);
    assert.deepEqual(welfareView.balance, { available: 1, reserved: 0, spent: 0 });
    assert.equal(welfareView.reservations[0].status, "RELEASED");
    assert.equal(welfareView.reservations[0].releaseReason, "CANCELLED_FOR_WELFARE");
});

test("reservation and confirmation expiry release the credit safely", async t => {
    let now = new Date("2026-07-22T12:00:00.000Z");
    const clock = () => new Date(now);
    const { app, eventEngine } = createCreditApp(t, {
        clock,
        config: {
            feedCreditReservationLifetimeMs: 1000,
            feedCreditConfirmationTimeoutMs: 1000,
            feedCreditPresenceTtlMs: 250
        }
    });
    const wallet = await createWallet(app);
    grantCredits(app, wallet, 2, "grant-expiry-001");
    await reserve(app, wallet, "feed-reservation-expiry-001");
    now = new Date(now.getTime() + 1001);
    app.locals.feedCreditServices.service.reconcile();
    let view = await walletView(app, wallet);
    assert.equal(view.reservations[0].status, "RELEASED");
    assert.equal(view.reservations[0].releaseReason, "QUEUE_RESERVATION_EXPIRED");

    const second = await reserve(app, wallet, "feed-confirmation-expiry-001");
    await eventEngine.processQueue();
    view = await walletView(app, wallet);
    assert.equal(view.reservations.find(item => (
        item.reservationId === second.body.reservation.reservationId
    )).status, "YOUR_TURN");
    now = new Date(now.getTime() + 1001);
    app.locals.feedCreditServices.service.reconcile();
    view = await walletView(app, wallet);
    const expired = view.reservations.find(item => (
        item.reservationId === second.body.reservation.reservationId
    ));
    assert.equal(expired.status, "RELEASED");
    assert.equal(expired.releaseReason, "SUPPORTER_CONFIRMATION_TIMEOUT");
    assert.deepEqual(view.balance, { available: 2, reserved: 0, spent: 0 });
});

test("OUTCOME_UNKNOWN keeps the credit reserved for operator review", async t => {
    const { app, eventEngine } = createCreditApp(t);
    const wallet = await createWallet(app);
    grantCredits(app, wallet, 1);
    const created = await reserve(app, wallet);
    await eventEngine.processQueue();
    const reservationId = created.body.reservation.reservationId;
    await request(app)
        .post(`/api/feed-credits/reservations/${reservationId}/presence`)
        .set("authorization", auth(wallet.token))
        .send({ active: true })
        .expect(200);
    await request(app)
        .post(`/api/feed-credits/reservations/${reservationId}/confirm`)
        .set("authorization", auth(wallet.token))
        .send({})
        .expect(202);
    const reservation = app.locals.feedCreditServices.store.getReservation(
        reservationId
    );
    const feedRequest = eventEngine.getFeedRequest(reservation.eventId);
    app.locals.feedCreditServices.service.onLifecycleFailure(feedRequest, {
        code: "DEVICE_COMMAND_OUTCOME_UNKNOWN"
    });
    const view = await walletView(app, wallet);
    assert.equal(view.reservations[0].status, "OUTCOME_UNKNOWN");
    assert.deepEqual(view.balance, { available: 0, reserved: 1, spent: 0 });
    assert.equal(
        view.ledgerEntries.some(entry => entry.entryType === "RELEASE"),
        false
    );
});

test("wallet token and active reservation survive an application restart", async t => {
    const databasePath = join(
        tmpdir(),
        `alpacaly-phase-8c-${process.pid}-${Date.now()}.sqlite`
    );
    t.after(() => rmSync(databasePath, { force: true }));
    const first = createCreditApp(t, { databasePath });
    const wallet = await createWallet(first.app, "Restart Supporter");
    grantCredits(first.app, wallet, 1);
    const reservation = await reserve(first.app, wallet, "feed-restart-001");
    await first.close();

    const second = createCreditApp(t, { databasePath });
    const recovered = await walletView(second.app, wallet);
    assert.deepEqual(recovered.balance, { available: 0, reserved: 1, spent: 0 });
    assert.equal(recovered.reservations[0].reservationId, reservation.body.reservation.reservationId);
    assert.equal(recovered.reservations[0].status, "WAITING");
    assert.equal(second.eventEngine.getQueueSummary().length, 1);
});
