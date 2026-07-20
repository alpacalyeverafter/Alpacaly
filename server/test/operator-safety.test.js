import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import request from "supertest";

import { createApp } from "../src/app.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { SqliteEventStore } from "../src/event-store/sqlite-event-store.js";
import { EVENT_STORE_MIGRATIONS } from "../src/event-store/migrations/index.js";
import { CriticalAuthenticationService } from "../src/operator-safety/critical-authentication-service.js";
import { DEFAULT_RESOURCE_IDS } from "../src/domain/resources.js";
import { createApprovalDecision } from "../src/domain/operator-safety.js";
import { createTestLogger, testConfig } from "./helpers.js";

const BARN_ID = DEFAULT_RESOURCE_IDS.barnId;
const FEEDER_ID = DEFAULT_RESOURCE_IDS.feederId;
const ADMIN_ID = "administrator_development_platform_admin";
const ADMIN_2_ID = "administrator_development_platform_admin_secondary";
const ADMIN_3_ID = "administrator_development_platform_admin_tertiary";
const WELFARE_ID = "administrator_development_welfare_operator";
const HARDWARE_ID = "administrator_development_hardware_operator";

const AUTH = Object.freeze({
    admin: "Development local-admin",
    admin2: "Development local-admin-secondary",
    admin3: "Development local-admin-tertiary",
    welfare: "Development local-welfare",
    hardware: "Development local-hardware",
    viewer: "Development local-viewer"
});

async function createHarness({
    databasePath = ":memory:",
    clock = () => new Date("2026-07-19T12:00:00.000Z"),
    config = {}
} = {}) {
    const resolvedConfig = {
        ...testConfig,
        ...config,
        databasePath
    };
    const logger = createTestLogger();
    const eventEngine = new EventEngine({
        config: resolvedConfig,
        logger,
        clock,
        autoProcess: false
    });
    const app = createApp({ config: resolvedConfig, logger, eventEngine });
    await app.locals.deviceCommandServices.worker.stop();
    app.locals.contributionLedgerServices.outboxWorker.stop();
    return {
        app,
        eventEngine,
        devices: app.locals.deviceCommandServices,
        administrators: app.locals.administratorSecurityServices,
        safety: app.locals.operatorSafetyServices,
        async close() {
            await app.locals.deviceCommandServices.worker.stop();
            app.locals.contributionLedgerServices.outboxWorker.stop();
            if (!eventEngine.eventStore.closed) {
                await eventEngine.shutdown();
            }
        }
    };
}

function context(harness, administratorId, role, reason = "Safety test") {
    const administrator = harness.administrators.store.getAdministrator(
        administratorId
    );
    return {
        identity: {
            ...administrator,
            authenticationStrength: "DEVELOPMENT",
            assignments: harness.administrators.store.getIdentityAssignments(
                administratorId
            )
        },
        authorization: { effectiveRole: role },
        requestId: `request-${administratorId}`,
        reason
    };
}

function activateFeederStop(harness, administratorId = WELFARE_ID, role = "WELFARE_OPERATOR") {
    return harness.safety.emergencyStopService.activate({
        level: "FEEDER",
        barnId: BARN_ID,
        feederId: FEEDER_ID,
        reason: "Animal welfare emergency"
    }, context(harness, administratorId, role));
}

function submitFeed(harness, suffix) {
    return harness.app.locals.contributionLedgerServices
        .developmentWebsiteContributionService.simulate({
            supporterName: `Safety supporter ${suffix}`,
            clientRequestId: `safety-${suffix}`
        }).feedRequest;
}

function createUnknownDispense(harness, suffix = "unknown") {
    const feedRequest = submitFeed(harness, suffix);
    let command = harness.devices.deviceCommandService.ensureCommandForEvent(
        feedRequest,
        "DISPENSE_FEED"
    ).command;
    command = harness.devices.deviceCommandStore.transitionCommand(
        command.commandId,
        "SENT",
        {
            timestamp: "2026-07-19T12:00:01.000Z",
            acknowledgementDeadline: "2026-07-19T12:00:02.000Z",
            incrementAttempt: true
        }
    );
    command = harness.devices.deviceCommandStore.transitionCommand(
        command.commandId,
        "OUTCOME_UNKNOWN",
        {
            timestamp: "2026-07-19T12:00:03.000Z",
            lastError: "Physical outcome could not be proven"
        }
    );
    harness.devices.deviceCommandService.commandOutcomeUnknown(command);
    return {
        feedRequest,
        command,
        resolutionCase: harness.safety.store.getResolutionCaseByCommand(
            command.commandId
        )
    };
}

