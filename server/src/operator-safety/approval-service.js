import {
    createApprovalDecision,
    createApprovalRequest
} from "../domain/operator-safety.js";
import { ApplicationError } from "../errors/application-error.js";

const OPEN_STATUSES = Object.freeze([
    "PENDING", "PARTIALLY_APPROVED", "APPROVED"
]);

function requireReason(value) {
    const reason = typeof value === "string" ? value.trim() : "";
    if (!reason) {
        throw new ApplicationError("A reason is required for this action.", {
            code: "SAFETY_ACTION_REASON_REQUIRED",
            statusCode: 400
        });
    }
    return reason.slice(0, 1000);
}

export class ApprovalService {
    constructor({
        store,
        administratorStore,
        auditService,
        criticalAuthenticationService,
        clock = () => new Date(),
        idGenerator,
        approvalLifetimeMs = 15 * 60 * 1000
    }) {
        this.store = store;
        this.administratorStore = administratorStore;
        this.auditService = auditService;
        this.criticalAuthenticationService = criticalAuthenticationService;
        this.clock = clock;
        this.idGenerator = idGenerator;
        this.approvalLifetimeMs = approvalLifetimeMs;
        this.executors = new Map();
    }

    registerExecutor(actionType, executor) {
        this.executors.set(String(actionType).toUpperCase(), executor);
    }

    createRequest(input, context) {
        this.expireRequests();
        this.assertCritical(context, "APPROVAL_REQUEST_REJECTED", input);
        const reason = requireReason(input?.reason || context?.reason);
        const existing = this.store.getApprovalRequests().find(request => (
            request.actionType === String(input.actionType).toUpperCase()
            && request.targetType === String(input.targetType).toUpperCase()
            && request.targetId === input.targetId
            && OPEN_STATUSES.includes(request.status)
        ));
        if (existing) {
            this.audit(context, {
                action: "APPROVAL_REQUEST_REJECTED",
                targetType: input.targetType,
                targetId: input.targetId,
                barnId: input.barnId,
                feederId: input.feederId,
                reason: "APPROVAL_REQUEST_ALREADY_PENDING",
                approvalId: existing.approvalRequestId,
                result: "REJECTED"
            });
            throw new ApplicationError(
                "An approval request is already pending for this action.",
                {
                    code: "APPROVAL_REQUEST_ALREADY_PENDING",
                    statusCode: 409
                }
            );
        }
        const request = createApprovalRequest({
            actionType: input.actionType,
            requestedBy: context.identity.administratorId,
            targetType: input.targetType,
            targetId: input.targetId,
            barnId: input.barnId,
            feederId: input.feederId,
            reason,
            requiredAuthorities: input.requiredAuthorities,
            actionPayload: input.actionPayload
        }, this.options());
        const persisted = this.store.createApprovalRequest(request);
        this.audit(context, {
            action: `${persisted.actionType}_REQUESTED`,
            targetType: persisted.targetType,
            targetId: persisted.targetId,
            barnId: persisted.barnId,
            feederId: persisted.feederId,
            reason,
            approvalId: persisted.approvalRequestId,
            result: "SUCCEEDED",
            afterSummary: this.safeRequest(persisted)
        });
        return this.getRequest(persisted.approvalRequestId);
    }

