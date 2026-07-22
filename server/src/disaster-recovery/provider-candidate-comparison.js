import {
    PROVIDER_CANDIDATE_CLAIM_STATUSES,
    PROVIDER_CANDIDATE_CONTROL_IDS,
    createProviderCandidatePack
} from "./provider-candidate-assessment.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function positiveInteger(value, name) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive safe integer.`);
    }
    return parsed;
}

function timestamp(value, name) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || Number.isNaN(Date.parse(normalized))) {
        throw new Error(`${name} must be an ISO-compatible timestamp.`);
    }
    return normalized;
}

function coverageFor(pack) {
    const counts = Object.fromEntries(
        PROVIDER_CANDIDATE_CLAIM_STATUSES.map(status => [status, 0])
    );
    for (const claim of pack.claims) {
        counts[claim.status] += 1;
    }
    return Object.freeze({
        supportedByPublishedDocumentation:
            counts.SUPPORTED_BY_PUBLISHED_DOCUMENTATION,
        partiallySupportedByPublishedDocumentation:
            counts.PARTIALLY_SUPPORTED_BY_PUBLISHED_DOCUMENTATION,
        notFoundInReviewedDocumentation:
            counts.NOT_FOUND_IN_REVIEWED_DOCUMENTATION,
        totalControls: pack.claims.length
    });
}

export function compareProviderCandidatePacks(candidatePacks, {
    now = new Date(),
    maximumAgeDays = 30
} = {}) {
    if (!Array.isArray(candidatePacks) || candidatePacks.length < 2 || candidatePacks.length > 10) {
        throw new Error("Provider comparison requires between 2 and 10 candidate packs.");
    }
    const checkedAt = timestamp(now.toISOString(), "now");
    const maximumAge = positiveInteger(maximumAgeDays, "maximumAgeDays");
    const packs = candidatePacks.map(createProviderCandidatePack);
    if (new Set(packs.map(pack => pack.packId)).size !== packs.length) {
        throw new Error("Provider comparison requires unique packId values.");
    }
    const candidateIdentities = packs.map(pack => [
        pack.candidate.providerLabel.toLowerCase(),
        pack.candidate.serviceLabel.toLowerCase(),
        pack.candidate.regionCode.toLowerCase()
    ].join("|"));
    if (new Set(candidateIdentities).size !== candidateIdentities.length) {
        throw new Error("Provider comparison requires distinct candidate service and region identities.");
    }

    const candidates = packs.map(pack => {
        if (Date.parse(pack.reviewedAt) > Date.parse(checkedAt)) {
            throw new Error(`Candidate pack ${pack.packId} was reviewed after the comparison time.`);
        }
        const ageDays = Math.floor(
            Math.max(0, Date.parse(checkedAt) - Date.parse(pack.reviewedAt)) / DAY_MS
        );
        const stale = ageDays > maximumAge;
        const coverage = coverageFor(pack);
        return Object.freeze({
            packId: pack.packId,
            packDigest: pack.packDigest,
            providerLabel: pack.candidate.providerLabel,
            serviceLabel: pack.candidate.serviceLabel,
            regionLabel: pack.candidate.regionLabel,
            regionCode: pack.candidate.regionCode,
            postgresqlMajorVersion: pack.candidate.postgresqlMajorVersion,
            reviewedAt: pack.reviewedAt,
            ageDays,
            stale,
            documentReviewStatus: stale
                ? "STALE"
                : coverage.notFoundInReviewedDocumentation > 0 ? "GAPS_RECORDED" : "COMPLETE",
            coverage,
            openQuestionCount: pack.openQuestions.length
        });
    });

    const controls = PROVIDER_CANDIDATE_CONTROL_IDS.map(controlId => Object.freeze({
        controlId,
        candidates: packs.map(pack => {
            const claim = pack.claims.find(entry => entry.controlId === controlId);
            return Object.freeze({
                packId: pack.packId,
                status: claim.status,
                nextVerification: claim.nextVerification,
                sourceCount: claim.sourceIds.length
            });
        })
    }));

    return Object.freeze({
        comparisonVersion: 1,
        documentReviewStatus: candidates.some(candidate => candidate.stale)
            ? "STALE"
            : "COMPLETE",
        stagingReadiness: "BLOCKED",
        scope: "PUBLISHED_DOCUMENT_COMPARISON_ONLY",
        checkedAt,
        maximumAgeDays: maximumAge,
        providerSelected: false,
        selectionRecommendation: null,
        rankingPerformed: false,
        scoresCalculated: false,
        accountCreationAuthorized: false,
        credentialsAuthorized: false,
        databaseConnectionAuthorized: false,
        stagingAuthorized: false,
        productionReadiness: false,
        productionUseAuthorized: false,
        externalConnectionsAuthorized: false,
        candidates,
        controls,
        limitations: Object.freeze([
            "Published documentation records advertised capabilities, not configured behaviour.",
            "No account, control-plane export, contract, bill, support case, database, backup or restore was inspected.",
            "No provider has been selected, ranked, recommended, purchased, provisioned or connected.",
            "Every control still requires the independent review or disposable staging test named in its candidate claim.",
            "Event Engine, welfare, emergency-stop, OUTCOME_UNKNOWN, recovery-safety and audit controls were not exercised by this comparison."
        ]),
        requiredNextStep: "Independent owners must review the documented gaps before any separately authorized disposable staging evaluation."
    });
}
