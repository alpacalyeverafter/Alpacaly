import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const PROVIDER_CANDIDATE_PACK_VERSION = 1;
export const PROVIDER_CANDIDATE_SCOPE = "PUBLISHED_DOCUMENT_REVIEW_ONLY";

export const PROVIDER_CANDIDATE_CONTROL_IDS = Object.freeze([
    "managed-postgresql",
    "postgresql-16-or-newer",
    "uk-region",
    "encrypted-storage",
    "encrypted-backups",
    "point-in-time-recovery",
    "isolated-restore",
    "tls-and-hostname-verification",
    "private-networking",
    "native-dump-and-restore",
    "monitoring-and-alerting",
    "least-privilege-role-separation",
    "secret-management-and-rotation",
    "administrative-audit-logging",
    "backup-retention-and-deletion",
    "legal-and-incident-hold",
    "service-limits",
    "incident-history",
    "support-response",
    "cost-evidence",
    "uk-data-transfer-review",
    "alpacaly-restore-safety-drill"
]);

export const PROVIDER_CANDIDATE_CLAIM_STATUSES = Object.freeze([
    "SUPPORTED_BY_PUBLISHED_DOCUMENTATION",
    "PARTIALLY_SUPPORTED_BY_PUBLISHED_DOCUMENTATION",
    "NOT_FOUND_IN_REVIEWED_DOCUMENTATION"
]);

export const PROVIDER_CANDIDATE_NEXT_VERIFICATIONS = Object.freeze([
    "TECHNICAL_REVIEW",
    "SECURITY_REVIEW",
    "OPERATIONS_REVIEW",
    "DATA_GOVERNANCE_REVIEW",
    "FINANCE_REVIEW",
    "CONTRACT_REVIEW",
    "STAGING_TEST"
]);

const SECRET_KEY_PATTERN = /(?:password|secret|token|credential|private.?key|connection.?string|database.?url|access.?key)/i;
const SAFE_CONTROL_FIELDS = new Set([
    "secretManagementAndRotation",
    "credentialsUsed"
]);

function fail(message, code = "PROVIDER_CANDIDATE_PACK_INVALID") {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function object(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(`${name} must be an object.`);
    }
    return value;
}

function text(value, name, { maximumLength = 500 } = {}) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        fail(`${name} is required.`);
    }
    if (normalized.length > maximumLength) {
        fail(`${name} must not exceed ${maximumLength} characters.`);
    }
    return normalized;
}

function identifier(value, name) {
    const normalized = text(value, name, { maximumLength: 200 });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) {
        fail(`${name} contains unsupported characters.`);
    }
    return normalized;
}

function timestamp(value, name) {
    const normalized = text(value, name, { maximumLength: 80 });
    if (Number.isNaN(Date.parse(normalized))) {
        fail(`${name} must be an ISO-compatible timestamp.`);
    }
    return normalized;
}

function nullableDate(value, name) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    const normalized = text(value, name, { maximumLength: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(Date.parse(normalized))) {
        fail(`${name} must be a YYYY-MM-DD date or null.`);
    }
    return normalized;
}

function choice(value, name, choices) {
    const normalized = text(value, name, { maximumLength: 100 }).toUpperCase();
    if (!choices.includes(normalized)) {
        fail(`${name} must be one of: ${choices.join(", ")}.`);
    }
    return normalized;
}

function boolean(value, name, expected = null) {
    if (typeof value !== "boolean") {
        fail(`${name} must be a boolean.`);
    }
    if (expected !== null && value !== expected) {
        fail(`${name} must remain ${expected}.`, "PROVIDER_CANDIDATE_SCOPE_VIOLATION");
    }
    return value;
}

function allowedKeys(value, allowed, name) {
    const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
    if (unexpected.length > 0) {
        fail(`${name} contains unsupported fields: ${unexpected.join(", ")}.`);
    }
}

function rejectSecretShapedFields(value, path = "candidatePack") {
    if (!value || typeof value !== "object") {
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        if (!SAFE_CONTROL_FIELDS.has(key) && SECRET_KEY_PATTERN.test(key)) {
            fail(
                `${path}.${key} is not permitted in provider candidate evidence.`,
                "PROVIDER_CANDIDATE_SECRET_FIELD"
            );
        }
        rejectSecretShapedFields(child, `${path}.${key}`);
    }
}

