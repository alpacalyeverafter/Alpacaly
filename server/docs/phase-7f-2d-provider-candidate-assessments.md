# Phase 7F-2D published-document provider candidate assessments

Phase 7F-2D implements the smallest safe follow-up to the Phase 7F-2C managed
staging framework. It records two redacted candidate packs from public provider
documentation and produces a side-by-side coverage report. It does not rank,
recommend, select, purchase, provision or connect either provider.

The reviewed candidates are:

- Amazon RDS for PostgreSQL in AWS Europe (London), `eu-west-2`;
- Cloud SQL for PostgreSQL in Google Cloud London, `europe-west2`.

These are research candidates, not finalists. Their inclusion creates no account,
commercial preference or authorization. The source snapshots were reviewed on
22 July 2026 and must be refreshed when their configured maximum age is exceeded.

## Safety boundary

The candidate-pack contract fixes all of these declarations to `false`:

- accounts created;
- credentials used;
- provider APIs called;
- databases connected;
- resources provisioned;
- provider selected;
- staging authorized;
- production authorized;
- external connections authorized.

The comparison report additionally fixes staging readiness to `BLOCKED`, records
no score or ranking, and contains no selection recommendation. A successful
command means only that the two documentation packs are structurally valid and
comparable.

Nothing in this phase changes or exercises the Event Engine, Contribution Ledger,
welfare limits, emergency stops, `OUTCOME_UNKNOWN` resolution, recovery-safety
mode, worker-claim fencing, Device Command classification, backup/restore logic,
or append-only platform audit history. No database migration is needed because
published-document comparison is governance evidence, not operational state.

## Candidate-pack contract

[`provider-candidate-assessment.schema.json`](provider-candidate-assessment.schema.json)
defines version 1. The JavaScript validator is deliberately stricter than JSON
Schema where cross-record checks are needed. It requires:

- exactly one claim for every one of the 22 Phase 7F-2C review controls;
- one or more official documentation domains declared by the candidate;
- credential-free HTTPS source URLs on those declared domains;
- no URL usernames, passwords, non-standard ports, query strings or fragments;
- unique source IDs, URLs and control claims;
- a source reference for every supported or partially supported claim;
- no source reference for a claim not found in the reviewed documents;
- a further technical, security, operations, data-governance, finance, contract
  or disposable-staging verification step for every claim;
- at least one explicit limitation per claim and at least one open question;
- published-documentation-only collection and all non-authorization declarations;
- an SHA-256 digest over the allow-listed normalized payload.

Secret-shaped fields such as passwords, access tokens, private keys, connection
strings and database URLs are rejected. The digest detects later file mutation;
it is not a provider signature and does not prove that a published claim is true.

## Evidence outcomes

Each control has one outcome:

- `SUPPORTED_BY_PUBLISHED_DOCUMENTATION`: an official document describes the
  capability, but it remains unverified for Alpacaly;
- `PARTIALLY_SUPPORTED_BY_PUBLISHED_DOCUMENTATION`: the documents cover only
  part of the control or leave configuration/contract questions open;
- `NOT_FOUND_IN_REVIEWED_DOCUMENTATION`: this review found no decision-grade
  evidence for the control.

Both initial packs record 22 controls: 11 supported, 6 partially supported, and
5 not found. Equal counts do not mean equal suitability. Phase 7F-2D performs no
weighted scoring because the controls have different safety and governance
consequences, and published marketing or product documentation cannot replace
configuration evidence.

## Published source packs

- [`aws-rds-postgresql-london.json`](provider-candidates/aws-rds-postgresql-london.json)
- [`google-cloud-sql-postgresql-london.json`](provider-candidates/google-cloud-sql-postgresql-london.json)

The packs cite official provider pages for managed PostgreSQL, version support,
London region availability, encryption, TLS/server identity, private networking,
backup/PITR/restore, native dump/restore, monitoring, pricing and support where
available. They intentionally record unresolved gaps for role separation, secret
rotation, audit coverage, legal holds, service limits, incident history,
contractual support, total cost, UK data transfers and the Alpacaly restore drill.

The source summaries are paraphrases. The repository does not copy provider
documentation bodies, call provider APIs, follow authenticated links, scrape
control planes or cache credentials.

## Comparison command

Run the offline comparison from `server`:

```sh
npm run assess:provider-candidates -- \
  --candidate docs/provider-candidates/aws-rds-postgresql-london.json \
  --candidate docs/provider-candidates/google-cloud-sql-postgresql-london.json \
  --maximum-age-days 30
```

The command reads local JSON files only and writes the machine-readable report to
standard output. It accepts between two and ten distinct candidates. It does not
perform network requests or write evidence, approvals, configuration or secrets.

The expected report boundary is:

```json
{
  "documentReviewStatus": "COMPLETE",
  "stagingReadiness": "BLOCKED",
  "scope": "PUBLISHED_DOCUMENT_COMPARISON_ONLY",
  "providerSelected": false,
  "selectionRecommendation": null,
  "rankingPerformed": false,
  "scoresCalculated": false,
  "accountCreationAuthorized": false,
  "databaseConnectionAuthorized": false,
  "stagingAuthorized": false,
  "productionReadiness": false,
  "productionUseAuthorized": false,
  "externalConnectionsAuthorized": false
}
```

## Limitations

- Published documentation describes advertised capability, not the configuration
  Alpacaly would receive or operate.
- No account, console, API, service agreement, quote, invoice, support case,
  control-plane export, database, backup or restore was inspected.
- Document dates are not always published. `accessedAt` records the review time,
  not the provider's original publication time.
- Declared official domains are an allow-list chosen during review; the software
  does not cryptographically prove publisher ownership or archive the source.
- A SHA-256 digest detects local pack mutation but is not a signature, timestamp
  authority, source attestation or legal record.
- Pricing pages expose variables, not an approved architecture or total monthly
  cost. Support pages expose plan descriptions, not accepted response terms.
- A London service region does not by itself complete a UK privacy, residency,
  backup-location, telemetry, support-access or international-transfer review.
- Provider restore capability does not prove Alpacaly recovery-safety mode,
  emergency-stop persistence, claim fencing, append-only audit preservation or
  `OUTCOME_UNKNOWN` handling.
- Candidate packs can become stale and must be independently re-reviewed.
- This phase provides no account-opening, credential, provisioning, staging
  release, production release or worker-release mechanism.

## Required next decision

Technical, security, operations, data-governance and finance owners must review
the schema, sources, claim severities, open questions, proposed RPO/RTO and
evidence-storage boundary. If they approve a separate next phase, one candidate
may then be evaluated in a disposable, isolated staging account using the
existing Phase 7F-2C assessment and independent sign-off workflow.

That later authorization must be explicit and must still prohibit payments,
public feeding, production MQTT, cameras and physical hardware. No provider
should be selected or account created merely because this document review is
complete.

Phase 7F-2E implements that next review as a strict, non-ranking
[governance review pack](phase-7f-2e-governance-review-pack.md). It carries the
exact candidate digests, open questions, source freshness and proposed targets
into five independent authority checklists while keeping staging and production
authorization off.
