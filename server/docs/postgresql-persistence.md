# PostgreSQL persistence and multi-worker operation

Phase 7F-2A makes PostgreSQL the required production source of truth for the
central backend. SQLite remains the zero-setup local-development store, test
store, and independent Barn edge-controller journal. The public and
administrator APIs, browser behavior, domain objects, provider-neutral
Contribution boundary, lifecycle state machine, device transport boundary, and
operator-safety decisions are unchanged.

## Storage boundary

`CENTRAL_DATABASE_TYPE` is the single selection point for central persistence:

- `sqlite` uses the existing local Event Store and is allowed outside production.
- `postgres` uses the production Event Store and requires `DATABASE_URL`.
- `NODE_ENV=production` refuses to start unless the selection is `postgres`.
- production rejects loopback and clearly development/test database identities,
  and requires `POSTGRES_SSL_MODE=verify-full`.
- there is no production SQLite fallback. A database outage makes readiness fail
  closed instead of silently opening a local database.

The edge-controller process continues to use `EDGE_DATABASE_PATH`. Its local
journal, safety controller, bounded action, welfare gates, and offline behavior
do not depend on PostgreSQL.

The PostgreSQL adapter deliberately presents the existing synchronous statement
and transaction contract to the domain stores. A dedicated database worker owns
the asynchronous connection pool, while the Event Engine and stores retain their
reviewed transaction boundaries. PostgreSQL row locks, unique constraints,
advisory locks, foreign keys, and append-only triggers—not process memory—provide
cross-process correctness. This avoids an API/domain rewrite in this phase. The
synchronous bridge is a known per-process throughput ceiling and should be
re-evaluated if measured database wait time becomes material.

## Safe provisioning contract

Provision a dedicated PostgreSQL 16-or-newer database before starting an
application instance. The application database role should own only its Alpacaly
database/schema, have no superuser, replication, role-management, or
`BYPASSRLS` privilege, and use a separately managed high-entropy credential.
Require TLS with hostname and certificate verification between the service and
database. Store `DATABASE_URL` and an optional CA bundle path in the deployment
secret system; never commit them, put them on command lines, or log them.

Set connection capacity intentionally. The total worst-case connections are
approximately `application instances × POSTGRES_POOL_MAXIMUM`, plus migration,
monitoring, and operator headroom. Defaults are conservative, but production
values must be checked against the database connection limit before rollout.

Startup applies forward-only migrations under a transaction-scoped PostgreSQL
advisory lock. Every migration has a recorded SHA-256 checksum. A changed applied
migration or a database schema newer than the running software stops startup.
DDL and its migration record commit together. No manual migration service is
required for this phase, and multiple instances can start safely.

Minimum production settings:

```dotenv
NODE_ENV=production
CENTRAL_DATABASE_TYPE=postgres
DATABASE_URL=postgresql://<application-role>:<secret>@<database-host>/<database>
POSTGRES_SSL_MODE=verify-full
POSTGRES_POOL_MINIMUM=0
POSTGRES_POOL_MAXIMUM=10
POSTGRES_CONNECTION_TIMEOUT_MS=5000
POSTGRES_STATEMENT_TIMEOUT_MS=15000
POSTGRES_LOCK_TIMEOUT_MS=5000
POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS=15000
POSTGRES_APPLICATION_NAME=alpacaly-server
```

`POSTGRES_TLS_CA_PATH` may identify a deployment-provided CA bundle. Do not use a
committed private CA or disable certificate verification in production.

## Distributed ownership and crash recovery

`WorkerInstances`, `DistributedWorkClaims`, and append-only `WorkClaimHistory`
are authoritative for FeedIntent, Event lifecycle, and DeviceCommand ownership.
Every claim has:

- a unique work type/item key;
- worker, process, boot, service, environment, and software identity;
- a monotonically increasing claim generation;
- a short renewable lease and a non-extendable maximum claim lifetime;
- attempt and maximum-attempt counters;
- explicit completion, retry, dead-letter, and operator-review states; and
- timestamped ownership/reclaim/failure history.

Only the current worker and generation can extend, complete, release, or fail a
claim. An expired owner is fenced after the configured skew/reclaim tolerance.
Feed Request creation, Outbox completion, and claim completion share one database
transaction. If that commit already exists after a crash, the worker reconciles
to it rather than creating another Event. Unique Contribution, FeedIntent, Event,
command, acknowledgement, and execution keys remain the final duplicate guard.

Device delivery is more conservative. Claim heartbeats abort transport work if
ownership is lost. Work proven not to have executed can retry within its bound.
A send that may have physically completed becomes `OPERATOR_REVIEW`; it is never
automatically delivered again. Exhausted safe retries become `DEAD_LETTER`.
Existing device reconciliation, fencing tokens, execution journals, conservative
welfare accounting, emergency stops, and dual-approved resolution remain
authoritative.