async function approveResolution(harness, resolutionCaseId, resolution) {
    const requested = harness.safety.operatorResolutionService.requestResolution(
        resolutionCaseId,
        { resolution, reason: `Evidence supports ${resolution}` },
        context(harness, ADMIN_ID, "ADMINISTRATOR")
    );
    const requestId = requested.approvalRequest.approvalRequestId;
    harness.safety.approvalService.decide(requestId, {
        decision: "APPROVE",
        authorityRepresented: "WELFARE",
        reason: "Welfare approval"
    }, context(harness, WELFARE_ID, "WELFARE_OPERATOR"));
    return harness.safety.approvalService.decide(requestId, {
        decision: "APPROVE",
        authorityRepresented: "HARDWARE",
        reason: "Hardware approval"
    }, context(harness, HARDWARE_ID, "HARDWARE_OPERATOR"));
}

test("permitted roles activate durable hierarchical emergency stops while Viewer and wrong Barn scope are denied", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());

    const viewerDenied = await request(harness.app)
        .post("/api/admin/safety/emergency-stops")
        .set("authorization", AUTH.viewer)
        .send({
            level: "FEEDER",
            barnId: BARN_ID,
            feederId: FEEDER_ID,
            reason: "Viewer cannot activate"
        });
    assert.equal(viewerDenied.status, 403);
    assert.ok(harness.administrators.store.getAuditRecords({ limit: 1000 }).some(
        record => record.action === "EMERGENCY_STOP_ACTIVATION_REJECTED"
            && record.result === "REJECTED"
    ));

    const stop = activateFeederStop(harness);
    assert.equal(stop.status, "ACTIVE");
    assert.equal(harness.safety.emergencyStopService.isFeederBlocked(FEEDER_ID), true);
    assert.equal(
        harness.safety.store.getFeederSafety(FEEDER_ID).safetyStatus,
        "EMERGENCY_STOPPED"
    );

    const second = await createHarness();
    t.after(() => second.close());
    assert.equal(
        activateFeederStop(second, HARDWARE_ID, "HARDWARE_OPERATOR").status,
        "ACTIVE"
    );
    const third = await createHarness();
    t.after(() => third.close());
    assert.equal(
        activateFeederStop(third, ADMIN_ID, "ADMINISTRATOR").status,
        "ACTIVE"
    );

    const resources = third.eventEngine.eventStore;
    resources.saveBarn({
        barnId: "barn_safety_other",
        name: "Other Barn",
        timezone: "Europe/London",
        createdAt: "2026-07-19T00:00:00.000Z"
    });
    const wrongScope = await request(third.app)
        .post("/api/admin/safety/emergency-stops")
        .set("authorization", AUTH.welfare)
        .send({
            level: "BARN",
            barnId: "barn_safety_other",
            reason: "Out of scope"
        });
    assert.equal(wrongScope.status, 403);
});