    decide(approvalRequestId, input, context) {
        this.expireRequests();
        this.assertCritical(context, "APPROVAL_DECISION_REJECTED", {
            targetId: approvalRequestId
        });
        let request = this.requireRequest(approvalRequestId);
        if (request.status === "APPROVED") {
            const priorApprover = this.store.getApprovalDecisions(approvalRequestId)
                .some(decision => (
                    decision.decision === "APPROVE"
                    && decision.administratorId === context.identity.administratorId
                ));
            if (!priorApprover) {
                return this.reject(
                    context,
                    request,
                    "APPROVED_ACTION_EXECUTION_REQUIRES_PRIOR_APPROVER"
                );
            }
            this.audit(context, {
                action: "APPROVED_CRITICAL_ACTION_RESUMED",
                targetType: request.targetType,
                targetId: request.targetId,
                barnId: request.barnId,
                feederId: request.feederId,
                reason: input?.reason || "AUTHENTICATED_EXECUTION_RETRY",
                approvalId: request.approvalRequestId,
                result: "SUCCEEDED"
            });
            return this.getRequest(
                this.executeApproved(request, context).approvalRequestId
            );
        }
        if (!["PENDING", "PARTIALLY_APPROVED"].includes(request.status)) {
            return this.reject(context, request, "APPROVAL_REQUEST_NOT_PENDING");
        }
        if (request.requestedBy === context.identity.administratorId) {
            return this.reject(context, request, "APPROVAL_REQUESTER_CANNOT_APPROVE");
        }
        if (this.store.getApprovalDecisions(approvalRequestId).some(decision => (
            decision.administratorId === context.identity.administratorId
        ))) {
            return this.reject(context, request, "DUPLICATE_APPROVAL_DECISION");
        }

        const reason = requireReason(input?.reason || context?.reason);
        const decisionValue = String(input?.decision || "").trim().toUpperCase();
        if (!['APPROVE', 'REJECT'].includes(decisionValue)) {
            throw new ApplicationError("Approval decision is not supported.", {
                code: "APPROVAL_DECISION_NOT_SUPPORTED",
                statusCode: 400
            });
        }
        const currentIdentity = this.loadCurrentIdentity(context.identity);
        const priorDecisions = this.store.getApprovalDecisions(approvalRequestId);
        let authority;
        try {
            authority = this.selectAuthority(
                currentIdentity,
                request,
                input?.authorityRepresented,
                priorDecisions
            );
        } catch (error) {
            this.audit(context, {
                action: "APPROVAL_DECISION_REJECTED",
                targetType: request.targetType,
                targetId: request.targetId,
                barnId: request.barnId,
                feederId: request.feederId,
                reason: error.code || "APPROVAL_AUTHORITY_DENIED",
                approvalId: request.approvalRequestId,
                result: "REJECTED"
            });
            throw error;
        }
        const decision = createApprovalDecision({
            approvalRequestId,
            administratorId: currentIdentity.administratorId,
            effectiveRole: authority.role,
            authorityRepresented: authority.authority,
            decision: decisionValue,
            reason,
            authenticationStrength: context.identity.authenticationStrength
        }, this.options());

        let nextStatus;
        if (decision.decision === "REJECT") {
            nextStatus = "REJECTED";
        } else {
            const approvals = [...priorDecisions, decision]
                .filter(item => item.decision === "APPROVE");
            nextStatus = this.hasRequiredAuthorities(
                request.requiredAuthorities,
                approvals
            ) ? "APPROVED" : "PARTIALLY_APPROVED";
        }
        request = this.store.addApprovalDecision(
            decision,
            request.status,
            nextStatus,
            nextStatus === "REJECTED" ? decision.decidedAt : null
        );
        this.audit(context, {
            action: decision.decision === "APPROVE"
                ? "CRITICAL_ACTION_APPROVED"
                : "CRITICAL_ACTION_REJECTED",
            targetType: request.targetType,
            targetId: request.targetId,
            barnId: request.barnId,
            feederId: request.feederId,
            reason,
            approvalId: request.approvalRequestId,
            result: decision.decision === "APPROVE" ? "SUCCEEDED" : "REJECTED",
            metadata: { authorityRepresented: authority.authority }
        });

        if (request.status === "APPROVED") {
            request = this.executeApproved(request, context);
        }
        return this.getRequest(request.approvalRequestId);
    }

