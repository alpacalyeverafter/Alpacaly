# Phase 8B: Sandbox Pilot Hardening Runbook

## Authorization and safety boundary

This runbook starts a **local Stripe sandbox demonstration**. Sandbox mode
moves no real money. It uses Stripe Test Mode, a loopback-only website and API,
and the simulated hardware boundary.

This phase does **not** authorize live payments, a public deployment, public
webhook endpoints, production credentials, cameras, physical bells, motors,
sensors or feeders. Do not enter a real card. Live keys and events are rejected.

The Event Engine remains the source of truth. A test payment can only create a
verified Contribution and durable FeedIntent through the Phase 8A path. Queue
ordering, welfare limits, feeding windows, emergency stops, recovery holds,
`OUTCOME_UNKNOWN` handling and the simulated Device Command boundary remain in
force. A successful test payment is a request to join the queue, not a promise
that feed will be dispensed.

## First-time setup

1. Install Node.js 24, npm 11 or later, and the Stripe CLI. From the repository
   root, install the pinned server dependencies:

   ```sh
   npm --prefix server install
   ```

2. Authenticate a dedicated, explicitly named Stripe sandbox CLI profile:

   ```sh
   stripe login --project-name alpacaly-sandbox-demo
   ```

   Select only a Stripe sandbox account. The launcher reads this named profile;
   it never accepts an API key or `--live` argument.

3. Create the ignored local configuration if it does not already exist:

   ```sh
   cp server/.env.example server/.env
   ```

   Edit `server/.env` locally. Do not print it, paste it into a report or commit
   it. Set:

   ```dotenv
   NODE_ENV=development
   PORT=3000
   ENABLE_PAYMENT_SANDBOX=true
   PAYMENT_PUBLIC_BASE_URL=http://localhost:8000
   STRIPE_TEST_SECRET_KEY=your_Stripe_test_secret_key
   STRIPE_TEST_WEBHOOK_SECRET=your_local_listener_secret
   STRIPE_CLI_PROJECT=alpacaly-sandbox-demo
   ENABLE_DEVELOPMENT_AUTHENTICATION=true
   ```

   `STRIPE_TEST_SECRET_KEY` must be a Test Mode `sk_test_...` value. Never put a
   live key in this project.

4. On the first use of a profile, obtain its local listener signing secret by
   briefly starting a test-only listener, copying the displayed `whsec_...`
   value into `server/.env`, and then pressing Control+C:

   ```sh
   stripe listen --project-name alpacaly-sandbox-demo \
     --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,payment_intent.payment_failed,charge.refunded,charge.dispute.created \
     --forward-to http://127.0.0.1:3000/api/payments/webhooks/stripe
   ```

   Keep that value only in the ignored local `.env`. The Phase 8B launcher
   compares the configured secret with the listener's reported secret in memory
   and redacts it from output. A mismatch stops the whole demonstration.

## One-command start, monitoring and stop

Run this single command from the repository root:

```sh
npm --prefix server run sandbox:demo
```

The fail-closed preflight verifies Node.js 24, the Stripe CLI, sandbox enablement,
the loopback website URL, a test-only server key, a webhook secret, the named
test-only Stripe CLI profile, and availability of ports 3000 and 8000. It also
rejects production mode and all extra command arguments.

After preflight, the supervisor starts:

- the Alpacaly API on `127.0.0.1:3000`;
- the existing website on `127.0.0.1:8000`;
- Stripe event forwarding through the configured named profile, limited to the
  seven Phase 8A event types shown above.

Output is labelled `[api]`, `[website]`, `[stripe]` or `[sandbox]`. Secret-shaped
values and the configured key and webhook secret are redacted. If a component
fails to start or later exits, the supervisor stops all other components.

Open:

- `http://localhost:8000/index.html` for the supporter flow;
- `http://localhost:8000/admin.html` for the existing Admin Overview.

The Admin Overview includes read-only Sandbox Diagnostics for sandbox mode, API
availability, Stripe adapter configuration, webhook status and last receipt,
and the latest accepted or rejected event. It does not expose secrets, raw
payloads, credentials or supporter details.

Press **Control+C once** in the launcher terminal to stop the Stripe listener,
website and API. Wait for `All sandbox components stopped.` before closing the
terminal.

## Safe interactive test cards