test("platform, Barn and Feeder stops block only their hierarchical resource scope", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const store = harness.eventEngine.eventStore;
    store.saveBarn({
        barnId: "barn_hierarchy",
        name: "Hierarchy Barn",
        timezone: "Europe/London",
        createdAt: "2026-07-19T00:00:00.000Z"
    });
    store.saveFeeder({
        feederId: "feeder_hierarchy",
        barnId: "barn_hierarchy",
        name: "Hierarchy Feeder",
        createdAt: "2026-07-19T00:00:00.000Z"
    });
    store.saveQueue({
        queueId: "queue_hierarchy",
        barnId: "barn_hierarchy",
        feederId: "feeder_hierarchy",
        resourceType: "FEEDER",
        resourceId: "feeder_hierarchy",
        name: "Hierarchy Queue",
        createdAt: "2026-07-19T00:00:00.000Z"
    });

    store.saveFeeder({
        feederId: "feeder_same_barn",
        barnId: BARN_ID,
        name: "Second default Barn Feeder",
        createdAt: "2026-07-19T00:00:00.000Z"
    });
    store.saveQueue({
        queueId: "queue_same_barn",
        barnId: BARN_ID,
        feederId: "feeder_same_barn",
        resourceType: "FEEDER",
        resourceId: "feeder_same_barn",
        name: "Second default Barn Queue",
        createdAt: "2026-07-19T00:00:00.000Z"
    });

    activateFeederStop(harness);
    assert.equal(harness.safety.emergencyStopService.isFeederBlocked(FEEDER_ID), true);
    assert.equal(
        harness.safety.emergencyStopService.isFeederBlocked("feeder_same_barn"),
        false
    );
    assert.equal(
        harness.safety.emergencyStopService.isFeederBlocked("feeder_hierarchy"),
        false
    );

    harness.safety.emergencyStopService.activate({
        level: "BARN",
        barnId: BARN_ID,
        reason: "Barn emergency"
    }, context(harness, WELFARE_ID, "WELFARE_OPERATOR"));
    assert.equal(
        harness.safety.emergencyStopService.isFeederBlocked("feeder_same_barn"),
        true
    );
    assert.equal(
        harness.safety.emergencyStopService.isFeederBlocked("feeder_hierarchy"),
        false
    );

    const platformStop = harness.safety.emergencyStopService.activate({
        level: "PLATFORM",
        reason: "Platform emergency"
    }, context(harness, ADMIN_ID, "ADMINISTRATOR"));
    assert.equal(platformStop.level, "PLATFORM");
    assert.equal(harness.safety.emergencyStopService.isFeederBlocked(FEEDER_ID), true);
    assert.equal(
        harness.safety.emergencyStopService.isFeederBlocked("feeder_hierarchy"),
        true
    );
});

test("emergency activation cancels only proven-not-started commands and opens a case for sent uncertain dispense", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const readyFeed = submitFeed(harness, "ready-cancel");
    const ready = harness.devices.deviceCommandService.ensureCommandForEvent(
        readyFeed,
        "RING_BELL"
    ).command;
    const uncertainFeed = submitFeed(harness, "sent-unknown");
    let sent = harness.devices.deviceCommandService.ensureCommandForEvent(
        uncertainFeed,
        "DISPENSE_FEED"
    ).command;
    sent = harness.devices.deviceCommandStore.transitionCommand(sent.commandId, "SENT", {
        timestamp: "2026-07-19T12:00:01.000Z",
        acknowledgementDeadline: "2026-07-19T12:00:10.000Z",
        incrementAttempt: true
    });

    activateFeederStop(harness);
    assert.equal(
        harness.devices.deviceCommandStore.getCommand(ready.commandId).status,
        "CANCELLED"
    );
    assert.equal(
        harness.devices.deviceCommandStore.getCommand(sent.commandId).status,
        "OUTCOME_UNKNOWN"
    );
    const resolutionCase = harness.safety.store.getResolutionCaseByCommand(
        sent.commandId
    );
    assert.equal(resolutionCase.status, "OPEN");
    assert.equal(
        harness.safety.operatorResolutionService.getCountedWelfareQuantity(FEEDER_ID),
        1
    );
    assert.equal(
        harness.devices.deviceCommandStore.getCommandsForEvent(sent.eventId).length,
        1
    );
});

test("emergency clearance requires requester separation, distinct welfare and hardware authority", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const stop = activateFeederStop(harness);
    const requestResult = harness.safety.emergencyStopService.requestClear(
        stop.emergencyStopId,
        { reason: "Area inspected" },
        context(harness, ADMIN_ID, "ADMINISTRATOR")
    );

    assert.throws(() => harness.safety.approvalService.decide(
        requestResult.approvalRequestId,
        {
            decision: "APPROVE",
            authorityRepresented: "WELFARE",
            reason: "Self approval"
        },
        context(harness, ADMIN_ID, "ADMINISTRATOR")
    ), error => error.code === "APPROVAL_REQUESTER_CANNOT_APPROVE");

    const partial = harness.safety.approvalService.decide(
        requestResult.approvalRequestId,
        {
            decision: "APPROVE",
            authorityRepresented: "WELFARE",
            reason: "Welfare clear"
        },
        context(harness, WELFARE_ID, "WELFARE_OPERATOR")
    );
    assert.equal(partial.status, "PARTIALLY_APPROVED");
    assert.throws(() => harness.safety.approvalService.decide(
        requestResult.approvalRequestId,
        {
            decision: "APPROVE",
            authorityRepresented: "HARDWARE",
            reason: "Duplicate person"
        },
        context(harness, WELFARE_ID, "WELFARE_OPERATOR")
    ), error => error.code === "DUPLICATE_APPROVAL_DECISION");

    const completed = harness.safety.approvalService.decide(
        requestResult.approvalRequestId,
        {
            decision: "APPROVE",
            authorityRepresented: "HARDWARE",
            reason: "Hardware clear"
        },
        context(harness, HARDWARE_ID, "HARDWARE_OPERATOR")
    );
    assert.equal(completed.status, "EXECUTED");
    assert.equal(
        harness.safety.store.getEmergencyStop(stop.emergencyStopId).status,
        "CLEARED"
    );
});

