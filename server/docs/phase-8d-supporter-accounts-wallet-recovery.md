# Phase 8D: Supporter Accounts and Wallet Recovery

## Status and safety boundary

Phase 8D adds **optional** supporter accounts to the Phase 8C Feed Credit
wallet. A supporter can still create a guest wallet, buy Stripe Test Mode
credits and use click-to-feed without registering or signing in. An account is
offered only as a way to protect an existing wallet and recover it on another
device.

This remains a local sandbox implementation. No Auth0 tenant, live payment,
public deployment, managed PostgreSQL database, production MQTT broker, camera
or physical feeder is connected or authorized. Authentication does not bypass
the Event Engine, welfare rules, emergency stops, queue controls or the
`OUTCOME_UNKNOWN` safety boundary.

## Managed authentication decision

The production-facing adapter targets **Auth0 Universal Login** through the
official `express-openid-connect` middleware. Hosted login keeps passwords,
email verification and password recovery outside the Alpacaly codebase. The
Alpacaly server accepts only the managed OIDC identity and maintains its own
account-to-wallet authorization, append-only account events and revocation
state.

The integration is provider-isolated behind `SupporterAuthProvider`. Local
tests use an explicitly enabled development provider with fixed identities.
Production rejects that provider. When no provider is configured, account
routes report that accounts are unavailable while guest wallets continue to
work.

The current Auth0 SDK and configuration guidance must be reviewed again in
Phase 8E before any tenant is connected. Phase 8D does not create an Auth0
account or transmit supporter data to Auth0.

## Supporter journeys

### Guest journey remains first-class

1. Enter a display name and create a private guest wallet.
2. Buy Feed Credits in Stripe Test Mode.
3. Use one credit through the existing safety-controlled queue.
4. Keep the browser recovery token private.

No account prompt blocks purchase or feeding.

### Protect a guest wallet

1. Sign in or create an account through hosted Universal Login.
2. Complete managed email verification.
3. Return with a recent managed session.
4. Choose **Protect this wallet**.
5. The server proves the existing guest recovery token, creates one unique
   account-wallet link and rotates the old token in the same transaction.
6. The wallet becomes available to the same managed identity on another device.

The browser never sends an account ID as authority. The server resolves the
account from the managed session and checks the requested wallet against its
active links.

### Lost device and session recovery

- A supporter signs in again through the managed provider on the new device.
- Linked wallet balances and histories are loaded from the central database.
- **Sign out everywhere** revokes every known Alpacaly account session and
  advances the account-wide session-validity boundary.
- A platform administrator may revoke sessions or suspend an account with a
  required reason and authorization audit.
- Alpacaly never stores or resets supporter passwords.

## Wallet ownership and race safety

`SupporterWalletLinks` has a database-enforced unique active link per wallet.
Linking also uses an account-scoped client request ID so a repeated response is
idempotent. The proof token is rotated during the same transaction as the link,
so a copied or stale guest token cannot continue to use the protected wallet.

Account sessions may access only a linked wallet selected by `x-wallet-id`.
State-changing account-wallet requests require both the managed session cookie
and an account/session-bound CSRF token. Guest requests continue to use the
opaque `Authorization: Wallet ...` credential.

## Account data and events

The account record contains:

- opaque Alpacaly account ID;
- managed-provider name and external identity ID;
- normalized email and verification state;
- optional display name;
- status and account/session timestamps.

The account never contains a password, Auth0 credential, wallet recovery token,
Stripe secret or raw ID token. `SupporterAccountEvents` is append-only and
records account creation, session authentication, wallet linking, revocation,
suspension/restoration, data export and deletion.

The account view includes linked wallet purchases, reservations, redemptions,
safe credit returns and adjustments. The existing append-only Feed Credit
ledger remains the balance source of truth.

## Privacy, retention and deletion

- Account creation is optional and purpose-limited to wallet protection,
  recovery and supporter-requested history.
- Email is supplied and verified by the managed identity provider; it is not
  used for marketing by this implementation.
- The supporter may export their account, linked wallet and account-event data.
- Account deletion requires a verified, recent session and explicit
  confirmation.