Use only Stripe's documented test values. Stripe states that sandbox test
transactions do not move funds. For a future expiry, use any three-digit CVC and
any other requested test values. See [Stripe's test-card reference](https://docs.stripe.com/testing).

| Scenario | Test card | Expected local result |
| --- | --- | --- |
| Successful payment | `4242 4242 4242 4242` | Payment becomes `COMPLETED`; one idempotent Contribution and FeedIntent are created; the Event Engine decides queue admission. |
| Failed payment | `4000 0000 0000 9995` | Stripe reports insufficient funds; payment becomes `FAILED`; no Contribution or feed request is created. |
| Dispute | `4000 0000 0000 0259` | The test charge succeeds and Stripe can create a sandbox dispute; payment becomes `DISPUTED`; no hardware action or replacement is created. |

Never use real card details. Refunds, session expiry and disputes may also be
initiated or inspected in the Stripe sandbox Dashboard, but the fixture suite
below is the repeatable acceptance check and does not create test objects at
Stripe.

## Repeatable fixture scenarios

Run the focused suite from the repository root:

```sh
npm --prefix server run test:payments
```

The suite signs stored JSON fixtures with fixture-only values and makes no Stripe
network calls. It covers:

| Scenario | Expected result |
| --- | --- |
| Successful payment | Exactly one ProviderEvent, Contribution, FeedIntent and Event; no direct Device Command. |
| Failed payment | `FAILED`; no Contribution and no feed request. |
| Expired checkout | `EXPIRED`; no Contribution and no feed request. |
| Full refund | `REFUNDED`; existing safety and queue state remain authoritative. |
| Partial refund | Payment remains `COMPLETED` with provider status `partially_refunded`; no hardware side effect. |
| Dispute | `DISPUTED`; no hardware side effect or replacement. |
| Duplicate webhook | Provider-scoped duplicate is acknowledged without duplicate records or queue entries. |
| Invalid signature | Rejected before ingestion; diagnostic status is `REJECTED`. |
| Live-mode event | Rejected before ingestion with `LIVE_PAYMENT_EVENT_REJECTED`. |
| Event outside allow-list | Rejected before ingestion with `PAYMENT_EVENT_NOT_ALLOWED`. |

Amount, currency, metadata, session-reference and stale-signature failures are
also covered. Fixtures contain no production credentials and snapshots never
contain keys or webhook secrets.

## Troubleshooting

- **Node.js or Stripe CLI unavailable:** install the missing tool and rerun the
  same command. Node.js must be major version 24.
- **Sandbox not enabled / key or secret required:** edit the ignored
  `server/.env`. Do not pass a key on the command line.
- **Public URL is not local:** set it exactly to
  `http://localhost:8000`. Remote hosts and public tunnels are refused.
- **Named profile missing:** rerun `stripe login --project-name
  alpacaly-sandbox-demo` and confirm that `STRIPE_CLI_PROJECT` has that exact
  name.
- **Webhook secret mismatch:** repeat the first-time listener step for the same
  named profile, replace only the local `.env` value, stop the temporary
  listener, and rerun the one command.
- **Port 3000 or 8000 in use:** stop the unrelated local process. The launcher
  will not take over, reuse or kill an unknown process.
- **Stripe forwarding does not become ready:** confirm network access and the
  named sandbox profile's authentication. The launcher stops the website and API
  after the bounded startup timeout.
- **Admin says authentication required:** ensure local development
  authentication is enabled. This does not authorize a production identity
  system.
- **Payment completed but feeding is delayed:** inspect the existing welfare,
  emergency-stop, recovery and `OUTCOME_UNKNOWN` panels. Do not bypass them or
  create a replacement automatically.

## Security checks before review

Run tests and the available repository checks, then confirm the local secret file
is ignored:

```sh
npm --prefix server test
npm --prefix server audit --omit=dev
git check-ignore -v server/.env
git ls-files server/.env
git diff --check
```

The `git ls-files` command must print nothing for `server/.env`. Do not attach
the file, launcher output containing unredacted secrets, or Stripe credentials
to a review. A future live-payment, public-deployment or physical-hardware phase
requires separate authorization and security review.

## Known limitations

- A human must provide and authenticate a Stripe sandbox account, test secret
  key and listener secret.
- The manual demonstration contacts Stripe's sandbox. Automated tests remain
  completely local and fixture-only.
- Diagnostics are process-local observations and reset when the API restarts;
  payment and Event Engine records remain durable through the existing stores.
- The website offers one fixed £5 GBP sandbox option.
- Refund and dispute events arriving before Checkout completion still require a
  safe replay or operator reconciliation after the PaymentIntent link exists.
- SQLite and simulated hardware remain the local demonstration defaults.
