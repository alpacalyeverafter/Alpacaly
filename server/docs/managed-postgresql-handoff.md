# Managed PostgreSQL staging handoff

Phase 7F-2B2 now provides the provider-neutral evidence, monitoring, and hold
contract described in
[managed backup operations](phase-7f-2b2-managed-backup-operations.md). A real
provider exporter, staging account, alert route, measured drills, and governance
approval are still outstanding, so the requirements below remain the handoff for
the managed-staging evaluation rather than a completed provider selection.

The provider-neutral assessment, scoring, and sign-off contract for that review
is now defined in
[Phase 7F-2C managed staging evaluation](phase-7f-2c-managed-staging-evaluation.md).
It does not replace the provider validation evidence below.

Phase 7F-2B1 does not select or purchase a managed provider. The later staging
phase must evaluate and record the following before any production claim.

## Required capabilities

- PostgreSQL 16 or newer with a documented version/extension lifecycle;
- encrypted storage, encrypted native backups, and point-in-time recovery;
- continuous WAL with gap monitoring and a tested recovery-point selector;
- TLS with hostname and certificate verification and customer CA support;
- isolated restore to a new database/project/network without application writers;
- separate least-privilege application, migration, backup, restore, monitoring,
  and human break-glass roles;
- secret-manager integration, credential rotation, MFA, access logs, and auditable
  administrative actions;
- backup age/failure, restore/PITR, WAL, disk, IOPS, CPU, memory, connection,
  replication, lock, and maintenance monitoring with alert routing;
- retention, legal/incident hold, export, and verifiable secure-deletion controls;
- regional placement and transfer controls appropriate to UK data protection,
  animal-welfare operations, contracts, and the documented privacy assessment;
- restore and export portability without proprietary lock-in blocking recovery;
- published service limits for storage, connections, backup size, restore time,
  WAL/PITR window, maintenance, failover, and regional availability;
- incident history/status transparency, support response targets, escalation path,
  and a support tier appropriate to the reviewed RTO;
- cost controls and test/staging environments that can run monthly restore drills.

## Validation evidence

The managed-staging phase must:

1. provision separate staging application and backup/restore identities;
2. store all credentials and keys in managed secret/key systems;
3. run this repository's full PostgreSQL and backup/restore suites;
4. take a provider-encrypted backup and restore it into a new isolated target;
5. verify checksum/catalogue evidence and provider backup metadata;
6. reconcile representative safety and domain data;
7. measure backup duration, restore duration, reconciliation duration, and total
   supervised release time against proposed RPO/RTO;
8. test PITR on both sides of a known transaction and verify WAL continuity;
9. prove the application/backup roles cannot perform each other's privileged work;
10. prove recovered workers remain blocked until a recorded release;
11. verify uncertain commands and active stops cannot be replayed or cleared;
12. verify monitoring alerts on backup failure, excessive age, WAL gaps, restore
    drill age, storage pressure, connection saturation, and reconciliation block;
13. rehearse rollback and document provider support escalation;
14. obtain security, privacy, welfare, hardware, operations, and finance review.

## Exact recommendation

Run a time-boxed managed-staging evaluation using PostgreSQL 16+, a UK region,
provider-managed encryption, continuous PITR, separate application and
backup/restore roles, private networking, verified TLS, and an isolated restore
project. Execute at least two full restore drills—including one PITR drill—and
measure end-to-end supervised recovery before selecting the provider or approving
RPO, RTO, retention, support tier, or production use. Do not connect payments,
public feeding, production MQTT, cameras, or physical hardware during that
evaluation.
