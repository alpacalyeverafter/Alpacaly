# Phase 8C: Feed Credit Wallet and Click-to-Feed

> Historical implementation note: Phase 8D retains guest recovery-token wallets
> and adds optional managed supporter accounts for cross-device wallet recovery.
> Accounts remain optional and do not change the Feed Credit safety lifecycle.

## Status and safety boundary

Phase 8C replaces the Phase 8A direct payment-to-feed journey with a durable
Feed Credit wallet. Buying credits and requesting a feed are separate actions.
A verified Stripe Test Mode checkout adds credits only; it never creates a
Contribution, FeedIntent, Event, countdown or Device Command.

This phase remains a local sandbox demonstration. It does not authorize live
payments, a public launch, managed PostgreSQL, production MQTT, cameras or
physical hardware. The simulated feeder and all existing welfare, emergency
stop, recovery, audit, authentication and `OUTCOME_UNKNOWN` controls remain in
force.

Feed Credits provide the right to request a feed. They do not guarantee that a
dispense will occur.

## Supporter journey

1. The supporter creates or recovers an opaque Feed Credit wallet.
2. They choose a server-defined pack:
   - £5: 1 Feed Credit
   - £15: 3 Feed Credits
   - £25: 5 Feed Credits
3. Stripe Test Mode completes the hosted checkout. Only a verified signed
   webhook can add the credits to the wallet.
4. The supporter returns to the livestream page with no countdown running.
5. **Use 1 Feed Credit** creates a reservation and passes a feed request through
   the existing Contribution, FeedIntent and Event Engine boundaries.
6. The Event Engine applies queue, welfare, operational, recovery and emergency
   controls. At the front of the queue it pauses in **Your turn**.
7. The supporter must keep the page active and explicitly confirm.
8. Only then may the existing 10-second countdown and simulated lifecycle run.
9. A safely confirmed simulated feed redeems the reserved credit exactly once.

The checkout remains hosted for Phase 8C because the existing hardened Stripe
sandbox launcher safely supports it. The separation above prevents the
supporter missing a feed while returning from checkout. An embedded checkout is
not required for that safety property and remains a future user-experience
decision.

## Wallet recovery and privacy

The server creates a cryptographically random recovery token. Only its SHA-256
hash is stored in the database. The browser stores the opaque token locally and
sends it through the `Authorization: Wallet ...` header; wallet balances and
ownership are always calculated and checked on the server.

There is no supporter account, password or email-recovery system in this phase.
Anyone who obtains the recovery token can access that wallet. Supporters should
not share it or use a shared browser. Clearing browser storage without a safely
retained token loses browser access to the wallet; administrators cannot read
the original token from the database.

## Durable credit rules

`CreditLedgerEntries` is append-only. The server derives `available`,
`reserved` and `spent` balances by summing ledger deltas. The browser never
submits or overrides a balance.

Ledger entry types are:

- `PURCHASE`: verified Stripe Test Mode credits added;
- `RESERVATION`: one available credit moved to reserved;
- `REDEMPTION`: a safely confirmed feed moved from reserved to spent;
- `RELEASE`: no feed occurred and the reserved credit returned to available;
- `REFUND_ADJUSTMENT`: unused purchased credits removed after a full refund or
  dispute without reversing a physical action;
- `ADMIN_CORRECTION`: authenticated, authorized and audited balance correction.

Idempotency keys make purchases, reservations, redemptions, releases, payment
adjustments and administrative corrections exactly-once database operations.
One wallet can have only one active reservation, which also blocks duplicate
clicks and multiple-tab races.

## Reservation, presence and release rules

- A normal queue reservation lasts 30 minutes by default.
- **Your turn** lasts 60 seconds by default.
- Confirmation requires a page heartbeat no more than 15 seconds old.
- A supporter cancellation before countdown returns the credit.
- Queue expiry, confirmation timeout, welfare cancellation, pre-dispense
  operational cancellation and a rejected feed request return the credit.
- A restart restores the wallet, append-only ledger, active reservation,
  Contribution, FeedIntent, Event link and queue position.
- Reconciliation completes any missing safe release or redemption after a
  restart.

If delivery may already have occurred, the reservation becomes
`OUTCOME_UNKNOWN`. The credit remains reserved for operator review and is not
automatically returned. This is intentionally conservative and does not create
a replacement Device Command.

The timing settings are configurable for tests and operations:

```dotenv
FEED_CREDIT_RESERVATION_LIFETIME_MS=1800000
FEED_CREDIT_CONFIRMATION_TIMEOUT_MS=60000
FEED_CREDIT_PRESENCE_TTL_MS=15000
FEED_CREDIT_RECONCILIATION_INTERVAL_MS=1000
```

## Refunds, disputes and corrections

A full refund or dispute releases any request that is proven not to have
started, then removes as many unused available credits from that purchase as
can be safely identified. Credits already spent are not silently reversed and
physical actions are never undone or replaced. Any unrecouped amount is kept in
the append-only adjustment metadata for administrator reconciliation.

A partial refund is retained on the PaymentRequest as
`partially_refunded`. Phase 8C does not guess how a partial monetary refund maps
to whole Feed Credits; an administrator must review it. Refunds or disputes
arriving before checkout completion still require safe replay or manual
reconciliation after the PaymentIntent is linked.

Authorized platform administrators can inspect wallets, purchases,
reservations, Event links and ledger entries. Corrections require a non-zero
integer delta, reason and idempotent client reference, and cannot make the
available balance negative.

## Routes

Public/supporter routes:

- `GET /api/feed-credits/packs`
- `POST /api/feed-credits/wallets`
- `GET /api/feed-credits/wallet`
- `POST /api/feed-credits/checkout-sessions`
- `POST /api/feed-credits/reservations`
- `POST /api/feed-credits/reservations/:id/presence`
- `POST /api/feed-credits/reservations/:id/confirm`
- `POST /api/feed-credits/reservations/:id/cancel`
- `GET /api/payments/requests/:id` (wallet-owned payment only)

Administrator routes:

- `GET /api/admin/feed-credits`
- `POST /api/admin/feed-credits/wallets/:walletId/corrections`

Wallet responses never contain a token hash. Administrator responses never
contain recovery tokens, Stripe keys, webhook secrets or raw provider payloads.

## Local Stripe sandbox demonstration

Use the existing Phase 8B hardened launcher and its named Stripe sandbox
profile:

```sh
npm --prefix server run sandbox:demo
```

Open `http://localhost:8000/index.html`. Create a wallet, buy a test pack with
Stripe's documented sandbox card values, return to the page, and verify that the
balance changes while the queue and countdown remain idle. Then choose **Use 1
Feed Credit**, wait for **Your turn**, keep the tab visible and explicitly
confirm. The admin page at `http://localhost:8000/admin.html` shows the linked
wallet, purchase, reservation, Event and ledger history.

Never use a live key or real card. Live Stripe keys and live events remain
rejected. Keep `.env` ignored and private.

Focused fixture tests make no Stripe network calls:

```sh
npm --prefix server run test:payments
```

They cover verified and duplicate webhooks, packs, wallet ownership, browser
tampering, double clicks, multiple tabs, explicit confirmation, timeout,
cancellation, welfare cancellation, restart recovery, full refund, dispute,
partial-refund review, malformed tokens and `OUTCOME_UNKNOWN`.

## Migrations and recovery

- SQLite central schema version 14 adds the four Feed Credit tables.
- PostgreSQL central migration 6 adds equivalent native timestamp, JSON and
  identity-backed structures.
- Restored-data reconciliation includes credit-table counts, unique identities,
  orphan checks and derived-balance checks.
- Development reset is refused once a Feed Credit ledger entry exists, so test
  reset cannot erase wallet audit history. No public reset control is shown on
  the supporter page.

## Known limitations and next decision

- Hosted Stripe Test Checkout is retained; an embedded checkout remains a
  separately reviewed improvement.
- Wallet recovery depends on one opaque browser-held token; there is no account,
  email recovery, token rotation or cross-device transfer interface yet.
- Only whole-pack full refunds and disputes are automatically adjusted. Partial
  refunds require administrator review.
- An `OUTCOME_UNKNOWN` credit intentionally remains locked pending the existing
  operator-resolution process.
- SQLite and simulated hardware remain the local demonstration defaults.
- PostgreSQL migration compatibility is covered by CI-compatible tests, but no
  real managed PostgreSQL account is connected in this phase.

The next decision is whether to approve a supervised local Stripe Test Mode
demonstration of the full credit purchase and click-to-feed journey. Live
payments, public deployment, physical hardware and production infrastructure
remain separate decisions.