function uniqueList(value, name, normalizer, { minimum = 0, maximum = 50 } = {}) {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
        fail(`${name} must contain between ${minimum} and ${maximum} entries.`);
    }
    const normalized = value.map((entry, index) => normalizer(entry, `${name}[${index}]`));
    if (new Set(normalized).size !== normalized.length) {
        fail(`${name} must not contain duplicates.`);
    }
    return normalized;
}

function domain(value, name) {
    const normalized = text(value, name, { maximumLength: 253 }).toLowerCase();
    if (
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)
        || !normalized.includes(".")
        || normalized.includes("..")
    ) {
        fail(`${name} must be a valid DNS domain.`);
    }
    return normalized;
}

function officialDocumentationUrl(value, name, officialDomains) {
    const normalized = text(value, name, { maximumLength: 1000 });
    let url;
    try {
        url = new URL(normalized);
    } catch {
        fail(`${name} must be a valid URL.`);
    }
    if (
        url.protocol !== "https:"
        || url.username
        || url.password
        || url.search
        || url.hash
        || (url.port && url.port !== "443")
    ) {
        fail(
            `${name} must be a credential-free HTTPS documentation URL without a query or fragment.`,
            "PROVIDER_CANDIDATE_SOURCE_UNSAFE"
        );
    }
    const hostname = url.hostname.toLowerCase();
    if (!officialDomains.some(entry => hostname === entry || hostname.endsWith(`.${entry}`))) {
        fail(
            `${name} is outside the candidate's declared official documentation domains.`,
            "PROVIDER_CANDIDATE_SOURCE_UNOFFICIAL"
        );
    }
    return url.toString();
}

function stringList(value, name, { minimum = 0, maximum = 20, maximumLength = 500 } = {}) {
    return uniqueList(
        value,
        name,
        (entry, entryName) => text(entry, entryName, { maximumLength }),
        { minimum, maximum }
    );
}

