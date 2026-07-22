import { createHash, randomUUID } from "node:crypto";
import {
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const MANAGED_STAGING_APPROVAL_AUTHORITIES = Object.freeze([
    "TECHNICAL",
    "SECURITY",
    "OPERATIONS",
    "DATA_GOVERNANCE",
    "FINANCE"
]);

function requireText(value, name, { maximumLength = 1000 } = {}) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        throw new Error(`${name} is required.`);
    }
    if (normalized.length > maximumLength) {
        throw new Error(`${name} must not exceed ${maximumLength} characters.`);
    }
    return normalized;
}

function identifier(value, name) {
    const normalized = requireText(value, name, { maximumLength: 200 });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(normalized)) {
        throw new Error(`${name} contains unsupported characters.`);
    }
    return normalized;
}

function digest(value, name, { nullable = false } = {}) {
    if (value === null && nullable) {
        return null;
    }
    const normalized = requireText(value, name);
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
        throw new Error(`${name} must be a SHA-256 digest.`);
    }
    return normalized;
}

function timestamp(value, name) {
    const normalized = requireText(value, name);
    if (Number.isNaN(Date.parse(normalized))) {
        throw new Error(`${name} must be an ISO-compatible timestamp.`);
    }
    return normalized;
}

function positiveInteger(value, name) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive safe integer.`);
    }
    return parsed;
}

function authority(value, name = "authority") {
    const normalized = requireText(value, name).toUpperCase();
    if (!MANAGED_STAGING_APPROVAL_AUTHORITIES.includes(normalized)) {
        throw new Error(
            `${name} must be one of: ${MANAGED_STAGING_APPROVAL_AUTHORITIES.join(", ")}.`
        );
    }
    return normalized;
}

function authorities(value) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error("requiredAuthorities must be a non-empty array.");
    }
    const normalized = value.map(entry => authority(entry, "requiredAuthorities entry"));
    if (new Set(normalized).size !== normalized.length) {
        throw new Error("requiredAuthorities must not contain duplicates.");
    }
    return normalized;
}

function nullable(value, normalizer, name) {
    if (value === null || value === undefined) {
        return null;
    }
    return normalizer(value, name);
}

function validateEvent(input) {
    const allowed = [
        "eventVersion", "sequence", "previousEventDigest", "eventId", "eventType",
        "requestId", "assessmentId", "assessmentDigest", "requestedBy",
        "requiredAuthorities", "expiresAt", "authority", "authorityReference",
        "decisionId", "decision", "reason", "occurredAt", "eventDigest"
    ];
    const unexpected = Object.keys(input).filter(key => !allowed.includes(key));
    if (unexpected.length > 0) {
        throw new Error(
            `Managed staging approval event contains unsupported fields: ${unexpected.join(", ")}.`
        );
    }
    const eventType = requireText(input.eventType, "eventType").toUpperCase();
    if (![
        "MANAGED_STAGING_APPROVAL_REQUESTED",
        "MANAGED_STAGING_SIGNOFF_RECORDED"
    ].includes(eventType)) {
        throw new Error("eventType is not supported.");
    }
    const decision = nullable(input.decision, (value, name) => {
        const normalized = requireText(value, name).toUpperCase();
        if (!["APPROVE", "REJECT"].includes(normalized)) {
            throw new Error("decision must be APPROVE or REJECT.");
        }
        return normalized;
    }, "decision");
    const payload = {
        eventVersion: 1,
        sequence: positiveInteger(input.sequence, "sequence"),
        previousEventDigest: digest(
            input.previousEventDigest,
            "previousEventDigest",
            { nullable: true }
        ),
        eventId: identifier(input.eventId, "eventId"),
        eventType,
        requestId: identifier(input.requestId, "requestId"),
        assessmentId: identifier(input.assessmentId, "assessmentId"),
        assessmentDigest: digest(input.assessmentDigest, "assessmentDigest"),
        requestedBy: identifier(input.requestedBy, "requestedBy"),
        requiredAuthorities: authorities(input.requiredAuthorities),
        expiresAt: timestamp(input.expiresAt, "expiresAt"),
        authority: nullable(input.authority, authority, "authority"),
        authorityReference: nullable(
            input.authorityReference,
            identifier,
            "authorityReference"
        ),
        decisionId: nullable(input.decisionId, identifier, "decisionId"),
        decision,
        reason: requireText(input.reason, "reason"),
        occurredAt: timestamp(input.occurredAt, "occurredAt")
    };
    const isRequest = eventType === "MANAGED_STAGING_APPROVAL_REQUESTED";
    if (isRequest && [payload.authority, payload.authorityReference, payload.decisionId,
        payload.decision].some(value => value !== null)) {
        throw new Error("Approval request events must not contain a decision.");
    }
    if (!isRequest && [payload.authority, payload.authorityReference, payload.decisionId,
        payload.decision].some(value => value === null)) {
        throw new Error("Sign-off events require authority, identity, decision ID, and decision.");
    }
    const eventDigest = createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");
    if (input.eventDigest && input.eventDigest !== eventDigest) {
        throw new Error("Managed staging approval event digest does not match its payload.");
    }
    return Object.freeze({ ...payload, eventDigest });
}

export class ManagedStagingApprovalRegistry {
    constructor({ directory, clock = () => new Date(), idGenerator = randomUUID } = {}) {
        if (!directory || !isAbsolute(directory)) {
            throw new Error("Managed staging approval directory must be an absolute path.");
        }
        this.directory = resolve(directory);
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    events() {
        let names;
        try {
            names = readdirSync(this.directory);
        } catch (error) {
            if (error.code === "ENOENT") {
                return [];
            }
            throw new Error("Managed staging approval evidence directory cannot be read.");
        }
        const events = names
            .filter(name => name.endsWith(".managed-staging-approval-event.json"))
            .map(name => {
                try {
                    const parsed = JSON.parse(readFileSync(resolve(this.directory, name), "utf8"));
                    if (Number(parsed.eventVersion) !== 1) {
                        throw new Error("eventVersion is not supported");
                    }
                    return validateEvent(parsed);
                } catch (error) {
                    throw new Error(
                        `Managed staging approval evidence ${name} is invalid: ${error.message}`
                    );
                }
            })
            .sort((left, right) => left.sequence - right.sequence);
        events.forEach((event, index) => {
            if (
                event.sequence !== index + 1
                || event.previousEventDigest !== (events[index - 1]?.eventDigest || null)
            ) {
                throw new Error(
                    "Managed staging approval evidence chain is incomplete or out of order."
                );
            }
        });
        return events;
    }

    request({
        requestId,
        assessmentId,
        assessmentDigest,
        requestedBy,
        requiredAuthorities = MANAGED_STAGING_APPROVAL_AUTHORITIES,
        expiresAt,
        reason
    }) {
        const current = this.events();
        const normalizedAssessmentId = identifier(assessmentId, "assessmentId");
        const normalizedRequestId = identifier(requestId, "requestId");
        if (current.some(event => event.assessmentId === normalizedAssessmentId)) {
            throw new Error(
                "This immutable assessment already has an approval workflow; create a new assessment for another review."
            );
        }
        if (current.some(event => event.requestId === normalizedRequestId)) {
            throw new Error("requestId has already been used and cannot be replayed.");
        }
        const now = this.clock();
        if (Date.parse(expiresAt) <= now.getTime()) {
            throw new Error("Approval request expiry must be in the future.");
        }
        return this.#append({
            eventType: "MANAGED_STAGING_APPROVAL_REQUESTED",
            requestId: normalizedRequestId,
            assessmentId: normalizedAssessmentId,
            assessmentDigest,
            requestedBy,
            requiredAuthorities,
            expiresAt,
            authority: null,
            authorityReference: null,
            decisionId: null,
            decision: null,
            reason,
            occurredAt: now.toISOString()
        });
    }

    decide({ requestId, authority: decisionAuthority, authorityReference, decisionId,
        decision, reason }) {
        const normalizedRequestId = identifier(requestId, "requestId");
        const request = this.events().find(event => (
            event.requestId === normalizedRequestId
            && event.eventType === "MANAGED_STAGING_APPROVAL_REQUESTED"
        ));
        if (!request) {
            throw new Error("Managed staging approval request does not exist.");
        }
        if (Date.parse(request.expiresAt) <= this.clock().getTime()) {
            throw new Error("Managed staging approval request has expired.");
        }
        const normalizedAuthority = authority(decisionAuthority);
        if (!request.requiredAuthorities.includes(normalizedAuthority)) {
            throw new Error("The supplied authority is not required by this approval request.");
        }
        const normalizedAuthorityReference = identifier(
            authorityReference,
            "authorityReference"
        );
        if (normalizedAuthorityReference === request.requestedBy) {
            throw new Error("The approval requester cannot sign off their own assessment.");
        }
        const current = this.events().filter(event => event.requestId === normalizedRequestId);
        if (current.some(event => event.authority === normalizedAuthority)) {
            throw new Error("This authority has already recorded a decision for the request.");
        }
        if (current.some(event => event.decisionId === decisionId)) {
            throw new Error("decisionId has already been used and cannot be replayed.");
        }
        return this.#append({
            eventType: "MANAGED_STAGING_SIGNOFF_RECORDED",
            requestId: request.requestId,
            assessmentId: request.assessmentId,
            assessmentDigest: request.assessmentDigest,
            requestedBy: request.requestedBy,
            requiredAuthorities: request.requiredAuthorities,
            expiresAt: request.expiresAt,
            authority: normalizedAuthority,
            authorityReference: normalizedAuthorityReference,
            decisionId,
            decision,
            reason,
            occurredAt: this.clock().toISOString()
        });
    }

    statusForAssessment(assessmentId, assessmentDigest) {
        const relevant = this.events().filter(event => event.assessmentId === assessmentId);
        const request = relevant.find(
            event => event.eventType === "MANAGED_STAGING_APPROVAL_REQUESTED"
        );
        if (!request) {
            return Object.freeze({ status: "MISSING", requestId: null, approved: [], missing: [] });
        }
        if (request.assessmentDigest !== assessmentDigest) {
            return Object.freeze({
                status: "DIGEST_MISMATCH",
                requestId: request.requestId,
                approved: [],
                missing: request.requiredAuthorities
            });
        }
        const decisions = relevant.filter(
            event => event.eventType === "MANAGED_STAGING_SIGNOFF_RECORDED"
        );
        const seenAuthorities = new Set();
        const seenDecisionIds = new Set();
        for (const decision of decisions) {
            if (
                decision.sequence <= request.sequence
                || decision.requestId !== request.requestId
                || decision.assessmentDigest !== request.assessmentDigest
                || decision.requestedBy !== request.requestedBy
                || decision.expiresAt !== request.expiresAt
                || JSON.stringify(decision.requiredAuthorities)
                    !== JSON.stringify(request.requiredAuthorities)
                || seenAuthorities.has(decision.authority)
                || seenDecisionIds.has(decision.decisionId)
            ) {
                throw new Error("Managed staging sign-off evidence conflicts with its request.");
            }
            seenAuthorities.add(decision.authority);
            seenDecisionIds.add(decision.decisionId);
        }
        const approved = decisions
            .filter(event => event.decision === "APPROVE")
            .map(event => event.authority);
        const missing = request.requiredAuthorities.filter(entry => !approved.includes(entry));
        let status = "PENDING";
        if (Date.parse(request.expiresAt) <= this.clock().getTime()) {
            status = "EXPIRED";
        } else if (decisions.some(event => event.decision === "REJECT")) {
            status = "REJECTED";
        } else if (missing.length === 0) {
            status = "APPROVED";
        }
        return Object.freeze({
            status,
            requestId: request.requestId,
            expiresAt: request.expiresAt,
            required: request.requiredAuthorities,
            approved,
            missing
        });
    }

    #append(input) {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const lockPath = resolve(this.directory, ".managed-staging-approval.lock");
        let lock;
        try {
            lock = openSync(lockPath, "wx", 0o600);
        } catch (error) {
            if (error.code === "EEXIST") {
                throw new Error("Another managed staging approval operation is in progress.");
            }
            throw error;
        }
        try {
            const current = this.events();
            const event = validateEvent({
                eventVersion: 1,
                eventId: `managed-staging-approval-event-${this.idGenerator()}`,
                ...input,
                sequence: current.length + 1,
                previousEventDigest: current.at(-1)?.eventDigest || null
            });
            const path = resolve(
                this.directory,
                `${event.eventId}.managed-staging-approval-event.json`
            );
            writeFileSync(path, `${JSON.stringify(event, null, 2)}\n`, {
                encoding: "utf8",
                flag: "wx",
                mode: 0o600
            });
            return event;
        } finally {
            closeSync(lock);
            unlinkSync(lockPath);
        }
    }
}
