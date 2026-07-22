# Phase 7F-2B1 backup, restore, and disaster recovery

Phase 7F-2B1 adds provider-neutral tooling for native PostgreSQL backups,
isolated restores, recovery safety, domain reconciliation, restored ownership,
catalogue metadata, retention review, protected diagnostics, and a disposable CI
restore drill. It does not create a managed service or claim production recovery
readiness.

The implementation is split across:

- [PostgreSQL backup and restore](postgresql-backup-restore.md): commands,
  manifests, checksums, safety mode, reconciliation, catalogue, retention,
  observability, CI, and limitations.
- [Disaster-recovery runbook](disaster-recovery-runbook.md): incident authority,
  stopping writers, recovery-point selection, isolated restore, review, supervised
  release, rollback, and communication.
- [Managed PostgreSQL handoff](managed-postgresql-handoff.md): requirements and
  the exact recommendation for the later managed-staging phase.

The Barn edge-controller SQLite journal is deliberately outside the central
PostgreSQL backup. It must be compared during recovery but never copied into or
replaced by the central restore.

No backup payload, database credential, encryption key, payment credential, or
physical-device secret is stored in the application database or repository.
