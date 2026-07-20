# Phase 7F-2B handoff: backup, restore, and disaster recovery

Phase 7F-2A establishes PostgreSQL persistence, migrations, offline SQLite data
transfer, distributed ownership, and diagnostic signals. It does **not** claim
that production backup and disaster recovery are complete.

Phase 7F-2B must select and validate the production backup mechanism and produce
an approved runbook covering:

- encrypted base backups and continuous WAL archiving suitable for point-in-time
  recovery;
- backup/restore roles separated from the application role;
- secret, key, region, retention, legal, privacy, and secure-deletion policy;
- explicit recovery point and recovery time objectives;
- automated backup success, age, integrity, capacity, and WAL-gap monitoring;
- restore into an isolated network/database with no application writers;
- checksum, schema migration, constraint, row-count, audit-chain, FeedIntent,
  Event, command, acknowledgement, claim, and operator-safety reconciliation;
- treatment of claims that were active at the recovery point;
- protection against replaying a physical DeviceCommand after restore;
- DNS/connection-string cutover, readiness validation, rollback authority, and
  incident communication;
- scheduled restore drills with recorded evidence, timings, defects, owners, and
  remediation dates; and
- proof that expired backups and temporary restore copies are removed safely.

The restore safety rule is conservative: no DeviceCommand with an uncertain or
possibly completed physical outcome may be automatically retried. Restored active
claims must be fenced and reconciled; device execution journals, acknowledgement
evidence, operator-resolution cases, emergency stops, welfare accounting, and
edge-controller state must be checked before command workers resume.

7F-2B should use a disposable environment first, then a controlled production
drill. A successful database restore alone is insufficient—the restored service
must pass readiness and domain-level reconciliation without weakening welfare or
hardware safety.