test("platform stop clearance requires two distinct platform Administrators", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const stop = harness.safety.emergencyStopService.activate({
        level: "PLATFORM",
        reason: "Platform incident"
    }, context(harness, ADMIN_ID, "ADMINISTRATOR"));
    const approval = harness.safety.emergencyStopService.requestClear(
        stop.emergencyStopId,
        { reason: "Platform checks complete" },
        context(harness, ADMIN_ID, "ADMINISTRATOR")
    );
    harness.safety.approvalService.decide(approval.approvalRequestId, {
        decision: "APPROVE",
        authorityRepresented: "PLATFORM_ADMIN",
        reason: "First platform approval"
    }, context(harness, ADMIN_2_ID, "ADMINISTRATOR"));
    const completed = harness.safety.approvalService.decide(
        approval.approvalRequestId,
        {
            decision: "APPROVE",
            authorityRepresented: "PLATFORM_ADMIN",
            reason: "Second platform approval"
        },
        context(harness, ADMIN_3_ID, "ADMINISTRATOR")
    );
    assert.equal(completed.status, "EXECUTED");
});

test("approvals expire at 15 minutes and current account, role and scope are revalidated", async t => {
    let now = new Date("2026-07-19T12:00:00.000Z");
    const harness = await createHarness({ clock: () => new Date(now) });
    t.after(() => harness.close());
    const stop = activateFeederStop(harness);
    const approval = harness.safety.emergencyStopService.requestClear(
        stop.emergencyStopId,
        { reason: "Expiry test" },
        context(harness, ADMIN_ID, "ADMINISTRATOR")
    );
    now = new Date("2026-07-19T12:15:00.001Z");
    harness.safety.approvalService.expireRequests();
    assert.equal(
        harness.safety.approvalService.getRequest(approval.approvalRequestId).status,
        "EXPIRED"
    );

    now = new Date("2026-07-19T12:16:00.000Z");
    const second = harness.safety.emergencyStopService.requestClear(
        stop.emergencyStopId,
        { reason: "Revalidation test" },
        context(harness, ADMIN_ID, "ADMINISTRATOR")
    );
    harness.safety.approvalService.decide(second.approvalRequestId, {
        decision: "APPROVE",
        authorityRepresented: "WELFARE",
        reason: "Welfare approval"
    }, context(harness, WELFARE_ID, "WELFARE_OPERATOR"));
    harness.eventEngine.eventStore.database.prepare(`
        UPDATE Administrators SET status = 'SUSPENDED'
        WHERE administratorId = ?
    `).run(HARDWARE_ID);
    assert.throws(() => harness.safety.approvalService.decide(
        second.approvalRequestId,
        {
            decision: "APPROVE",
            authorityRepresented: "HARDWARE",
            reason: "Suspended hardware approval"
        },
        context(harness, HARDWARE_ID, "HARDWARE_OPERATOR")
    ), error => [
        "APPROVER_NOT_ACTIVE",
        "CRITICAL_AUTHENTICATION_REQUIRED"
    ].includes(error.code));
    harness.eventEngine.eventStore.database.prepare(`
        UPDATE Administrators SET status = 'ACTIVE'
        WHERE administratorId = ?
    `).run(HARDWARE_ID);
    harness.eventEngine.eventStore.database.prepare(`
        UPDATE RoleAssignments SET revokedAt = ?
        WHERE administratorId = ? AND revokedAt IS NULL
    `).run(now.toISOString(), HARDWARE_ID);
    assert.throws(() => harness.safety.approvalService.decide(
        second.approvalRequestId,
        {
            decision: "APPROVE",
            authorityRepresented: "HARDWARE",
            reason: "Revoked hardware role"
        },
        context(harness, HARDWARE_ID, "HARDWARE_OPERATOR")
    ), error => error.code === "APPROVAL_AUTHORITY_DENIED");

    const scoped = await createHarness();
    t.after(() => scoped.close());
    const scopedStop = activateFeederStop(scoped);
    const scopedApproval = scoped.safety.emergencyStopService.requestClear(
        scopedStop.emergencyStopId,
        { reason: "Scope revalidation" },
        context(scoped, ADMIN_ID, "ADMINISTRATOR")
    );
    scoped.safety.approvalService.decide(scopedApproval.approvalRequestId, {
        decision: "APPROVE",
        authorityRepresented: "WELFARE",
        reason: "Welfare approval"
    }, context(scoped, WELFARE_ID, "WELFARE_OPERATOR"));
    scoped.eventEngine.eventStore.database.prepare(`
        UPDATE BarnScopes SET revokedAt = ?
        WHERE administratorId = ? AND revokedAt IS NULL
    `).run("2026-07-19T12:01:00.000Z", HARDWARE_ID);
    assert.throws(() => scoped.safety.approvalService.decide(
        scopedApproval.approvalRequestId,
        {
            decision: "APPROVE",
            authorityRepresented: "HARDWARE",
            reason: "Revoked Barn scope"
        },
        context(scoped, HARDWARE_ID, "HARDWARE_OPERATOR")
    ), error => error.code === "APPROVAL_AUTHORITY_DENIED");
    scoped.eventEngine.eventStore.database.prepare(`
        UPDATE Administrators SET status = 'REVOKED'
        WHERE administratorId = ?
    `).run(HARDWARE_ID);
    assert.throws(() => scoped.safety.approvalService.decide(
        scopedApproval.approvalRequestId,
        {
            decision: "APPROVE",
            authorityRepresented: "HARDWARE",
            reason: "Revoked account"
        },
        context(scoped, HARDWARE_ID, "HARDWARE_OPERATOR")
    ), error => error.code === "CRITICAL_AUTHENTICATION_REQUIRED");
});

