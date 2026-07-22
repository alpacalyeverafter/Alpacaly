# PostgreSQL backup and isolated restore

## Safety boundary

These tools operate only in `test` and `staging` during Phase 7F-2B1. They never
start the HTTP service, FeedIntent worker, lifecycle worker, Device Command
worker, MQTT transport, controller, or physical feeder. Restore requires a
separate explicitly identified database and refuses the configured active
database. The independent Barn edge journal is not part of the backup.

A backup command completing successfully proves only that PostgreSQL produced an
artifact and that a checksum and manifest were recorded. Recoverability is shown
only by a later isolated restore and domain reconciliation.

## Backup command

Requirements:

- PostgreSQL central persistence and a deployment-supplied `DATABASE_URL`;
- `pg_dump` compatible with the PostgreSQL server;
- an absolute output directory outside the repository and home-directory root;
- `NODE_ENV=test` or `NODE_ENV=staging`.

Example:

```sh
cd server
CENTRAL_DATABASE_TYPE=postgres \
DATABASE_URL='<secret from the deployment secret store>' \
POSTGRES_SSL_MODE=verify-full \
NODE_ENV=staging \
npm run backup:postgres -- \
  --output-dir /absolute/encrypted/catalogue \
  --cadence daily \
  --compression 9
```

`pg_dump` uses custom format, schema and data, owner/privilege exclusion,
compression, and a serializable deferrable consistent snapshot. Credentials are
passed through the child-process environment rather than command arguments. A
partial artifact is renamed only after `pg_dump` succeeds. The command records
`BACKUP_STARTED`, `BACKUP_COMPLETED`, or `BACKUP_FAILED` operation evidence
without a connection string.

The output directory must not be a Git working tree. Keep backup extensions and
catalogue directories in `.gitignore` at the deployment repository level as an
additional control. This repository does not contain backup files.

## Manifest format

Each `<backup-id>.dump` has a sibling `<backup-id>.manifest.json`:

```json
{
  "manifestVersion": 1,
  "backupId": "backup-2026-07-20T10-00-00-000Z-...",
  "createdAt": "2026-07-20T10:00:00.000Z",
  "environment": "staging",
  "sourceDatabaseIdentity": "sha256:<sanitized database identity>",
  "migrationVersion": 4,
  "applicationVersion": "1.0.0",
  "postgresVersion": "16.x",
  "artifact": {
    "fileName": "<backup-id>.dump",
    "format": "POSTGRES_CUSTOM",
    "compression": "pg_dump custom level 9",
    "sizeBytes": 12345,
    "checksumAlgorithm": "SHA-256",
    "checksum": "<64 hexadecimal characters>"
  },
  "encryption": {
    "status": "NONE",
    "provider": null,
    "verifiedByBackupTool": false
  },
  "retentionExpiresAt": "2026-08-03T10:00:00.000Z",
  "legalOrIncidentHold": false,
  "restoreTest": {
    "status": "NOT_TESTED",
    "lastTestedAt": null,
    "mostRecentSuccessfulAt": null,
    "reportId": null
  },
  "notes": null
}
```

The source identity is a SHA-256 digest of host, port, and database name. It is
used for equality checks without exposing hostnames, users, passwords, or query
parameters. The artifact filename cannot contain a path. Manifest compatibility,
format, migration version, and checksum are validated before restore tooling is
allowed to run.

## Checksum handling

SHA-256 covers the exact backup payload. Restore recalculates it from the sibling
artifact. A mismatch produces `BACKUP_CHECKSUM_FAILED`, writes a failed restore
report, and performs no restore. Updating restore-test evidence changes only the
manifest; it does not change or weaken the artifact checksum.

Checksums detect accidental or malicious payload changes but do not replace
authenticated encrypted storage, access control, provider integrity controls, or
independent restore tests.

## Restore command

Create an isolated empty database through the provider or disposable test
cluster. Do not connect an application service to it.

```sh
RESTORE_DATABASE_URL='<isolated target secret>' \
DATABASE_URL='<currently active database secret, used only for refusal checks>' \
npm run restore:postgres -- \
  --manifest /absolute/encrypted/catalogue/<backup-id>.manifest.json \
  --target-environment staging \
  --isolated-target \
  --approve-empty-target
```

The command:

1. validates environment, isolation, target identity, manifest, schema support,
   checksum, and `pg_restore` availability;
