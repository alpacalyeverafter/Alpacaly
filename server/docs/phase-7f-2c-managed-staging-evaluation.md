# Phase 7F-2C provider-neutral managed staging evaluation

Phase 7F-2C provides a provider-neutral framework for comparing managed
PostgreSQL staging candidates. It records safe capability evidence, measures PITR
and restore drills, checks security and portability gates, and captures
independent sign-off. It does not select, purchase, provision, or connect a
provider and cannot make a production-readiness claim.

The framework extends the verified 7F-2B1 restore controls and 7F-2B2 managed
backup evidence boundary. It does not alter the Event Engine, worker claims,
emergency stops, `OUTCOME_UNKNOWN` handling, recovery safety mode, Device Command
classification, checksums, isolated restore, or append-only platform audit
history.

## Why there is no database migration

Candidate assessment is pre-provider governance evidence, not live platform
state. Assessments and sign-off events are therefore stored as owner-only,
append-only files in a protected absolute directory outside the repository. This
avoids placing provider-selection workflow inside the central operational
database or the independent Barn edge journal. A later approved identity and
records platform may replace this storage boundary after governance review.

## Assessment contract

[`managed-staging-assessment.schema.json`](managed-staging-assessment.schema.json)
defines version 1. The implementation accepts only the documented fields and
rejects password-, token-, credential-, private-key-, connection-string-, and
database-URL-shaped fields.

An assessment records:

- safe provider, service, region, and PostgreSQL-version labels;
- managed PostgreSQL, encryption, backup, PITR, isolated restore, native export,
  and monitoring capabilities;
- TLS minimum, hostname verification, private networking, disabled public access,
  managed secret use, rotation, MFA, and administrative audit logging;
- separate application, migration, backup, restore, monitoring, and controlled
  break-glass roles;
- a PITR plan, known transaction boundary, WAL-continuity check, test result, and
  measured RPO against a proposed target;
- isolated restore evidence, checksum and reconciliation result, preserved worker
  blocks, preserved uncertain-command blocks, preserved emergency stops, and
  measured restore/reconciliation/supervised-release times;
- native dump/restore, tested export, extension inventory, proprietary
  dependencies, exit plan, and lock-in risk;
- cost estimate, currency, support evidence and response, service-limit review,
  incident-history review, and monitoring-plan review;
- reviewed UK region, data-transfer assessment, privacy reference, and welfare
  review reference.

The normalized assessment receives a SHA-256 digest. Rewriting a stored field
without the original digest causes evaluation to fail closed. The digest is not
a provider signature and does not prove that source evidence is true.

## Restore-drill scoring and RPO/RTO capture

The restore-drill score is calculated from six equally weighted safety controls:

1. the drill status is `PASS`;
2. the backup checksum was verified;
3. domain reconciliation passed;
4. workers remained blocked;
5. uncertain Device Commands remained blocked;
6. emergency stops remained preserved.

All six controls are required for a score of 100. RTO evidence is the sum of the
measured restore, reconciliation, and supervised-release durations. RPO evidence
is captured independently from the PITR drill. Exceeding either proposed target
returns `BLOCKED`; it does not silently redefine the target.

## Readiness gates

Every result contains one of:

- `BLOCKED`: critical evidence, safety, measurement, or approval is missing,
  contradictory, expired, rejected, or unsafe;
- `WARNING`: all critical staging gates and sign-offs pass, but a reviewed concern
  remains, such as provider-specific dependencies, non-low lock-in risk, or a
  support response slower than the proposed RTO;
- `PASS`: the recorded provider-neutral staging evaluation gates and all required
  sign-offs pass with no warning.

All three results always contain:

```json
{
  "scope": "MANAGED_STAGING_EVALUATION_ONLY",
  "productionReadiness": false,
  "productionUseAuthorized": false,
  "externalConnectionsAuthorized": false
}
```

`PASS` means only that a candidate may proceed to the next supervised staging
review. It never authorizes production, public feeding, payments, production
MQTT, cameras, or physical hardware.

## Independent sign-off workflow

The default approval request requires distinct `TECHNICAL`, `SECURITY`,
`OPERATIONS`, `DATA_GOVERNANCE`, and `FINANCE` authorities. The requester cannot
approve their own assessment. Each authority gets one immutable decision; a
rejection or material evidence change requires a new immutable assessment and
approval request.

Approval events contain sequence numbers, a previous-event digest, and their own
payload digest. Missing, reordered, modified, replayed, expired, rejected, or
assessment-digest-mismatched evidence blocks evaluation. Authority references are
safe opaque identifiers only. This phase records decisions but does not
authenticate them through a managed identity provider; that is a required next
review boundary.

## Evaluation command

Store the input file outside the repository, with no secrets, and run:

```sh
cd server
npm run evaluate:managed-staging -- \
  --assessment /absolute/ephemeral/candidate-assessment.json \
  --directory /absolute/protected/staging-evaluation-catalogue \
  --approval-directory /absolute/protected/staging-evaluation-catalogue \
  --maximum-assessment-age-days 30
```

The command records the assessment once and writes an append-only evaluation
record. It exits with status `2` for `BLOCKED`. Approval decisions must arrive
through a future protected identity-backed adapter using
`ManagedStagingEvaluationService`; this phase deliberately does not provide an
unauthenticated sign-off CLI.

## Safety and evidence limitations

- No provider API, account, database, network, or secret manager is connected.
- No provider is recommended or selected by the software.
- Cost and support values are evidence for human comparison, not purchasing
  authority or contractual advice.
- Local SHA-256 chains reveal mutation but are not digital signatures or provider
  attestations.
- The evaluation catalogue still needs approved encrypted, access-controlled,
  replicated storage and lifecycle controls.
- Provider TLS, networking, PITR, WAL continuity, support, cost, portability, and
  deletion claims must be verified independently in a disposable staging account.
- The Barn edge journal remains independent and must be compared during recovery.
- Restore workers remain blocked under the existing recovery-safety rules; this
  framework has no release path into the Event Engine.

## Recommended next review

Review this framework with technical, security, operations, data-governance, and
finance owners before evaluating real candidates. Then prepare two or more
redacted candidate assessment packs from published documentation only. Do not
open an account or enter credentials until the schema, gate severity, approval
authorities, proposed RPO/RTO, evidence storage, and identity-backed sign-off
adapter have been approved.
