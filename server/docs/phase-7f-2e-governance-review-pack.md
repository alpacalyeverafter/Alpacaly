# Phase 7F-2E: governance review pack

## Outcome and boundary

Phase 7F-2E provides a provider-neutral, offline review pack for independent
technical, security, operations, data-governance and finance review of the two
Phase 7F-2D published-document candidate packs.

The initial and default outcome is `BLOCKED`. This phase does not rank,
recommend or select a provider. It does not authorize an account, credentials,
an API call, a database connection, resource provisioning, disposable staging
or production use. A completed governance review is still only an input to a
later, separately authorized disposable-staging decision.

The pack preserves the existing Event Engine, welfare limits, emergency stops,
`OUTCOME_UNKNOWN` handling, recovery safety mode, worker-claim fencing, backup,
restore and append-only audit boundaries. Published documentation cannot prove
those controls in a provider environment.

## Inputs

The review pack binds decisions to the exact SHA-256 digests of:

- `provider-candidate-aws-rds-postgresql-london-v1`
- `provider-candidate-google-cloud-sql-postgresql-london-v1`

Both candidate packs remain published-document reviews. Their claims are not
configuration evidence, contractual commitments, quotes or staging-test
results. The validator rejects candidate-pack tampering before building the
review pack.

## Create a blocked draft

The command is offline and writes JSON only to standard output:

```sh
npm run prepare:governance-review -- \
  --candidate docs/provider-candidates/aws-rds-postgresql-london.json \
  --candidate docs/provider-candidates/google-cloud-sql-postgresql-london.json \
  --requester governance-review-coordinator-01 \
  --created-at 2026-07-22T16:00:00.000Z
```

Use an opaque identity reference for `--requester`. Do not put a name, email,
credential, database URL, secret, provider account identifier or protected
evidence location into the pack. The generated draft is non-authoritative and
contains no decisions.

After editing the review sections, regenerate and validate the derived fields by
passing the draft back with `--review` and the same candidate files:

```sh
npm run prepare:governance-review -- \
  --candidate docs/provider-candidates/aws-rds-postgresql-london.json \
  --candidate docs/provider-candidates/google-cloud-sql-postgresql-london.json \
  --review /absolute/path/to/protected/review-draft.json
```

The command ignores derived summaries, outcomes and declarations from the input
file and calculates them again. It does not treat an edited repository file as
signed evidence. Keep authoritative drafts and decision records in the approved
external evidence store.

## Executive review summary

The five owners must review the same immutable candidate-pack digests and the
same proposed RPO/RTO worksheet. The pack deliberately provides no score,
ranking or selection recommendation. Its executive summary states:

- purpose: independent governance review before any disposable-staging decision;
- recommendation: `NO_PROVIDER_RANKING_OR_SELECTION`;
- outcome: `BLOCKED` until every required review is complete;
- next decision: whether the evidence is sufficient to request a separate,
  time-boxed disposable-staging authorization.

## Five-owner checklist

### Technical

- candidate schema, digest, scope and 22-control completeness;
- PostgreSQL 16 compatibility and native portability;
- recovery safety, worker fencing, emergency stops and uncertain commands;
- proposed RPO/RTO feasibility;
- technical open questions.

### Security

- encryption, TLS and hostname verification;
- private networking and disabled public access;
- least-privilege identities, secrets, rotation, MFA and break-glass access;
- administrative audit and protected evidence storage;
- security open questions.

### Operations

- backup, PITR, isolated restore, retention and restore drills;
- monitoring, limits and incident history;
- support and escalation;
- an RTO that includes reconciliation and supervised release;
- operations open questions.

### Data governance

- UK region and transfer paths;
- retention, deletion and legal/incident holds;
- evidence classification, access, retention and immutability;
- source freshness;
- data-governance open questions.

### Finance

- published pricing is not a quote or budget;
- full cost model including HA, backups, PITR, support and restore drills;
- support-plan and contractual-response evidence;
- cost implications of the proposed RPO/RTO;
- finance open questions.

Every checklist item starts incomplete and may carry only safe evidence
references. Completing a checklist is necessary but not sufficient for an
acceptable decision.