Event sequence values come from PostgreSQL, per-day/per-queue feed limits are
reserved centrally, and per-feeder command fencing allocation is protected by a
transaction advisory lock. These remove the remaining process-local write races.

## Operational endpoints

`GET /health` remains a small public liveness response. `GET /health/ready`
checks persistence and worker-coordination access and returns `503` when the
instance should not receive traffic. It exposes only database type, schema
version, and reachability—not hosts, credentials, SQL, or error details.

Authenticated platform Administrators with
`MANAGE_SECURITY_CONFIGURATION` can read
`GET /api/admin/diagnostics/persistence`. It reports sanitized connection-pool
state, schema version, worker/claim states, dead-letter/operator-review totals,
and FeedIntent/DeviceCommand backlogs. Monitor at least:

- readiness failures and database round-trip latency;
- pool waiters and pool saturation;
- active claims older than one lease;
- lease reclaims and heartbeat failures;
- `FAILED`, `DEAD_LETTER`, and `OPERATOR_REVIEW` growth;
- FeedIntent and command backlog age/count; and
- PostgreSQL lock waits, statement timeouts, disk, WAL, and connection usage.

Never place `DATABASE_URL`, query parameters containing supporter data, raw
metadata, command payloads, or certificate material in metrics or logs.

## SQLite to PostgreSQL migration

Migration is offline: stop all central backend writers first. Do not use the edge
SQLite journal as a source. Take and retain a recoverable copy of the central
SQLite file, then validate without writes:

```sh
DATABASE_URL='<target secret supplied by the environment>' \
CENTRAL_DATABASE_TYPE=postgres \
POSTGRES_SSL_MODE=verify-full \
npm run migrate:sqlite-to-postgres -- --source /absolute/path/alpacaly.sqlite --dry-run
```

For the real migration, use a dedicated empty target and explicit approval:

```sh
npm run migrate:sqlite-to-postgres -- \
  --source /absolute/path/alpacaly.sqlite \
  --approve-empty-target
```

The tool rejects non-central/edge databases, corrupt sources, foreign-key
violations, non-empty target domain tables, missing approval, and unknown
arguments. It applies the production schema, copies tables in dependency order
inside one transaction, defers approved circular relationships, resets identity
and Event sequences, converts abandoned active claims into retryable offline
recovery records, validates row counts and constraints, and rolls back on any
failure. Its reconciliation report contains counts only and never prints the
target URL. Keep the source and target unchanged until application-level sample
checks and the reconciliation report are approved.

## Tests and contention baseline

SQLite tests run with `npm test`. Real PostgreSQL tests require a disposable
PostgreSQL database:

```sh
POSTGRES_TEST_URL=postgresql://... POSTGRES_TEST_SSL_MODE=disable npm run test:postgres
```

The PostgreSQL suite applies real DDL/triggers, executes a Contribution-to-Event
flow, and starts two independent Node processes racing for one claim. CI supplies
PostgreSQL 16 and runs the full suite. A skipped PostgreSQL test is acceptable
only when `POSTGRES_TEST_URL` is absent locally; CI must not skip it.

The bounded contention baseline requires a disposable database and explicit
write approval:

```sh
POSTGRES_BENCHMARK_URL=postgresql://... \
npm run benchmark:postgres-contention -- \
  --approve-test-database --workers 4 --items 500
```

It verifies one completion per unique item and reports attempts, wall time,
throughput, and per-worker duration. Capture the output with environment,
PostgreSQL version, CPU/memory, connection settings, and commit ID before using it
as a capacity baseline. Never run it against production.

## Rollout and rollback

Before rollout, run the full SQLite and PostgreSQL suites, source migration dry
run, a disposable end-to-end migration rehearsal, and a contention baseline.
Deploy PostgreSQL configuration to one instance, verify readiness, schema,
backlogs, and claim history, then add instances gradually. Stop rollout on growing
pool waits, repeated lease reclaims, dead letters, operator-review growth, or
domain reconciliation differences.

Schema migrations are forward-only. Application rollback is allowed only to a
version that recognizes the current schema checksum/version. Never point an old
SQLite-writing production binary at migrated traffic. Data rollback means stop
writers and execute the separately approved restore/cutover plan; it is not an
automatic application fallback.

Backup, point-in-time recovery, restore drills, retention, recovery objectives,
and production cutover ownership are deliberately Phase 7F-2B. See
[`phase-7f-2b-backup-restore.md`](phase-7f-2b-backup-restore.md).
