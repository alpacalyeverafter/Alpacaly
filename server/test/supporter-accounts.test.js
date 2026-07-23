import assert from "node:assert/strict";
import test from "node:test";

import request from "supertest";

import { createApp } from "../src/app.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { createTestLogger, testConfig } from "./helpers.js";

const SUPPORTER = "local-supporter";
const SUPPORTER_TWO = "local-supporter-two";
const UNVERIFIED_SUPPORTER = "unverified-supporter";
const ADMIN = "Development local-admin";

function supporter(requestBuilder, credential = SUPPORTER) {
    return requestBuilder.set("x-development-supporter", credential);
}

function createAccountApp(t, overrides = {}) {
    const logger = createTestLogger();
    const config = {
        ...testConfig,
        feedCreditReconciliationIntervalMs: 60_000,
        ...overrides.config
    };
    const eventEngine = new EventEngine({
        config,
        logger,
        clock: overrides.clock || (() => new Date("2026-07-23T10:00:00.000Z")),
        sleep: async () => {},
        autoProcess: false
    });
    const app = createApp({
        config,
        logger,
        eventEngine,
        ...(overrides.supporterAuthProvider
            ? { supporterAuthProvider: overrides.supporterAuthProvider }
            : {})
    });
    t.after(async () => {
        app.locals.feedCreditServices.service.stop();
        app.locals.contributionLedgerServices.outboxWorker.stop();
        await app.locals.deviceCommandServices.worker.stop();
        eventEngine.close();
    });
    return app;
}

async function createGuestWallet(app, name = "Account Test Supporter") {
    const response = await request(app)
        .post("/api/feed-credits/wallets")
        .send({ supporterName: name })
        .expect(201);
    return {
        token: response.body.recoveryToken,
        walletId: response.body.wallet.walletId
    };
}

async function accountSession(app, credential = SUPPORTER) {
    const response = await supporter(
        request(app).get("/api/supporter-accounts/session"),
        credential
    ).expect(200);
    return response.body;
}

function linkWallet(app, wallet, session, credential = SUPPORTER) {
    return supporter(
        request(app)
            .post("/api/supporter-accounts/wallets/link")
            .set("authorization", `Wallet ${wallet.token}`)
            .set("x-alpacaly-csrf", session.csrfToken),
        credential
    )
        .send({ clientRequestId: `wallet-link-${credential}` });
}

test("guest wallets remain available when supporter accounts are unconfigured", async t => {
    const app = createAccountApp(t, {
        config: {
            supporterAuthProvider: "unconfigured",
            enableDevelopmentSupporterAuthentication: false
        }
    });

    const wallet = await createGuestWallet(app, "Guest Supporter");
    await request(app)
        .get("/api/feed-credits/wallet")
        .set("authorization", `Wallet ${wallet.token}`)
        .expect(200);

    const session = await request(app)
        .get("/api/supporter-accounts/session")
        .expect(200);
    assert.equal(session.body.authenticated, false);
    assert.equal(session.body.accountsAvailable, false);
});

test("verified managed identity links a guest wallet and revokes the guest proof", async t => {
    const app = createAccountApp(t);
    const wallet = await createGuestWallet(app);
    const session = await accountSession(app);

    assert.equal(session.authenticated, true);
    assert.equal(session.account.emailVerified, true);
    assert.match(session.csrfToken, /^[A-Za-z0-9_-]+$/);

    const linked = await linkWallet(app, wallet, session).expect(201);
    assert.equal(linked.body.walletId, wallet.walletId);
    assert.equal(linked.body.session.wallets.length, 1);

    const duplicate = await linkWallet(app, wallet, session).expect(200);
    assert.equal(duplicate.body.duplicate, true);

    await request(app)
        .get("/api/feed-credits/wallet")
        .set("authorization", `Wallet ${wallet.token}`)
        .expect(401);

    const crossDevice = await supporter(
        request(app)
            .get("/api/feed-credits/wallet")
            .set("x-wallet-id", wallet.walletId)
    ).expect(200);
    assert.equal(crossDevice.body.wallet.walletId, wallet.walletId);
});

test("account wallet mutations require both the account session and CSRF proof", async t => {
    const app = createAccountApp(t);
    const wallet = await createGuestWallet(app);
    const session = await accountSession(app);
    await linkWallet(app, wallet, session).expect(201);

    await supporter(
        request(app)
            .post("/api/feed-credits/reservations")
            .set("x-wallet-id", wallet.walletId)
    )
        .send({ clientRequestId: "account-reservation-no-csrf" })
        .expect(403);

    const authorized = await supporter(
        request(app)
            .post("/api/feed-credits/reservations")
            .set("x-wallet-id", wallet.walletId)
            .set("x-alpacaly-csrf", session.csrfToken)
    )
        .send({ clientRequestId: "account-reservation-with-csrf" })
        .expect(409);
    assert.equal(authorized.body.error.code, "FEED_CREDIT_BALANCE_INSUFFICIENT");
});