- Deletion immediately removes email and display name from the central account,
  breaks the external identity link, revokes sessions and returns linked wallets
  to fresh one-time guest recovery credentials.
- Pseudonymous payment, Feed Credit, feeding, safety and account-audit records
  remain where required to preserve financial, animal-welfare, fraud and system
  integrity evidence. Phase 8E must approve the exact retention schedule and
  privacy notice before a public launch.
- Recovery credentials returned during deletion are shown once and are never
  stored in account events or administrator views.

## Routes

Supporter account routes:

- `GET /api/supporter-accounts/login`
- `GET /api/supporter-accounts/callback` (managed middleware)
- `GET /api/supporter-accounts/logout`
- `GET /api/supporter-accounts/session`
- `POST /api/supporter-accounts/wallets/link`
- `POST /api/supporter-accounts/sessions/revoke-all`
- `GET /api/supporter-accounts/export`
- `POST /api/supporter-accounts/delete`

Existing Feed Credit and owned-payment routes accept either a guest wallet
credential or an authenticated, CSRF-protected account-wallet scope.

Administrator routes:

- `GET /api/admin/supporter-accounts`
- `POST /api/admin/supporter-accounts/:accountId/status`
- `POST /api/admin/supporter-accounts/:accountId/sessions/revoke`

Administrator responses never expose session cookies, password data, raw OIDC
tokens, recovery credentials or recovery-token hashes.

## Local development configuration

For automated/local development only:

```dotenv
SUPPORTER_AUTH_PROVIDER=development
ENABLE_DEVELOPMENT_SUPPORTER_AUTHENTICATION=true
SUPPORTER_CSRF_SECRET=replace-with-at-least-32-random-characters
```

For a later Auth0 sandbox review:

```dotenv
SUPPORTER_AUTH_PROVIDER=auth0
SUPPORTER_AUTH_BASE_URL=http://localhost:3000
SUPPORTER_PUBLIC_RETURN_URL=http://localhost:8000/index.html
SUPPORTER_CSRF_SECRET=replace-with-a-secret-managed-random-value
AUTH0_ISSUER_BASE_URL=https://your-tenant.example.auth0.com
AUTH0_CLIENT_ID=managed-application-client-id
AUTH0_CLIENT_SECRET=
AUTH0_SESSION_SECRET=replace-with-a-secret-managed-random-value
```

Configure the managed application callback as
`http://localhost:3000/api/supporter-accounts/callback` and the logout return as
`http://localhost:8000/index.html`. Never commit these values. Production
requires HTTPS and secret-managed CSRF/session secrets.

## Migrations and recovery

- SQLite central schema version 15 adds supporter accounts, unique wallet links,
  revocable sessions and append-only account events.
- PostgreSQL central migration 7 adds equivalent native timestamp, boolean,
  JSON and append-only structures.
- Restored-data reconciliation includes account/link/session/event counts,
  unique identifiers, orphan checks, active-link uniqueness and append-only
  trigger evidence.
- Account links never move Feed Credit balances; they only authorize access to
  the existing wallet ledger.

## Acceptance evidence

Automated tests cover:

- guest operation with accounts unconfigured;
- verified and unverified managed identities;
- idempotent wallet linking and recovery-token rotation;
- denial of stale/stolen recovery credentials;
- one active account link per wallet;
- CSRF enforcement on account-wallet mutations;
- cross-device account-wallet reads;
- global and administrator session revocation;
- account suspension;
- export and deletion with guest-wallet recovery;
- browser cookie, CSRF and account-wallet headers;
- schema migration and restart/recovery compatibility.

## Remaining decisions

Phase 8E must still approve and execute:

- Auth0 tenant, region, contract, security settings and data-processing terms;
- exact privacy and retention schedules;
- verified-email templates and supporter support procedures;
- production HTTPS, cookie, secret rotation, rate limiting and monitoring;
- managed PostgreSQL and backup/restore evidence;
- live-payment readiness and refund/dispute operations.

Phase 8D does not authorize Phase 8E, hardware commissioning or a public pilot.
