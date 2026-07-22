# Phase 7F-2B2 managed backup operations

Phase 7F-2B2 turns the 7F-2B1 backup/restore foundation into a
provider-neutral operational control surface. It imports allow-listed managed
PostgreSQL evidence, records it append-only, checks backup and PITR health,
exposes secret-free administrator diagnostics, and protects backup retention
with explicit incident/legal holds.

It does not select a provider, call a provider with embedded credentials, approve
RPO/RTO or retention, enable automatic production deletion, or make a production
recovery-readiness claim. An environment-specific exporter and alert route remain
deployment responsibilities.

## Operational boundary

The deployment owns a least-privilege provider exporter. That exporter queries
the managed PostgreSQL control plane, maps the result to
[`managed-backup-evidence.schema.json`](managed-backup-evidence.schema.json), and
writes a short-lived file outside the repository. The application never receives
the provider credential.

The import command:

1. rejects password-, secret-, token-, credential-, private-key-, and
   connection-string-shaped fields anywhere in the input;
2. validates the allow-listed evidence fields and sanitized database identity;
3. calculates a SHA-256 digest over the normalized safe payload;
4. writes the evidence and check record append-only with owner-only permissions;
5. exits with status `2` when any required managed control is blocked.

A digest detects later evidence-file mutation. It is not a provider signature or
proof that the exporter told the truth. Provider audit logs and independent
restore drills remain authoritative supporting evidence.

## Evidence contract

Evidence version 1 records only:

- collection ID, time, source, and exporter version;
- environment, provider/service label, region, and an optional safe backup
  reference;
- a SHA-256 database identity and PostgreSQL version;
- latest backup status/time, provider-reported encryption, key-management class,
  restorability, and retention days;
- PITR enablement, continuity, recovery window, latest WAL time, and gap status;
- application/backup/restore role separation, human MFA, and administrative
  audit logging.

Do not add account IDs, resource URLs, credentials, encryption keys, connection
strings, raw provider responses, database names, hostnames, personal data, backup
payloads, or Device Command payloads.

## Scheduled check

Run the provider exporter and check from the deployment scheduler at least every
five minutes for a proposed 15-minute RPO. Use a single-run job with overlap
prevention, a bounded execution deadline, retries owned by the scheduler, and an
alert on any non-zero exit. Never run it inside an application web worker.

```sh
cd server
npm run check:managed-backups -- \
  --evidence /absolute/ephemeral/provider-evidence.json \
  --directory /absolute/protected/operations-catalogue \
  --restore-catalogue-directory /absolute/protected/restore-catalogue \
  --expected-environment staging \
  --expected-database-identity 'sha256:<sanitized expected identity>' \
  --expected-region uk-south \
  --maximum-evidence-age-minutes 30 \
  --maximum-backup-age-hours 24 \
  --rpo-minutes 15 \
  --minimum-retention-days 14 \
  --restore-drill-maximum-age-days 30
```

The scheduler should securely remove its ephemeral input after the append-only
record is accepted. Check records are suitable for log/metric forwarding because
they contain alert codes and safe metadata, but the deployment must test routing
to the on-call destination.

## Fail-closed checks

The result is `PASS` only when all of the following hold:

- evidence is current, not materially from the future, and matches the expected
  environment, sanitized database identity, and deployment-approved region;
- PostgreSQL is version 16 or newer;
- the latest backup is available, recent, encrypted, provider-reported
  restorable, and retained for at least the configured minimum;
- PITR is enabled and continuous, has a valid window, has no reported gap, and
  both the latest recovery point and WAL evidence meet the proposed RPO;
- application, backup, and restore duties are separated; human MFA and provider
  administrative audit logging are active;
- a recent successful isolated restore drill is recorded for a backup from the
  same source environment.

Missing, stale, contradictory, unsafe, or overdue evidence returns `BLOCKED` with
stable codes such as `MANAGED_BACKUP_OVERDUE`, `MANAGED_PITR_GAP_DETECTED`,
`MANAGED_PITR_RPO_EXCEEDED`, or `MANAGED_RESTORE_DRILL_OVERDUE`. A blocked result
must page the operational owner and must not be converted to green by retries
alone.

## Incident and legal holds

Holds are separate append-only events so applying a hold does not rewrite the
backup manifest or payload. An active registry hold makes the backup ineligible
for expiry/deletion calculations. Each event has a sequence, payload digest, and
previous-event digest; a missing, reordered, or modified event makes retention
evaluation fail closed.

```sh
npm run hold:postgres-backup -- \
  --directory /absolute/protected/catalogue \
  --apply \
  --backup-id '<backup-id>' \
  --hold-id '<unique incident/legal hold ID>' \
  --hold-type INCIDENT \
  --decision-id '<recorded authority decision>' \
  --authority-reference '<approved operator reference>' \
  --reason '<evidence-preserving reason>'

npm run hold:postgres-backup -- \
  --directory /absolute/protected/catalogue \
  --release \
  --hold-id '<same hold ID>' \
  --decision-id '<recorded release decision>' \
  --authority-reference '<approved operator reference>' \
  --reason '<approved release reason>'
```

Hold IDs cannot be replayed. A source manifest created with
`legalOrIncidentHold=true` cannot be released by the registry; it requires the
external authority that created that source hold. Releasing a registry hold does
not delete anything. Production deletion remains disabled.

## Administrator diagnostics

When `MANAGED_BACKUP_OPERATIONS_ENABLED=true`, protected persistence diagnostics
include the latest check status, alert codes, safe provider/service/region labels,
sanitized database identity, backup/WAL/recovery-point ages, restore-drill
evidence, thresholds, and active hold count. They exclude source file paths,
provider backup references, raw evidence, credentials, hosts, and database names.

## Managed-staging acceptance evidence

Before provider selection or production approval, retain evidence that:

1. the provider exporter uses a separate read-only monitoring identity;
2. repeated scheduled checks detect a forced backup failure, stale evidence, a
   simulated WAL gap, retention regression, role-separation regression, and an
   overdue restore drill;
3. every blocked code reaches the reviewed alert destination within the proposed
   response time;
4. a provider-encrypted backup restores into a new isolated target and passes
   the existing domain reconciliation;
5. two PITR drills recover on opposite sides of a known transaction and show no
   WAL gap;
6. an incident hold prevents expiry and its release leaves append-only evidence;
7. measured RPO, restore time, reconciliation time, and supervised release time
   are recorded without accepting the proposals as approved targets.

Keep public feeding, payments, production MQTT authority, cameras, and physical
hardware disconnected throughout the evaluation.

## Remaining limitations

- A provider-specific exporter and provider API tests are not in this repository.
- Evidence digests are not digital signatures or immutable-provider attestations.
- The local catalogue still needs approved encrypted, access-controlled,
  replicated storage and lifecycle management.
- Provider-native alerting, WAL-gap semantics, deletion, key rotation, access-log
  retention, support escalation, regional policy, final RPO/RTO, and final
  retention require provider and governance review.
- Central recovery still cannot prove Barn edge-controller state; the disaster
  recovery runbook's independent edge comparison remains mandatory.