test("unverified identities cannot claim a wallet", async t => {
    const app = createAccountApp(t);
    const wallet = await createGuestWallet(app);
    const session = await accountSession(app, UNVERIFIED_SUPPORTER);

    const response = await linkWallet(
        app,
        wallet,
        session,
        UNVERIFIED_SUPPORTER
    ).expect(403);
    assert.equal(
        response.body.error.code,
        "SUPPORTER_EMAIL_VERIFICATION_REQUIRED"
    );
});

test("one wallet cannot be linked to two supporter accounts", async t => {
    const app = createAccountApp(t);
    const wallet = await createGuestWallet(app);
    const first = await accountSession(app);
    await linkWallet(app, wallet, first).expect(201);

    const second = await accountSession(app, SUPPORTER_TWO);
    const stolen = await linkWallet(
        app,
        wallet,
        second,
        SUPPORTER_TWO
    ).expect(401);
    assert.equal(stolen.body.error.code, "SUPPORTER_WALLET_PROOF_INVALID");
});

test("global logout revokes the existing managed supporter session", async t => {
    const app = createAccountApp(t);
    const session = await accountSession(app);

    await supporter(
        request(app)
            .post("/api/supporter-accounts/sessions/revoke-all")
            .set("x-alpacaly-csrf", session.csrfToken)
    ).send({}).expect(200);

    const rejected = await supporter(
        request(app).get("/api/supporter-accounts/session")
    ).expect(401);
    assert.equal(rejected.body.error.code, "SUPPORTER_SESSION_REVOKED");
});

test("account deletion anonymizes identity and returns linked wallets to guest recovery", async t => {
    const app = createAccountApp(t);
    const wallet = await createGuestWallet(app);
    const session = await accountSession(app);
    await linkWallet(app, wallet, session).expect(201);

    const deletion = await supporter(
        request(app)
            .post("/api/supporter-accounts/delete")
            .set("x-alpacaly-csrf", session.csrfToken)
    )
        .send({ confirmation: "DELETE MY ACCOUNT" })
        .expect(200);
    assert.equal(deletion.body.deleted, true);
    assert.equal(deletion.body.guestWalletRecovery.length, 1);
    const recovery = deletion.body.guestWalletRecovery[0];
    assert.equal(recovery.walletId, wallet.walletId);

    await request(app)
        .get("/api/feed-credits/wallet")
        .set("authorization", `Wallet ${recovery.recoveryToken}`)
        .expect(200);

    const oldSession = await supporter(
        request(app).get("/api/supporter-accounts/session")
    ).expect(401);
    assert.equal(oldSession.body.error.code, "SUPPORTER_SESSION_REVOKED");
});

test("administrator can inspect accounts, revoke sessions and suspend access", async t => {
    let currentTime = new Date("2026-07-23T10:00:00.000Z");
    const app = createAccountApp(t, {
        clock: () => new Date(currentTime)
    });
    const session = await accountSession(app);
    const accountId = session.account.accountId;

    const directory = await request(app)
        .get("/api/admin/supporter-accounts")
        .set("authorization", ADMIN)
        .expect(200);
    assert.equal(directory.body.supporterAccounts.accounts.length, 1);
    assert.equal(directory.body.supporterAccounts.accounts[0].emailVerified, true);

    currentTime = new Date("2026-07-23T10:05:00.000Z");
    await request(app)
        .post(`/api/admin/supporter-accounts/${accountId}/status`)
        .set("authorization", ADMIN)
        .send({ status: "SUSPENDED", reason: "Security investigation" })
        .expect(200);

    const suspended = app.locals.supporterAccountServices.store
        .getAccount(accountId);
    assert.equal(suspended.sessionsValidAfter, currentTime.toISOString());

    await request(app)
        .post(`/api/admin/supporter-accounts/${accountId}/sessions/revoke`)
        .set("authorization", ADMIN)
        .send({ reason: "Supporter reported a lost phone" })
        .expect(200);

    const events = app.locals.supporterAccountServices.store
        .listEventsForAccount(accountId, 20);
    assert.ok(events.some(event => event.eventType === "SESSIONS_REVOKED"));
    assert.ok(events.some(event => event.eventType === "ACCOUNT_SUSPENDED"));
});
