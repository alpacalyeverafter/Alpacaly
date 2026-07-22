# Phase 8A: Live Website Sandbox-Payment MVP

## Status and scope

Phase 8A provides a complete local website journey using Stripe Test Mode and
the simulated feeder. It does not enable live payments, select a production
payment account, authorize a public launch, or connect managed PostgreSQL,
production MQTT, cameras, physical bells, motors, sensors, or feeders.

The Event Engine remains the source of truth. Stripe creates and reports a
payment only. It cannot create a Device Command or call hardware.

The verified path is:

```text
Website donation request
  -> server-created Stripe Test Checkout Session
  -> raw signed Stripe webhook
  -> provider-scoped ProviderEvent
  -> verified Contribution
  -> durable FeedIntent and Outbox
  -> Event Engine feed request
  -> existing welfare and operational controls
  -> simulated device-command lifecycle only
```

Payment is a request to enter the feeding queue, not a promise that feed will
be dispensed. Daily limits, feeding windows, feeder availability, emergency
stops, recovery safety mode, `OUTCOME_UNKNOWN` cases and operator controls can
block or delay feeding after payment.

## Public and administrator routes

- `POST /api/payments/checkout-sessions` validates the fixed sandbox donation
  and creates a hosted Checkout Session on the server.
- `POST /api/payments/webhooks/stripe` receives the raw request body and
  verifies `Stripe-Signature` before parsing or persisting the event.
- `GET /api/payments/requests/:paymentRequestId` exposes the safe supporter
  status: payment, Event ID, queue position, estimated wait and any welfare or
  operational delay.
- `GET /api/admin/payments` exposes recent test payments and their
  ProviderEvent, Contribution, FeedIntent and Event links to an authorized
  administrator.

The durable payment statuses are `PENDING`, `COMPLETED`, `FAILED`, `EXPIRED`,
`REFUNDED` and `DISPUTED`.

## Local setup

1. Use Node.js 24 and install the server dependencies:

   ```bash
   cd server
   npm install
   ```

2. Copy `.env.example` to `.env`. Set only Stripe Test Mode values:

   ```dotenv
   ENABLE_PAYMENT_SANDBOX=true
   PAYMENT_PUBLIC_BASE_URL=http://localhost:8000
   STRIPE_TEST_SECRET_KEY=sk_test_your_test_key
   STRIPE_TEST_WEBHOOK_SECRET=whsec_from_stripe_cli
   ```

   Never use an `sk_live_` key. The configuration rejects non-test Stripe
   secret keys and live webhook events. Do not commit `.env`.

3. Start the server from `server/`:

   ```bash
   npm start
   ```

4. In a second terminal, forward only the supported Stripe sandbox events:

   ```bash
   stripe listen \
     --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,payment_intent.payment_failed,charge.refunded,charge.dispute.created \
     --forward-to localhost:3000/api/payments/webhooks/stripe
   ```

   Copy the `whsec_...` value printed by the Stripe CLI into the local `.env`,
   then restart the server. The Stripe CLI and any test account setup remain a
   manual operator step; this repository does not create an account.

5. From the repository root, serve the existing website without changing its
   design:

   ```bash
   python3 -m http.server 8000
   ```

6. Open `http://localhost:8000/index.html`, enter a supporter name and select
   **Sponsor a £5 Test Feed**. Stripe's standard successful test card is
   `4242 4242 4242 4242`; use any future expiry date and any CVC in the hosted
   Stripe test checkout. Never enter a real card while testing.

7. After Stripe returns to the site, the website polls the server status and
   displays the payment state, Event ID, queue position and estimated wait.
   Open `http://localhost:8000/admin.html` to inspect the payment-to-feed links.
   The existing development administrator identity must be enabled locally.

## Fixture-only demo without Stripe network access

The automated test suite uses the official Stripe library to sign stored JSON
fixtures with a test webhook secret. It never contacts Stripe. Run:

```bash
npm run test:payments
```

The suite covers successful end-to-end conversion, invalid signatures,
delivery timestamps outside the five-minute tolerance, duplicate event IDs,
amount and currency mismatches, malformed metadata, failed and expired
payments, refunds, disputes, and an Event Engine rejection after payment.

## Security and trust boundaries

- The browser cannot assert verification, eligibility, feed quantity,
  ProviderEvent identity, Contribution identity or payment status.
- Checkout creation uses a provider-scoped idempotency key derived from the
  durable, server-generated PaymentRequest ID.
- Stripe webhook verification uses the untouched raw body and the official
  Stripe library before JSON is trusted.
- Signed deliveries outside the configured tolerance are rejected. Repeated
  Stripe Event IDs are deduplicated by `(provider, externalEventId)`.
- Only an allow-listed, secret-free subset of provider metadata is stored.
  Webhook payloads, signatures, keys and checkout URLs are not written to logs.
- Amount, currency, mode, session identity, client reference and internal
  metadata must all match the server-created PaymentRequest before a
  Contribution is created.
- A verified payment produces a Contribution and FeedIntent only through the
  existing contribution ledger. The provider adapter has no Event Engine,
  Device Command or hardware dependency.
- Refunds and disputes update the payment record. They do not reverse a
  physical action or issue a replacement command; operators use the existing
  safety controls for any feed already queued or processed.

## Known limitations and next decision

- A human must create or provide a Stripe sandbox account, test key and local
  webhook secret before the hosted checkout can be demonstrated.
- This block intentionally supports one fixed £5 GBP sandbox option.
- Partial refunds remain `COMPLETED` with provider status
  `partially_refunded`; full refunds use `REFUNDED`.
- Refunds or disputes do not automatically cancel an existing feed request,
  because payment systems must not bypass Event Engine safety decisions.
- A refund or dispute event that arrives before its Checkout completion cannot
  yet be linked without a provider API lookup. It is rejected safely and needs
  replay or operator reconciliation after the PaymentIntent link exists.
- The supporter status uses an unguessable PaymentRequest ID in the return URL;
  no supporter account or email receipt is included in this block.
- SQLite and the simulated controller remain the local demonstration defaults.

The next decision is whether the team approves a controlled Stripe Test Mode
demo using a manually supplied sandbox account. Live keys, live payments and a
public launch require a separate reviewed phase.