## Candidate open questions

The generator carries every open question from both candidate packs into the
review. Each is assigned to one or more authorities and begins `OPEN`. It may
become `ANSWERED` or `ACCEPTED_AS_CONDITION`, with a written response and safe
evidence references. Open questions keep the consolidated outcome `BLOCKED`.

The unresolved subjects include deployment shape, role separation, UK data
movement, support commitments, full cost and legal/incident holds. Neither
candidate is favoured by this list.

## Claim-severity review

Every Phase 7F-2C control appears once. A proposed severity expresses the impact
of missing or incorrect evidence, not candidate quality. Each row shows both
candidate claim statuses and follow-up verification types. Required owners must
record a final severity and review status:

- `PENDING`
- `ACCEPTED`
- `ACCEPTED_WITH_CONDITIONS`
- `REJECTED`

Pending or rejected claim review keeps the consolidated outcome `BLOCKED`.

## Proposed RPO/RTO worksheet

The draft proposes an RPO of 900 seconds and an RTO of 3600 seconds for review.
These are not service promises. The RTO includes database restoration,
checksum verification, reconciliation and supervised release while recovery
safety mode remains enabled. Emergency stops and `OUTCOME_UNKNOWN` commands
remain blocked. The worksheet must be marked `REVIEWED` by the independent
owners before the pack can leave `BLOCKED`.

## Evidence-storage review

Authoritative review evidence must be outside the repository in a protected
store with encryption, least-privilege access, retention, immutable decision
evidence and append-only history. No storage provider or encryption key is
selected here. The repository contains only the schema, validator, generator
and documentation. Until the evidence-storage review is `ACCEPTABLE`, the
outcome remains `BLOCKED`.

## Source-freshness register

Each official source is registered with its candidate pack, source ID, access
time, optional document date, age and maximum age. Future-dated evidence is
rejected. Sources older than the configured window become `STALE` and block the
review. A missing provider publication date remains visible as `null` rather
than being invented.

## Independent decisions and separation of duties

Exactly these authorities are required:

- `TECHNICAL`
- `SECURITY`
- `OPERATIONS`
- `DATA_GOVERNANCE`
- `FINANCE`

Each may record one of:

- `APPROVE`
- `APPROVE_WITH_CONDITIONS`
- `REJECT`
- `DEFER`

`APPROVE_WITH_CONDITIONS` requires explicit conditions. Every decision must
bind to every candidate-pack digest and to the exact review-basis digest covering
the checklists, answers, severity reviews, targets and evidence review. The
requester cannot decide, each authority must use a distinct reviewer reference,
and each decision ID must be unique.
Decisions belong in append-only external evidence; the generated draft does not
pretend that repository files are signed records.

The review coordinator first completes the review content without decisions and
regenerates the pack to obtain its final `reviewBasisDigest`. Each authority then
records its decision against that exact digest. Any subsequent change to an
answer, checklist, severity, proposed target or evidence review creates a new
basis digest and requires new decisions; earlier decisions must not be copied
forward.

The consolidated outcome stays `BLOCKED` when any authority is missing,
rejects, defers or has not completed its checklist, or when questions, claim
reviews, RPO/RTO, evidence storage or source freshness remain unresolved. When
all five decisions are independently acceptable the outcome may be
`REVIEW_COMPLETE` or `REVIEW_COMPLETE_WITH_CONDITIONS`. Neither status selects
a provider or authorizes staging or production.

## Risks and limitations

- Published claims do not prove configured behaviour.
- No quote, contract, support commitment or complete cost model was reviewed.
- UK region availability is not a completed privacy or transfer assessment.
- No account, API, database, PITR or restore-safety drill was used.
- Source material can change after collection.
- The review pack does not replace legal, privacy, financial or procurement
  advice and does not grant operational authority.

## Next decision

The five independent authorities must review the pack, resolve or condition its
questions, approve the proposed RPO/RTO and evidence boundary, and record
decisions against the exact candidate-pack digests. Only after an acceptable
consolidated outcome may a separate authority consider whether to permit one
isolated, disposable, credential-controlled staging evaluation. That later
decision is out of scope here.