test("each uncertain-outcome resolution has its required safe meaning", async t => {
    const dispensed = await createHarness();
    t.after(() => dispensed.close());
    const first = createUnknownDispense(dispensed, "confirmed-dispensed");
    await approveResolution(
        dispensed,
        first.resolutionCase.resolutionCaseId,
        "CONFIRMED_DISPENSED"
    );
    assert.equal(
        dispensed.devices.deviceCommandStore.getCommand(first.command.commandId).status,
        "ACKNOWLEDGED"
    );
    assert.equal(
        dispensed.safety.store.getResolutionCase(
            first.resolutionCase.resolutionCaseId
        ).finalResolution,
        "CONFIRMED_DISPENSED"
    );

    const notDispensed = await createHarness();
    t.after(() => notDispensed.close());
    const second = createUnknownDispense(notDispensed, "confirmed-not-dispensed");
    await approveResolution(
        notDispensed,
        second.resolutionCase.resolutionCaseId,
        "CONFIRMED_NOT_DISPENSED"
    );
    assert.equal(
        notDispensed.safety.operatorResolutionService.getCountedWelfareQuantity(
            FEEDER_ID
        ),
        0
    );
    assert.equal(
        notDispensed.devices.deviceCommandStore.getCommandsForEvent(
            second.command.eventId
        ).length,
        1
    );

    const cancelled = await createHarness();
    t.after(() => cancelled.close());
    const third = createUnknownDispense(cancelled, "welfare-cancelled");
    await approveResolution(
        cancelled,
        third.resolutionCase.resolutionCaseId,
        "CANCELLED_FOR_WELFARE"
    );
    assert.equal(
        cancelled.eventEngine.getFeedRequest(third.feedRequest.eventId).state,
        "CANCELLED_FOR_WELFARE"
    );
    assert.equal(
        cancelled.safety.operatorResolutionService.getCountedWelfareQuantity(
            FEEDER_ID
        ),
        1
    );

    const manual = await createHarness();
    t.after(() => manual.close());
    const fourth = createUnknownDispense(manual, "manual-review");
    const result = manual.safety.operatorResolutionService.requestResolution(
        fourth.resolutionCase.resolutionCaseId,
        {
            resolution: "MANUAL_REVIEW_REQUIRED",
            reason: "Evidence is insufficient"
        },
        context(manual, ADMIN_ID, "ADMINISTRATOR")
    );
    assert.equal(result.approvalRequest, null);
    assert.equal(result.resolutionCase.status, "OPEN");
    assert.equal(
        manual.safety.store.getFeederSafety(FEEDER_ID).safetyStatus,
        "BLOCKED_OUTCOME_UNKNOWN"
    );
});