2. rejects the active application database;
3. requires explicit approval for an empty database;
4. rejects a non-empty target unless `--approve-destructive` and
   `--confirm-target <exact-database-name>` are both supplied;
5. restores schema and data with no owner or privilege replay;
6. refuses future schemas;
7. refuses older-schema migration unless `--approve-migrations` is explicit;
8. persists `RecoverySafetyState.mode=BLOCKED` before any application startup;
9. classifies restored commands and fences restored active claims;
10. runs domain reconciliation and records a machine-readable restore report;
11. leaves every worker stopped and feeding disabled.

Destructive approval is suitable only for a confirmed disposable isolated
target. The tool drops and recreates that target's `public` schema; it never
deletes or recreates a database and never operates against the active database.

## Recovery safety mode

Recovery state is stored in the central database and may also be forced through
`RECOVERY_SAFETY_MODE=true`. Either block prevents:

- FeedIntent polling and direct processing;
- Feed Request creation from pending work;
- Event lifecycle processing;
- Device Command creation and delivery;
- device transport startup;
- controller, device, and feeder enablement;
- replacement command creation.

Public liveness remains available, but readiness returns `503`. Protected
read-only administration and reconciliation remain available. Application
startup sees the persisted block before worker registration, so a deployment
configuration mistake cannot resume a restored queue.

There is no automatic release. Re-run reconciliation if evidence changes:

```sh
RESTORE_DATABASE_URL='<isolated target secret>' \
npm run reconcile:postgres-restore -- \
  --target-environment staging \
  --isolated-target
```

Proven-not-sent work and global workers are separate decisions:

```sh
RESTORE_DATABASE_URL='<isolated target secret>' \
npm run release:postgres-recovery -- \
  --target-environment staging \
  --isolated-target \
  --confirm-target '<exact-database-name>' \
  --decision-id '<incident/change decision ID>' \
  --release-safe-work

RESTORE_DATABASE_URL='<isolated target secret>' \
npm run release:postgres-recovery -- \
  --target-environment staging \
  --isolated-target \
  --confirm-target '<exact-database-name>' \
  --decision-id '<supervised release decision ID>' \
  --release-workers
```

Worker release requires a `PASS` or `WARNING` reconciliation and zero active
restored claims. Individually reviewed uncertain commands remain locked after a
global release.

## Restored claims

Restore increments the claim generation of every `ACTIVE` claim, removes its
worker and lease, marks old running worker identities `STALE`, and appends a
`RESTORE_FENCED` history entry. This makes old process and boot identities
non-authoritative.

- safe pre-domain work becomes `AVAILABLE` only while the global recovery block
  is still active;
- active Device Command work classified uncertain becomes `OPERATOR_REVIEW`;
- `COMPLETED` claims remain completed;
- `DEAD_LETTER` and existing `OPERATOR_REVIEW` state remains visible;
- claim history is append-only and is never rewritten.

## Restored Device Commands

Every command is entered in `RestoredCommandReviews`:

| Evidence | Classification | Restore behavior |
| --- | --- | --- |
| `ACKNOWLEDGED` or `CANCELLED` | `COMPLETED` | Remains terminal; no delivery. |
| `PENDING`, `READY`, `RETRY_SCHEDULED`, or safe `FAILED` with no `STARTED`/`SUCCEEDED` evidence | `PROVEN_NOT_SENT` | Locked until a deliberate safe-work decision. |
| `SENT`, `TIMED_OUT`, or any unsafe acknowledgement evidence | `UNCERTAIN` | Operator review required; never automatically published. |
| `OUTCOME_UNKNOWN` | `OUTCOME_UNKNOWN` | Remains terminal and feeder-blocked through its resolution case. |

The existing acknowledgement service remains idempotent. A late acknowledgement
cannot revive or repeat `OUTCOME_UNKNOWN`. Assignment generation, command fencing
token, execution journals, and controller identity remain authoritative.

## Reconciliation

The report is `PASS`, `WARNING`, or `BLOCKED`. It checks:

- supported schema migration version and recovery safety mode;
- required table counts and foreign-key validation;
- duplicate domain identities;
- ProviderEvent → Contribution → FeedIntent → Event relationships;
- Event lifecycle histories;
- Device Command and acknowledgement histories;
- administrator role and approval relationships;
- emergency stops, approvals, open resolution cases, and audit counts;
- controller assignments and positive assignment generations;
- active, operator-review, completed, and dead-letter claims;
- uncertain command review coverage and OUTCOME_UNKNOWN resolution cases;
- append-only audit-trigger evidence.