function payload(input) {
    object(input, "candidatePack");
    const candidate = object(input.candidate, "candidate");
    const commercial = object(input.commercial, "commercial");
    const collection = object(input.collection, "collection");
    const declarations = object(input.declarations, "declarations");

    allowedKeys(input, [
        "packVersion", "packId", "packDigest", "reviewedAt", "scope", "candidate",
        "sources", "claims", "commercial", "openQuestions", "collection", "declarations"
    ], "candidatePack");
    allowedKeys(candidate, [
        "providerLabel", "serviceLabel", "regionLabel", "regionCode",
        "postgresqlMajorVersion", "officialDocumentationDomains"
    ], "candidate");
    allowedKeys(commercial, [
        "pricingReview", "supportReview", "quoteRequired", "contractReviewRequired"
    ], "commercial");
    allowedKeys(collection, ["method", "reviewerReference"], "collection");
    allowedKeys(declarations, [
        "accountsCreated", "credentialsUsed", "providerApiCallsMade",
        "databasesConnected", "resourcesProvisioned", "providerSelected",
        "stagingAuthorized", "productionAuthorized", "externalConnectionsAuthorized"
    ], "declarations");

    const reviewedAt = timestamp(input.reviewedAt, "reviewedAt");
    const officialDocumentationDomains = uniqueList(
        candidate.officialDocumentationDomains,
        "candidate.officialDocumentationDomains",
        domain,
        { minimum: 1, maximum: 10 }
    );
    const postgresqlMajorVersion = Number(candidate.postgresqlMajorVersion);
    if (!Number.isSafeInteger(postgresqlMajorVersion) || postgresqlMajorVersion < 16) {
        fail("candidate.postgresqlMajorVersion must be PostgreSQL 16 or newer.");
    }

    if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 40) {
        fail("sources must contain between 1 and 40 published documentation references.");
    }
    const sources = input.sources.map((entry, index) => {
        const source = object(entry, `sources[${index}]`);
        allowedKeys(source, [
            "sourceId", "publisher", "title", "url", "accessedAt", "documentDate"
        ], `sources[${index}]`);
        const accessedAt = timestamp(source.accessedAt, `sources[${index}].accessedAt`);
        if (Date.parse(accessedAt) > Date.parse(reviewedAt)) {
            fail(`sources[${index}].accessedAt must not be later than reviewedAt.`);
        }
        return {
            sourceId: identifier(source.sourceId, `sources[${index}].sourceId`),
            publisher: text(source.publisher, `sources[${index}].publisher`, {
                maximumLength: 240
            }),
            title: text(source.title, `sources[${index}].title`, { maximumLength: 500 }),
            url: officialDocumentationUrl(
                source.url,
                `sources[${index}].url`,
                officialDocumentationDomains
            ),
            accessedAt,
            documentDate: nullableDate(source.documentDate, `sources[${index}].documentDate`)
        };
    });
    const sourceIds = sources.map(source => source.sourceId);
    if (new Set(sourceIds).size !== sourceIds.length) {
        fail("sources must use unique sourceId values.");
    }
    if (new Set(sources.map(source => source.url)).size !== sources.length) {
        fail("sources must not repeat the same documentation URL.");
    }
    const sourceIdSet = new Set(sourceIds);

    if (!Array.isArray(input.claims) || input.claims.length !== PROVIDER_CANDIDATE_CONTROL_IDS.length) {
        fail(`claims must contain exactly ${PROVIDER_CANDIDATE_CONTROL_IDS.length} controls.`);
    }
    const claims = input.claims.map((entry, index) => {
        const claim = object(entry, `claims[${index}]`);
        allowedKeys(claim, [
            "controlId", "status", "summary", "sourceIds", "nextVerification", "limitations"
        ], `claims[${index}]`);
        const controlId = text(
            claim.controlId,
            `claims[${index}].controlId`,
            { maximumLength: 100 }
        ).toLowerCase();
        if (!PROVIDER_CANDIDATE_CONTROL_IDS.includes(controlId)) {
            fail(
                `claims[${index}].controlId must be one of: ${PROVIDER_CANDIDATE_CONTROL_IDS.join(", ")}.`
            );
        }
        const status = choice(
            claim.status,
            `claims[${index}].status`,
            PROVIDER_CANDIDATE_CLAIM_STATUSES
        );
        const claimSourceIds = uniqueList(
            claim.sourceIds,
            `claims[${index}].sourceIds`,
            identifier,
            { minimum: status === "NOT_FOUND_IN_REVIEWED_DOCUMENTATION" ? 0 : 1, maximum: 10 }
        );
        for (const sourceId of claimSourceIds) {
            if (!sourceIdSet.has(sourceId)) {
                fail(`claims[${index}].sourceIds references unknown sourceId ${sourceId}.`);
            }
        }
        if (status === "NOT_FOUND_IN_REVIEWED_DOCUMENTATION" && claimSourceIds.length > 0) {
            fail(`claims[${index}] must not cite sources when its status is NOT_FOUND.`);
        }
        return {
            controlId,
            status,
            summary: text(claim.summary, `claims[${index}].summary`, { maximumLength: 700 }),
            sourceIds: claimSourceIds,
            nextVerification: choice(
                claim.nextVerification,
                `claims[${index}].nextVerification`,
                PROVIDER_CANDIDATE_NEXT_VERIFICATIONS
            ),
            limitations: stringList(
                claim.limitations,
                `claims[${index}].limitations`,
                { minimum: 1, maximum: 10, maximumLength: 500 }
            )
        };
    });
    const claimControlIds = claims.map(claim => claim.controlId);
    if (new Set(claimControlIds).size !== claimControlIds.length) {
        fail("claims must contain each required control exactly once.");
    }
    const missingControls = PROVIDER_CANDIDATE_CONTROL_IDS.filter(
        controlId => !claimControlIds.includes(controlId)
    );
    if (missingControls.length > 0) {
        fail(`claims are missing required controls: ${missingControls.join(", ")}.`);
    }

    const normalizedScope = text(input.scope, "scope", { maximumLength: 100 }).toUpperCase();
    if (normalizedScope !== PROVIDER_CANDIDATE_SCOPE) {
        fail(
            `scope must remain ${PROVIDER_CANDIDATE_SCOPE}.`,
            "PROVIDER_CANDIDATE_SCOPE_VIOLATION"
        );
    }
    const method = text(collection.method, "collection.method", {
        maximumLength: 100
    }).toUpperCase();
    if (method !== "PUBLISHED_DOCUMENTATION_ONLY") {
        fail(
            "collection.method must remain PUBLISHED_DOCUMENTATION_ONLY.",
            "PROVIDER_CANDIDATE_SCOPE_VIOLATION"
        );
    }

    return {
        packVersion: PROVIDER_CANDIDATE_PACK_VERSION,
        packId: identifier(input.packId, "packId"),
        reviewedAt,
        scope: PROVIDER_CANDIDATE_SCOPE,
        candidate: {
            providerLabel: text(candidate.providerLabel, "candidate.providerLabel", {
                maximumLength: 240
            }),
            serviceLabel: text(candidate.serviceLabel, "candidate.serviceLabel", {
                maximumLength: 240
            }),
            regionLabel: text(candidate.regionLabel, "candidate.regionLabel", {
                maximumLength: 240
            }),
            regionCode: identifier(candidate.regionCode, "candidate.regionCode"),
            postgresqlMajorVersion,
            officialDocumentationDomains
        },
        sources,
        claims,
        commercial: {
            pricingReview: choice(commercial.pricingReview, "commercial.pricingReview", [
                "PUBLISHED_VARIABLES_ONLY", "NOT_FOUND"
            ]),
            supportReview: choice(commercial.supportReview, "commercial.supportReview", [
                "PUBLISHED_PLANS_ONLY", "NOT_FOUND"
            ]),
            quoteRequired: boolean(commercial.quoteRequired, "commercial.quoteRequired", true),
            contractReviewRequired: boolean(
                commercial.contractReviewRequired,
                "commercial.contractReviewRequired",
                true
            )
        },
        openQuestions: stringList(input.openQuestions, "openQuestions", {
            minimum: 1,
            maximum: 50,
            maximumLength: 700
        }),
        collection: {
            method: "PUBLISHED_DOCUMENTATION_ONLY",
            reviewerReference: identifier(
                collection.reviewerReference,
                "collection.reviewerReference"
            )
        },
        declarations: Object.fromEntries([
            "accountsCreated",
            "credentialsUsed",
            "providerApiCallsMade",
            "databasesConnected",
            "resourcesProvisioned",
            "providerSelected",
            "stagingAuthorized",
            "productionAuthorized",
            "externalConnectionsAuthorized"
        ].map(key => [key, boolean(declarations[key], `declarations.${key}`, false)]))
    };
}