test("replacement dispense requires separate dual approval, fresh welfare checks and a linked new command ID", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const unknown = createUnknownDispense(harness, "replacement");
    await approveResolution(
        harness,
        unknown.resolutionCase.resolutionCaseId,
        "CONFIRMED_NOT_DISPENSED"
    );
    const replacementRequest = harness.safety.operatorResolutionService
        .requestReplacement(
            unknown.resolutionCase.resolutionCaseId,
            { reason: "Approved safe replacement" },
            context(harness, ADMIN_ID, "ADMINISTRATOR")
        );
    harness.safety.approvalService.decide(replacementRequest.approvalRequestId, {
        decision: "APPROVE",
        authorityRepresented: "WELFARE",
        reason: "Fresh welfare checks approved"
    }, context(harness, WELFARE_ID, "WELFARE_OPERATOR"));
    const completed = harness.safety.approvalService.decide(
        replacementRequest.approvalRequestId,
        {
            decision: "APPROVE",
            authorityRepresented: "HARDWARE",
            reason: "Replacement hardware path approved"
        },
        context(harness, HARDWARE_ID, "HARDWARE_OPERATOR")
    );
    assert.equal(completed.status, "EXECUTED");
    const commands = harness.devices.deviceCommandStore.getCommandsForEvent(
        unknown.command.eventId
    );
    assert.equal(commands.length, 2);
    assert.notEqual(commands[1].commandId, unknown.command.commandId);
    assert.equal(commands[1].replacementOfCommandId, unknown.command.commandId);
    assert.equal(
        commands[1].resolutionCaseId,
        unknown.resolutionCase.resolutionCaseId
    );

    const blocked = await createHarness();
    t.after(() => blocked.close());
    const blockedUnknown = createUnknownDispense(blocked, "blocked-replacement");
    await approveResolution(
        blocked,
        blockedUnknown.resolutionCase.resolutionCaseId,
        "CONFIRMED_NOT_DISPENSED"
    );
    activateFeederStop(blocked);
    const blockedRequest = blocked.safety.operatorResolutionService.requestReplacement(
        blockedUnknown.resolutionCase.resolutionCaseId,
        { reason: "Must fail fresh checks" },
        context(blocked, ADMIN_ID, "ADMINISTRATOR")
    );
    blocked.safety.approvalService.decide(blockedRequest.approvalRequestId, {
        decision: "APPROVE",
        authorityRepresented: "WELFARE",
        reason: "First approval"
    }, context(blocked, WELFARE_ID, "WELFARE_OPERATOR"));
    assert.throws(() => blocked.safety.approvalService.decide(
        blockedRequest.approvalRequestId,
        {
            decision: "APPROVE",
            authorityRepresented: "HARDWARE",
            reason: "Second approval"
        },
        context(blocked, HARDWARE_ID, "HARDWARE_OPERATOR")
    ), error => error.code === "EMERGENCY_STOP_ACTIVE");
    assert.equal(
        blocked.devices.deviceCommandStore.getCommandsForEvent(
            blockedUnknown.command.eventId
        ).length,
        1
    );
});