Any unsupported schema, missing table, integrity relationship failure, active
claim, unprotected uncertain command, missing OUTCOME_UNKNOWN case, invalid
assignment generation, or missing immutability evidence is `BLOCKED`. Dead-letter
work is a `WARNING` because it remains visible and requires review. A `BLOCKED`
result cannot release workers.

## Catalogue and retention

The catalogue reads manifests and reports from an external directory. Backup
payloads are never stored in PostgreSQL. It exposes only safe metadata: backup
ID, time, environment, sanitized source identity, versions, checksum status,
size, format, encryption metadata, expiry, restore-test status, most recent
successful restore test, and notes.

Default review values are daily 14 days, weekly 8 weeks, monthly 12 months, and
a 7-day minimum. An incident/legal hold has no calculated expiry. The cleanup
command is explicit and test-only:

```sh
npm run cleanup:test-backups -- \
  --directory /absolute/test/catalogue \
  --approve-test-deletion
```

It refuses staging/production manifests and writes deletion audit evidence. No
production deletion is scheduled or automatic in this phase.

Phase 7F-2B2 adds append-only incident/legal hold events. An active registry hold
removes its backup from expiry and deletion calculations without rewriting the
manifest or payload; releasing a hold requires a new recorded decision and never
deletes the backup. Managed-provider backup/PITR evidence and hold commands are
documented in
[managed backup operations](phase-7f-2b2-managed-backup-operations.md).

## Encryption boundary

No custom cryptography is implemented. Encryption must be supplied by one or
more of:

- managed PostgreSQL encrypted backups and point-in-time recovery;
- encrypted object storage with restricted service identities;
- deployment key/secret management and an approved external encryption tool;
- an optional externally managed local-test encryption wrapper.

The manifest records encryption status/provider metadata but does not treat that
claim as cryptographic proof. The eventual provider must own key generation,
rotation, recovery, separation of duties, access logs, secure deletion, and
regional storage policy. Never commit keys or place them on command lines.

## Protected diagnostics and observability

Platform Administrators with `MANAGE_SECURITY_CONFIGURATION` receive
`disasterRecovery` inside `GET /api/admin/diagnostics/persistence`, including:

- latest backup and age, checksum-recorded status, restore-test evidence;
- overdue backup/restore drill and expired-backup counts;
- persisted/configured safety mode and whether workers are blocked;
- reconciliation result and time;
- restored claim and Device Command review counts;
- structured disaster-recovery event counters;
- retention configuration and the fact production deletion is disabled.

Paths, hosts, database names, credentials, keys, raw manifests, supporter data,
and command payloads are omitted. Structured evidence covers backup started,
completed and failed; checksum failure; restore started, completed and failed;
blocked reconciliation; recovery mode; fenced claims; uncertain commands; safe
work release; worker release; expired backups; and overdue restore drills.

## GitHub Actions restore drill

The PostgreSQL workflow uses its disposable PostgreSQL 16 service and local test
credentials. It verifies `pg_dump` and `pg_restore`, then runs the full suite.
The drill creates unique source and target databases, representative ledger,
Event, Device Command, emergency-stop, OUTCOME_UNKNOWN, audit, active-claim, and
completed-claim data. It backs up the source, rejects a non-empty restore target,
restores the isolated target, reconciles, confirms workers remain blocked,
releases only safe work deliberately, and verifies no duplicate Event or command.
Temporary databases and files are removed.

Ordinary local `npm test` requires no PostgreSQL installation. PostgreSQL tests
show as skipped when `POSTGRES_TEST_URL` is absent. A CI skip is not acceptable.

## Limitations

- No production backup, managed provider, object storage, WAL archive, or PITR is
  configured.
- No final RPO, RTO, retention, legal-hold, data-region, or deletion policy is
  approved.
- Manifests are not cryptographically signed.
- Backup catalogue evidence is filesystem/object-store metadata, not a managed
  immutable catalogue service.
- Release commands are CLI-only and depend on an approved operational identity
  boundary in the later managed phase.
- Central restore cannot prove Barn edge execution state; the runbook requires a
  separate edge comparison.
- A successful CI drill proves the repository workflow against disposable
  PostgreSQL 16, not managed-provider recovery performance.