    executeApproved(request, context) {
        try {
            this.validateApprovalsAtExecution(request, context.identity);
            const executor = this.executors.get(request.actionType);
            if (!executor) {
                throw new Error(`No executor registered for ${request.actionType}.`);
            }
            executor(request, context);
            const timestamp = this.clock().toISOString();
            const executed = this.store.changeApprovalStatus(
                request.approvalRequestId,
                "APPROVED",
                "EXECUTED",
                timestamp,
                { actionType: request.actionType }
            );
            this.audit(context, {
                action: `${request.actionType}_EXECUTED`,
                targetType: request.targetType,
                targetId: request.targetId,
                barnId: request.barnId,
                feederId: request.feederId,
                reason: request.reason,
                approvalId: request.approvalRequestId,
                result: "SUCCEEDED"
            });
            return executed;
        } catch (error) {
            const timestamp = this.clock().toISOString();
            this.store.changeApprovalStatus(
                request.approvalRequestId,
                "APPROVED",
                "EXECUTION_FAILED",
                timestamp,
                { error: error.code || String(error.message || error) }
            );
            this.audit(context, {
                action: `${request.actionType}_EXECUTION_FAILED`,
                targetType: request.targetType,
                targetId: request.targetId,
                barnId: request.barnId,
                feederId: request.feederId,
                reason: error.code || String(error.message || error),
                approvalId: request.approvalRequestId,
                result: "FAILED"
            });
            throw error;
        }
    }

    expireRequests() {
        const timestamp = this.clock().toISOString();
        const expired = this.store.getExpiredApprovalRequests(timestamp);
        expired.forEach(request => {
            const changed = this.store.changeApprovalStatus(
                request.approvalRequestId,
                request.status,
                "EXPIRED",
                timestamp,
                { reason: "APPROVAL_DEADLINE_EXPIRED" }
            );
            if (changed) {
                this.auditSystem({
                    action: "APPROVAL_EXPIRED",
                    targetType: request.targetType,
                    targetId: request.targetId,
                    barnId: request.barnId,
                    feederId: request.feederId,
                    reason: "APPROVAL_DEADLINE_EXPIRED",
                    approvalId: request.approvalRequestId,
                    result: "REJECTED"
                });
            }
        });
        return expired.length;
    }

    getRequest(approvalRequestId) {
        const request = this.requireRequest(approvalRequestId);
        return {
            ...request,
            decisions: this.store.getApprovalDecisions(approvalRequestId),
            history: this.store.getApprovalHistory(approvalRequestId)
        };
    }

    getRequests(filter = {}) {
        this.expireRequests();
        return this.store.getApprovalRequests(filter).map(request => (
            this.getRequest(request.approvalRequestId)
        ));
    }

    validateApprovalsAtExecution(request, _executingIdentity) {
        if (Date.parse(request.expiresAt) <= this.clock().getTime()) {
            throw new ApplicationError("Approval Request has expired.", {
                code: "APPROVAL_REQUEST_EXPIRED",
                statusCode: 409
            });
        }
        const decisions = this.store.getApprovalDecisions(request.approvalRequestId)
            .filter(decision => decision.decision === "APPROVE");
        decisions.forEach(decision => {
            const identity = this.loadCurrentIdentity({
                administratorId: decision.administratorId,
                authenticationStrength: decision.authenticationStrength
            });
            this.criticalAuthenticationService.assert(identity);
            if (!this.identityHasAuthority(
                identity,
                decision.authorityRepresented,
                request.barnId
            )) {
                throw new ApplicationError(
                    "An approver no longer has the required role or scope.",
                    {
                        code: "APPROVAL_AUTHORITY_NO_LONGER_VALID",
                        statusCode: 409
                    }
                );
            }
        });
        if (!this.hasRequiredAuthorities(request.requiredAuthorities, decisions)) {
            throw new ApplicationError("Required dual approval is incomplete.", {
                code: "DUAL_APPROVAL_INCOMPLETE",
                statusCode: 409
            });
        }
        if (new Set(decisions.map(item => item.administratorId)).size < 2) {
            throw new ApplicationError("Two distinct approvers are required.", {
                code: "DISTINCT_APPROVERS_REQUIRED",
                statusCode: 409
            });
        }
    }

    selectAuthority(identity, request, requestedAuthority, priorDecisions) {
        const represented = priorDecisions
            .filter(item => item.decision === "APPROVE")
            .map(item => item.authorityRepresented);
        const needed = [...request.requiredAuthorities];
        represented.forEach(authority => {
            const index = needed.indexOf(authority);
            if (index >= 0) {
                needed.splice(index, 1);
            }
        });
        const candidates = requestedAuthority
            ? [String(requestedAuthority).trim().toUpperCase()]
            : needed;
        for (const authority of candidates) {
            if (
                needed.includes(authority)
                && this.identityHasAuthority(identity, authority, request.barnId)
            ) {
                const assignment = this.findAuthorityAssignment(
                    identity,
                    authority,
                    request.barnId
                );
                return { authority, role: assignment.role };
            }
        }
        throw new ApplicationError(
            "Administrator lacks a required current authority for this approval.",
            {
                code: "APPROVAL_AUTHORITY_DENIED",
                statusCode: 403
            }
        );
    }

