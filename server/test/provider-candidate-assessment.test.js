import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
    PROVIDER_CANDIDATE_CONTROL_IDS,
    compareProviderCandidatePacks,
    createProviderCandidatePack,
    readProviderCandidatePack
} from "../src/disaster-recovery/index.js";

const AWS_PATH = join(
    process.cwd(),
    "docs/provider-candidates/aws-rds-postgresql-london.json"
);
const GOOGLE_PATH = join(
    process.cwd(),
    "docs/provider-candidates/google-cloud-sql-postgresql-london.json"
);

function raw(path = AWS_PATH) {
    return JSON.parse(readFileSync(path, "utf8"));
}

function packs() {
    return [readProviderCandidatePack(AWS_PATH), readProviderCandidatePack(GOOGLE_PATH)];
}

test("published-document candidate packs are complete, checksummed and non-authorizing", () => {
    for (const pack of packs()) {
        assert.match(pack.packDigest, /^[a-f0-9]{64}$/);
        assert.equal(pack.scope, "PUBLISHED_DOCUMENT_REVIEW_ONLY");
        assert.equal(pack.collection.method, "PUBLISHED_DOCUMENTATION_ONLY");
        assert.deepEqual(
            new Set(pack.claims.map(claim => claim.controlId)),
            new Set(PROVIDER_CANDIDATE_CONTROL_IDS)
        );
        assert.equal(pack.claims.every(claim => claim.limitations.length > 0), true);
        assert.equal(pack.claims.every(claim => claim.nextVerification), true);
        assert.equal(Object.values(pack.declarations).every(value => value === false), true);
        for (const source of pack.sources) {
            const url = new URL(source.url);
            assert.equal(url.protocol, "https:");
            assert.equal(url.username, "");
            assert.equal(url.password, "");
            assert.equal(url.search, "");
            assert.equal(url.hash, "");
            assert.equal(pack.candidate.officialDocumentationDomains.some(domain => (
                url.hostname === domain || url.hostname.endsWith(`.${domain}`)
            )), true);
        }
    }
});

test("candidate packs reject secrets, unsafe sources and broadened scope", () => {
    assert.throws(
        () => createProviderCandidatePack({ ...raw(), accessToken: "forbidden" }),
        error => error.code === "PROVIDER_CANDIDATE_SECRET_FIELD"
    );

    for (const url of [
        "http://docs.aws.amazon.com/unsafe",
        "https://user:password@docs.aws.amazon.com/unsafe",
        "https://docs.aws.amazon.com/unsafe?database=secret",
        "https://docs.aws.amazon.com.evil.example/unsafe"
    ]) {
        const input = raw();
        input.sources[0].url = url;
        assert.throws(
            () => createProviderCandidatePack(input),
            error => [
                "PROVIDER_CANDIDATE_SOURCE_UNSAFE",
                "PROVIDER_CANDIDATE_SOURCE_UNOFFICIAL"
            ].includes(error.code),
            url
        );
    }

    const connected = raw();
    connected.declarations.databasesConnected = true;
    assert.throws(
        () => createProviderCandidatePack(connected),
        error => error.code === "PROVIDER_CANDIDATE_SCOPE_VIOLATION"
    );

    const controlPlane = raw();
    controlPlane.collection.method = "CONTROL_PLANE_EXPORT";
    assert.throws(
        () => createProviderCandidatePack(controlPlane),
        error => error.code === "PROVIDER_CANDIDATE_SCOPE_VIOLATION"
    );
});

test("candidate packs fail closed for missing controls, unknown sources and tampering", () => {
    const missingControl = raw();
    missingControl.claims.pop();
    assert.throws(() => createProviderCandidatePack(missingControl), /exactly 22 controls/);

    const unknownSource = raw();
    unknownSource.claims[0].sourceIds = ["unknown-published-source"];
    assert.throws(() => createProviderCandidatePack(unknownSource), /unknown sourceId/);

    const unsupportedClaim = raw();
    unsupportedClaim.claims[0].status = "VERIFIED_IN_PRODUCTION";
    assert.throws(() => createProviderCandidatePack(unsupportedClaim), /must be one of/);

    const tampered = raw();
    tampered.candidate.regionLabel = "Changed after review";
    assert.throws(
        () => createProviderCandidatePack(tampered),
        error => error.code === "PROVIDER_CANDIDATE_PACK_DIGEST_MISMATCH"
    );
});

test("comparison records coverage without selecting, scoring or authorizing a provider", () => {
    const report = compareProviderCandidatePacks(packs(), {
        now: new Date("2026-07-22T15:00:00.000Z"),
        maximumAgeDays: 30
    });
    assert.equal(report.documentReviewStatus, "COMPLETE");
    assert.equal(report.stagingReadiness, "BLOCKED");
    assert.equal(report.scope, "PUBLISHED_DOCUMENT_COMPARISON_ONLY");
    assert.equal(report.providerSelected, false);
    assert.equal(report.selectionRecommendation, null);
    assert.equal(report.rankingPerformed, false);
    assert.equal(report.scoresCalculated, false);
    assert.equal(report.accountCreationAuthorized, false);
    assert.equal(report.credentialsAuthorized, false);
    assert.equal(report.databaseConnectionAuthorized, false);
    assert.equal(report.stagingAuthorized, false);
    assert.equal(report.productionReadiness, false);
    assert.equal(report.productionUseAuthorized, false);
    assert.equal(report.externalConnectionsAuthorized, false);
    assert.equal(report.candidates.length, 2);
    assert.equal(report.controls.length, PROVIDER_CANDIDATE_CONTROL_IDS.length);
    assert.equal(report.candidates.every(candidate => (
        candidate.coverage.totalControls === PROVIDER_CANDIDATE_CONTROL_IDS.length
        && candidate.documentReviewStatus === "GAPS_RECORDED"
    )), true);
});

test("stale documentation is visible and future-dated evidence is rejected", () => {
    const report = compareProviderCandidatePacks(packs(), {
        now: new Date("2026-09-01T00:00:00.000Z"),
        maximumAgeDays: 30
    });
    assert.equal(report.documentReviewStatus, "STALE");
    assert.equal(report.candidates.every(candidate => candidate.stale), true);
    assert.equal(report.stagingReadiness, "BLOCKED");

    assert.throws(() => compareProviderCandidatePacks(packs(), {
        now: new Date("2026-07-21T00:00:00.000Z")
    }), /reviewed after the comparison time/);
});

test("candidate comparison command reads two local packs and performs no external operation", () => {
    const result = spawnSync(process.execPath, [
        join(process.cwd(), "scripts/provider-candidates-assess.js"),
        "--candidate", AWS_PATH,
        "--candidate", GOOGLE_PATH,
        "--maximum-age-days", "30"
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.scope, "PUBLISHED_DOCUMENT_COMPARISON_ONLY");
    assert.equal(report.candidates.length, 2);
    assert.equal(report.stagingReadiness, "BLOCKED");
    assert.equal(report.externalConnectionsAuthorized, false);
});

test("candidate schema fixes documentation-only declarations to false", () => {
    const schema = JSON.parse(readFileSync(
        join(process.cwd(), "docs/provider-candidate-assessment.schema.json"),
        "utf8"
    ));
    assert.equal(schema.properties.scope.const, "PUBLISHED_DOCUMENT_REVIEW_ONLY");
    assert.equal(schema.properties.collection.properties.method.const,
        "PUBLISHED_DOCUMENTATION_ONLY");
    for (const property of schema.properties.declarations.required) {
        assert.equal(schema.properties.declarations.properties[property].const, false);
    }
});