test("worker reconciliation repairs a missing uncertain-outcome case without retrying or cross-blocking Feeders", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const store = harness.eventEngine.eventStore;
    store.saveBarn({
        barnId: "barn_unknown_isolation",
        name: "Unknown Isolation Barn",
        timezone: "Europe/London",
        createdAt: "2026-07-19T00:00:00.000Z"
    });
    store.saveFeeder({
        feederId: "feeder_unknown_isolation",
        barnId: "barn_unknown_isolation",
        name: "Unknown Isolation Feeder",
        createdAt: "2026-07-19T00:00:00.000Z"
    });
    store.saveQueue({
        queueId: "queue_unknown_isolation",
        barnId: "barn_unknown_isolation",
        feederId: "feeder_unknown_isolation",
        resourceType: "FEEDER",
        resourceId: "feeder_unknown_isolation",
        name: "Unknown Isolation Queue",
        createdAt: "2026-07-19T00:00:00.000Z"
    });

    const feedRequest = submitFeed(harness, "reconcile-missing-case");
    let command = harness.devices.deviceCommandService.ensureCommandForEvent(
        feedRequest,
        "DISPENSE_FEED"
    ).command;
    command = harness.devices.deviceCommandStore.transitionCommand(
        command.commandId,
        "OUTCOME_UNKNOWN",
        {
            timestamp: "2026-07-19T12:00:03.000Z",
            lastError: "Interrupted before case creation"
        }
    );
    assert.equal(
        harness.safety.store.getResolutionCaseByCommand(command.commandId),
        null
    );
    harness.devices.worker.reconcileOutcomeUnknownCommands();
    assert.equal(
        harness.safety.store.getResolutionCaseByCommand(command.commandId).status,
        "OPEN"
    );
    assert.equal(
        harness.devices.deviceCommandStore.getCommandsForEvent(command.eventId).length,
        1
    );
    assert.equal(
        harness.safety.emergencyStopService.isFeederBlocked(
            "feeder_unknown_isolation"
        ),
        false
    );
});

test("active stops and unresolved cases survive a real database restart", async t => {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-safety-restart-"));
    const databasePath = join(directory, "events.sqlite");
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = await createHarness({ databasePath });
    const unknown = createUnknownDispense(first, "restart-case");
    const stop = activateFeederStop(first);
    await first.close();

    const restored = await createHarness({ databasePath });
    t.after(() => restored.close());
    assert.equal(
        restored.safety.store.getEmergencyStop(stop.emergencyStopId).status,
        "ACTIVE"
    );
    assert.equal(
        restored.safety.store.getResolutionCase(
            unknown.resolutionCase.resolutionCaseId
        ).status,
        "OPEN"
    );
    assert.equal(
        restored.safety.emergencyStopService.isFeederBlocked(FEEDER_ID),
        true
    );
    assert.ok(restored.administrators.store.getAuditRecords({ limit: 1000 }).some(
        record => record.action === "EMERGENCY_STOP_RESTORED_ON_RESTART"
    ));
});

test("an approved critical action safely resumes on an authenticated retry after restart", async t => {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-approval-restart-"));
    const databasePath = join(directory, "events.sqlite");
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = await createHarness({ databasePath });
    const stop = activateFeederStop(first);
    const approval = first.safety.emergencyStopService.requestClear(
        stop.emergencyStopId,
        { reason: "Restart boundary clearance" },
        context(first, ADMIN_ID, "ADMINISTRATOR")
    );
    const firstDecision = createApprovalDecision({
        approvalDecisionId: "approval_decision_restart_welfare",
        approvalRequestId: approval.approvalRequestId,
        administratorId: WELFARE_ID,
        effectiveRole: "WELFARE_OPERATOR",
        authorityRepresented: "WELFARE",
        decision: "APPROVE",
        reason: "Welfare approval before restart",
        authenticationStrength: "DEVELOPMENT",
        decidedAt: "2026-07-19T12:00:01.000Z"
    });
    first.safety.store.addApprovalDecision(
        firstDecision,
        "PENDING",
        "PARTIALLY_APPROVED"
    );
    const secondDecision = createApprovalDecision({
        approvalDecisionId: "approval_decision_restart_hardware",
        approvalRequestId: approval.approvalRequestId,
        administratorId: HARDWARE_ID,
        effectiveRole: "HARDWARE_OPERATOR",
        authorityRepresented: "HARDWARE",
        decision: "APPROVE",
        reason: "Hardware approval before restart",
        authenticationStrength: "DEVELOPMENT",
        decidedAt: "2026-07-19T12:00:02.000Z"
    });
    first.safety.store.addApprovalDecision(
        secondDecision,
        "PARTIALLY_APPROVED",
        "APPROVED"
    );
    await first.close();

    const restored = await createHarness({ databasePath });
    t.after(() => restored.close());
    assert.equal(
        restored.safety.approvalService.getRequest(
            approval.approvalRequestId
        ).status,
        "APPROVED"
    );
    const executed = restored.safety.approvalService.decide(
        approval.approvalRequestId,
        {
            decision: "APPROVE",
            authorityRepresented: "HARDWARE",
            reason: "Resume approved clearance"
        },
        context(restored, HARDWARE_ID, "HARDWARE_OPERATOR")
    );
    assert.equal(executed.status, "EXECUTED");
    assert.equal(
        restored.safety.store.getEmergencyStop(stop.emergencyStopId).status,
        "CLEARED"
    );
});