    findAuthorityAssignment(identity, authority, barnId) {
        return identity.assignments.find(assignment => {
            if (authority === "PLATFORM_ADMIN") {
                return assignment.role === "ADMINISTRATOR"
                    && assignment.platformWide === true;
            }
            const roles = authority === "WELFARE"
                ? ["WELFARE_OPERATOR", "ADMINISTRATOR"]
                : ["HARDWARE_OPERATOR", "ADMINISTRATOR"];
            return roles.includes(assignment.role)
                && (assignment.platformWide || assignment.barnIds.includes(barnId));
        });
    }

    identityHasAuthority(identity, authority, barnId) {
        return Boolean(this.findAuthorityAssignment(identity, authority, barnId));
    }

    hasRequiredAuthorities(required, decisions) {
        const available = decisions.map(item => item.authorityRepresented);
        return required.every(authority => {
            const index = available.indexOf(authority);
            if (index < 0) {
                return false;
            }
            available.splice(index, 1);
            return true;
        });
    }

    loadCurrentIdentity(identity) {
        const administrator = this.administratorStore.getAdministrator(
            identity.administratorId
        );
        if (!administrator || administrator.status !== "ACTIVE") {
            throw new ApplicationError("Approver account is not active.", {
                code: "APPROVER_NOT_ACTIVE",
                statusCode: 403
            });
        }
        return {
            ...administrator,
            authenticationStrength: identity.authenticationStrength,
            assignments: this.administratorStore.getIdentityAssignments(
                administrator.administratorId
            )
        };
    }

    requireRequest(approvalRequestId) {
        const request = this.store.getApprovalRequest(approvalRequestId);
        if (!request) {
            throw new ApplicationError("Approval Request was not found.", {
                code: "APPROVAL_REQUEST_NOT_FOUND",
                statusCode: 404
            });
        }
        return request;
    }

    reject(context, request, code) {
        this.audit(context, {
            action: "APPROVAL_DECISION_REJECTED",
            targetType: request.targetType,
            targetId: request.targetId,
            barnId: request.barnId,
            feederId: request.feederId,
            reason: code,
            approvalId: request.approvalRequestId,
            result: "REJECTED"
        });
        throw new ApplicationError("Approval decision was rejected.", {
            code,
            statusCode: 409
        });
    }

    assertCritical(context, rejectedAction, input = {}) {
        try {
            this.criticalAuthenticationService.assert(context?.identity);
        } catch (error) {
            this.audit(context, {
                action: rejectedAction,
                targetType: input.targetType || "CRITICAL_ACTION",
                targetId: input.targetId || null,
                barnId: input.barnId || null,
                feederId: input.feederId || null,
                reason: error.code || "CRITICAL_AUTHENTICATION_FAILED",
                result: "REJECTED"
            });
            throw error;
        }
    }

    audit(context, input) {
        return this.auditService.record({
            administratorId: context?.identity?.administratorId || null,
            effectiveRole: context?.authorization?.effectiveRole || null,
            requestId: context?.requestId || null,
            authenticationStrength:
                context?.identity?.authenticationStrength || null,
            ...input
        });
    }

    auditSystem(input) {
        return this.auditService.record(input);
    }

    safeRequest(request) {
        return {
            approvalRequestId: request.approvalRequestId,
            actionType: request.actionType,
            targetType: request.targetType,
            targetId: request.targetId,
            barnId: request.barnId,
            feederId: request.feederId,
            status: request.status,
            createdAt: request.createdAt,
            expiresAt: request.expiresAt
        };
    }

    options() {
        return {
            clock: this.clock,
            approvalLifetimeMs: this.approvalLifetimeMs,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        };
    }
}
