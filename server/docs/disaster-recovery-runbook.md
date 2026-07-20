# Disaster-recovery runbook

This runbook is a practical draft for review. It is not authority to operate a
production service and its recovery targets are proposals, not promises.

## Authority and roles

- The incident commander may declare a central database incident and owns the
  timeline and communications.
- A platform Administrator may stop application writers and activate a platform
  software emergency stop.
- Welfare and hardware authorities must confirm the physical stop and edge state.
- The database recovery operator selects and restores a backup but cannot approve
  worker release alone.
- A separate recovery reviewer approves reconciliation evidence.
- The supervised-release decision must name the incident/change record and the
  accountable platform, welfare, and hardware people.

Record every person, time, decision ID, command result, report ID, and exception.

## Proposed targets for review

| Target | Proposal | Status |
| --- | --- | --- |
| RPO | 15 minutes once managed PITR/WAL is available; otherwise no production claim | Not approved |
| RTO | 4 hours for a supervised central restore and reconciliation | Not approved |
| Native/base backup | Daily | Not approved |
| WAL/PITR | Continuous with monitored gaps | Requires provider |
| Daily retention | 14 days | Not approved |
| Weekly retention | 8 weeks | Not approved |
| Monthly retention | 12 months | Not approved |
| Restore drill | Monthly and after material schema/safety changes | Not approved |

## Incident procedure

### 1. Declare and contain

1. Open the incident record and appoint incident commander, recovery operator,
   welfare authority, hardware authority, reviewer, and communications owner.
2. Stop all central application writers and deployments. Remove service traffic
   or scale application instances to zero.
3. Activate the platform software emergency stop if the database is still
   reachable. Apply the approved physical/electrical feeder stop independently.
4. Confirm all Device Command and FeedIntent workers are stopped. Stop MQTT
   publishing authority. Do not assume network isolation stopped physical state.
5. Preserve database, provider, application, broker, and edge-controller logs.
6. Record whether any command was `SENT`, `STARTED`, timed out, or awaiting an
   acknowledgement when containment began.

### 2. Identify recovery point

1. Establish the first known-bad time and last known-good application, database,
   migration, provider, and edge evidence.
2. List candidate backups and PITR points using catalogue/provider metadata.
3. Check backup completion, checksum, PostgreSQL version, application version,
   schema migration, encryption, retention/hold, and last restore test.
4. Select a conservative recovery point. Record expected data loss relative to
   the proposed RPO; do not conceal that uncertainty.
5. Preserve the failed database and selected backup until recovery is approved.

### 3. Restore in isolation

1. Provision a new empty PostgreSQL database in an isolated network/project with
   no application or broker access.
2. Use a separate restore role. Confirm the target is not the active database.
3. Run checksum and manifest validation.
4. Restore with `npm run restore:postgres` and explicit empty-target approval.
5. Confirm the restore report says workers and feeding were never started.
6. If restore fails, keep recovery mode blocked, retain evidence, create a new
   isolated target, and either try another recovery point or roll back the plan.

### 4. Reconcile domain state

1. Review every reconciliation check and table count against the source/provider
   evidence and expected recovery point.
2. Confirm all old worker identities are stale and every restored active claim has
   a `RESTORE_FENCED` history entry with a newer generation.
3. Confirm completed/dead-letter claims did not regress.
4. Review every restored Device Command classification:
   - completed stays completed;
   - proven-not-sent remains locked until deliberate release;
   - `SENT`, timed-out, or acknowledgement-uncertain work remains review-required;
   - `OUTCOME_UNKNOWN` remains terminal and linked to an open/approved resolution.
5. Compare emergency stops, approvals, operator-resolution cases, audit history,
   administrators, roles, Barn scopes, controller assignments, and generations.
6. Compare the independent Barn edge journals/controller boot IDs, fencing tokens,
   execution records, welfare counters, and delayed acknowledgements. Never import
   the edge SQLite journal into PostgreSQL.
7. Confirm software and physical stops still hold and read-only diagnostics show
   recovery mode blocked.
8. A `BLOCKED` report ends the release path. Assign remediation and rerun against
   a new restore or after an evidence-preserving correction.

### 5. Supervised release

1. Obtain a recorded recovery-review decision for proven-not-sent work. Run the
   safe-work release command only for that class.
2. Leave uncertain and OUTCOME_UNKNOWN commands individually locked.
3. Run reconciliation again and record `PASS` or accepted `WARNING` rationale.
4. Obtain the separate supervised worker-release decision.
5. Release workers in the isolated environment first. Start one application
   instance with public writes still disabled and MQTT/physical delivery blocked.
6. Verify readiness, schema, claims, Event and Device Command counts, audit
   counters, emergency stops, controller generations, queue idempotency, and no
   duplicate Feed Request/Device Command.
7. Compare the edge state again. Re-establish MQTT authority only after hardware
   and welfare approval.
8. Cut over the connection secret/DNS through the approved deployment process.
9. Add one instance at a time. Monitor claim reclaims, command reviews, unknown
   outcomes, dead letters, database locks, pool waiters, and backup/PITR health.
10. Remove software/physical stops only through their existing dual-approval
    workflows. Recovery release never clears them.

### 6. Rollback

Rollback immediately if reconciliation regresses, claims become active before
approval, a reviewed command publishes, controller generation differs, audit
evidence is missing, readiness fails, or domain counts diverge.

Stop writers and command authority again. Re-enable the platform and physical
stops. Do not point an older binary at a newer unsupported schema. Return to the
preserved failed database only if the incident commander and database authority
approve it and it is safe; otherwise restore a different point into another new
isolated target.

## Communications

- Staff: incident status, safety state, operational restrictions, assigned roles,
  decision deadlines, and where evidence is recorded.
- Welfare/hardware teams: affected Barns/Feeders, physical checks, uncertain
  commands, and explicit instruction not to bypass stops.
- Supporters: only when service availability or accepted contributions are
  affected; use plain language, avoid exposing security or personal data, and do
  not promise a recovery time before evidence supports it.
- Regulators/partners: follow the approved privacy, welfare, security, and breach
  process; this runbook does not determine notification thresholds.

## Closeout

Record actual RPO/RTO, restored point, data loss, reports, decision IDs, command
reviews, communications, defects, owners, and due dates. Preserve evidence under
incident hold. Schedule a follow-up restore drill. Delete disposable targets and
test artifacts only through approved provider/test cleanup with deletion audit
evidence; production backup deletion remains provider/policy controlled.