export function providerCandidatePackDigest(candidatePack) {
    if (Number(candidatePack?.packVersion) !== PROVIDER_CANDIDATE_PACK_VERSION) {
        fail(`Provider candidate pack version ${candidatePack?.packVersion ?? "unknown"} is not supported.`);
    }
    return createHash("sha256").update(JSON.stringify(payload(candidatePack))).digest("hex");
}

export function createProviderCandidatePack(input) {
    object(input, "candidatePack");
    rejectSecretShapedFields(input);
    if (Number(input.packVersion) !== PROVIDER_CANDIDATE_PACK_VERSION) {
        fail(`Provider candidate pack version ${input.packVersion ?? "unknown"} is not supported.`);
    }
    const normalized = payload(input);
    const packDigest = providerCandidatePackDigest(normalized);
    if (input.packDigest && input.packDigest !== packDigest) {
        fail(
            "Provider candidate pack digest does not match its documentation-only payload.",
            "PROVIDER_CANDIDATE_PACK_DIGEST_MISMATCH"
        );
    }
    return Object.freeze({ ...normalized, packDigest });
}

export function readProviderCandidatePack(path) {
    try {
        return createProviderCandidatePack(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
        if (error.code) {
            throw error;
        }
        fail(`Provider candidate pack could not be read: ${error.message}`);
    }
}