test("migration 7 remains compatible when the store advances to schema 10", t => {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-safety-migration-"));
    const databasePath = join(directory, "events.sqlite");
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const logger = createTestLogger();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("PRAGMA foreign_keys = ON;");
    EVENT_STORE_MIGRATIONS.filter(migration => migration.version < 7)
        .forEach(migration => {
        legacy.exec("BEGIN IMMEDIATE;");
        migration.up(legacy);
        legacy.exec(`PRAGMA user_version = ${migration.version};`);
        legacy.exec("COMMIT;");
        });
    legacy.close();
    assert.equal(existsSync(databasePath), true);
    const migrated = new SqliteEventStore({ databasePath, logger });
    assert.equal(migrated.getSchemaVersion(), 10);
    assert.ok(migrated.getTableNames().includes("EmergencyStops"));
    assert.ok(migrated.getTableNames().includes("ApprovalRequests"));
    assert.ok(migrated.getTableNames().includes("OperatorResolutionCases"));
    assert.equal(
        EVENT_STORE_MIGRATIONS.find(migration => migration.version === 7).name,
        "operator_safety"
    );
    migrated.close();
});

test("safety audit and approval decisions are immutable", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const stop = activateFeederStop(harness);
    const approval = harness.safety.emergencyStopService.requestClear(
        stop.emergencyStopId,
        { reason: "Immutable approval" },
        context(harness, ADMIN_ID, "ADMINISTRATOR")
    );
    harness.safety.approvalService.decide(approval.approvalRequestId, {
        decision: "APPROVE",
        authorityRepresented: "WELFARE",
        reason: "Immutable decision"
    }, context(harness, WELFARE_ID, "WELFARE_OPERATOR"));
    const database = harness.eventEngine.eventStore.database;
    assert.throws(() => database.exec(`
        UPDATE ApprovalDecisions SET reason = 'tampered';
    `), /append-only/);
    assert.throws(() => database.exec(`
        UPDATE OperatorAuditRecords SET reason = 'tampered';
    `), /append-only/);
});

test("protected safety APIs require authentication and public APIs expose only safe availability", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    await request(harness.app)
        .get(`/api/admin/safety/emergency-stops?barnId=${BARN_ID}`)
        .expect(401);
    activateFeederStop(harness);
    const publicStatus = await request(harness.app)
        .get("/api/event-engine/status")
        .expect(200);
    assert.deepEqual(publicStatus.body.eventEngine.availability, {
        available: false,
        status: "TEMPORARILY_UNAVAILABLE",
        message: "Feeding is temporarily unavailable. Please try again later."
    });
    assert.equal(publicStatus.body.eventEngine.emergencyStops, undefined);
    assert.equal(publicStatus.body.eventEngine.safetyStatus, undefined);
    const queued = await request(harness.app)
        .post("/api/feed-requests")
        .send({ supporterName: "Blocked supporter" })
        .expect(202);
    assert.equal(queued.body.accepted, true);
    assert.equal(harness.eventEngine.getSnapshot().availability.available, false);
});

test("production critical actions reject development or weak authentication and missing managed identity", () => {
    const baseIdentity = {
        administratorId: ADMIN_ID,
        status: "ACTIVE",
        authenticationStrength: "DEVELOPMENT"
    };
    const missingProvider = new CriticalAuthenticationService({
        config: {
            nodeEnv: "production",
            enableDevelopmentAuthentication: false,
            managedIdentityProviderConfigured: false
        }
    });
    assert.throws(
        () => missingProvider.assert(baseIdentity),
        error => error.code === "MANAGED_IDENTITY_PROVIDER_REQUIRED"
    );
    const configured = new CriticalAuthenticationService({
        config: {
            nodeEnv: "production",
            enableDevelopmentAuthentication: false,
            managedIdentityProviderConfigured: true
        }
    });
    assert.throws(
        () => configured.assert(baseIdentity),
        error => error.code === "CRITICAL_AUTHENTICATION_STRENGTH_INSUFFICIENT"
    );
    assert.doesNotThrow(() => configured.assert({
        ...baseIdentity,
        authenticationStrength: "MFA"
    }));
});
