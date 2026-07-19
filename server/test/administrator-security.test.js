import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import request from "supertest";

import { createApp } from "../src/app.js";
import { DevelopmentAuthProvider } from "../src/authentication/development-auth-provider.js";
import { AuthorizationService } from "../src/authorization/authorization-service.js";
import { PERMISSIONS, ROLE_PERMISSIONS } from "../src/authorization/permissions.js";
import { loadConfig } from "../src/config/index.js";
import {
    DEFAULT_DEVICE_ID,
    DEFAULT_RESOURCE_IDS,
    createBarn,
    createFeeder,
    createQueue
} from "../src/domain/resources.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import {
    EVENT_STORE_MIGRATIONS,
    EVENT_STORE_SCHEMA_VERSION
} from "../src/event-store/migrations/index.js";
import { SqliteEventStore } from "../src/event-store/sqlite-event-store.js";
import { createTestLogger, testConfig } from "./helpers.js";

const AUTHORIZATION = Object.freeze({
    admin: "Development local-admin",
    viewer: "Development local-viewer",
    welfare: "Development local-welfare",
    hardware: "Development local-hardware"
});

test("development authentication requires explicit non-production configuration", () => {
    const disabled = loadConfig({
        NODE_ENV: "development",
        DATABASE_PATH: ":memory:"
    }, { loadEnvFile: false });
    const enabled = loadConfig({
        NODE_ENV: "development",
        DATABASE_PATH: ":memory:",
        ENABLE_DEVELOPMENT_AUTHENTICATION: "true"
    }, { loadEnvFile: false });
    const production = loadConfig({
        NODE_ENV: "production",
        DATABASE_PATH: ":memory:",
        ENABLE_DEVELOPMENT_AUTHENTICATION: "true"
    }, { loadEnvFile: false });

    assert.equal(disabled.enableDevelopmentAuthentication, false);
    assert.equal(enabled.enableDevelopmentAuthentication, true);
    assert.equal(production.enableDevelopmentAuthentication, false);
    assert.throws(() => new DevelopmentAuthProvider({
        config: {
            nodeEnv: "production",
            enableDevelopmentAuthentication: true
        },
        identities: []
    }), /cannot run in production/);
});

function createTestApp(overrides = {}) {
    const logger = createTestLogger();
    const config = { ...testConfig, ...overrides.config };
    const eventEngine = new EventEngine({
        config,
        logger,
        clock: overrides.clock || (() => new Date("2026-07-19T12:00:00.000Z")),
        sleep: overrides.sleep || (async () => {}),
        autoProcess: overrides.autoProcess ?? false
    });
    return createApp({ config, logger, eventEngine });
}

async function closeApp(app) {
    app.locals.contributionLedgerServices.outboxWorker.stop();
    await app.locals.deviceCommandServices.worker.stop();
    app.locals.eventEngine.close();
}

function addSecondBarn(app) {
    const store = app.locals.eventEngine.eventStore;
    const createdAt = "2026-07-19T12:00:00.000Z";
    const barn = createBarn({
        barnId: "barn_security_second",
        name: "Second security Barn",
        createdAt
    });
    const feeder = createFeeder({
        feederId: "feeder_security_second",
        barnId: barn.barnId,
        name: "Second security Feeder",
        createdAt
    });
    store.saveBarn(barn);
    store.saveFeeder(feeder);
    store.saveQueue(createQueue({
        queueId: "queue_security_second",
        barnId: barn.barnId,
        feederId: feeder.feederId,
        name: "Second security Queue",
        createdAt
    }));
    return { barn, feeder };
}

test("development identities authenticate through server-controlled mappings", async () => {
    const app = createTestApp();
    const session = await request(app)
        .get("/api/admin/session")
        .set("authorization", AUTHORIZATION.admin)
        .expect(200);

    assert.equal(
        session.body.administrator.administratorId,
        "administrator_development_platform_admin"
    );
    assert.deepEqual(session.body.administrator.roles, ["ADMINISTRATOR"]);
    assert.equal(session.body.administrator.authenticationStrength, "DEVELOPMENT");
    assert.equal("sessionId" in session.body.administrator, false);

    await request(app).get("/api/admin/session").expect(401);
    await request(app)
        .get("/api/admin/session")
        .set("authorization", "Development caller-selected-ADMINISTRATOR")
        .expect(401);
    await closeApp(app);
});

test("development authentication is rejected in production", async () => {
    const app = createTestApp({
        config: {
            nodeEnv: "production",
            enableDevelopmentAuthentication: true,
            enableDevelopmentContributionSimulation: false
        }
    });
    const response = await request(app)
        .get("/api/admin/session")
        .set("authorization", AUTHORIZATION.admin)
        .expect(401);
    assert.equal(
        response.body.error.code,
        "ADMINISTRATOR_AUTHENTICATION_REQUIRED"
    );
    assert.equal(
        app.locals.administratorSecurityServices.store.getAdministrators().length,
        0
    );
    await closeApp(app);
});

test("suspended and revoked administrators are rejected", async () => {
    for (const status of ["SUSPENDED", "REVOKED"]) {
        const app = createTestApp();
        await request(app)
            .post("/api/admin/administrators/administrator_development_default_viewer/status")
            .set("authorization", AUTHORIZATION.admin)
            .send({ status, reason: `Test ${status.toLowerCase()}` })
            .expect(200);
        const response = await request(app)
            .get("/api/admin/session")
            .set("authorization", AUTHORIZATION.viewer)
            .expect(403);
        assert.equal(response.body.error.code, `ADMINISTRATOR_${status}`);
        await closeApp(app);
    }
});

test("role permissions enforce every approved role capability", () => {
    const authorization = new AuthorizationService();
    const barnId = "barn_role_test";
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
        const identity = {
            status: "ACTIVE",
            assignments: [{
                roleAssignmentId: `assignment_${role}`,
                role,
                platformWide: role === "ADMINISTRATOR",
                barnIds: role === "ADMINISTRATOR" ? [] : [barnId]
            }]
        };
        for (const permission of Object.values(PERMISSIONS)) {
            if (permissions.includes(permission)) {
                assert.equal(
                    authorization.authorize(identity, permission, { barnId })
                        .effectiveRole,
                    role
                );
            } else {
                assert.throws(
                    () => authorization.authorize(identity, permission, { barnId }),
                    error => error.code === "ADMINISTRATOR_PERMISSION_DENIED"
                );
            }
        }
    }
});

test("Barn scopes isolate resources while platform-wide access remains explicit", async () => {
    const app = createTestApp();
    const { barn } = addSecondBarn(app);

    await request(app)
        .get(`/api/admin/barns/${DEFAULT_RESOURCE_IDS.barnId}/status`)
        .set("authorization", AUTHORIZATION.viewer)
        .expect(200);
    await request(app)
        .get(`/api/admin/barns/${barn.barnId}/status`)
        .set("authorization", AUTHORIZATION.viewer)
        .expect(403);
    await request(app)
        .get(`/api/admin/barns/${barn.barnId}/status`)
        .set("authorization", AUTHORIZATION.admin)
        .expect(200);
    await closeApp(app);
});

test("public APIs omit supporter, ledger, timeline and hardware-private data", async () => {
    const app = createTestApp();
    const created = await request(app)
        .post("/api/feed-requests")
        .send({
            supporterName: "Private Supporter",
            message: "Private message",
            clientRequestId: "public-privacy-test"
        })
        .expect(202);
    assert.equal(created.body.providerEvent, undefined);
    assert.equal(created.body.contribution, undefined);
    assert.equal(created.body.feedRequest.supporterName, undefined);
    assert.equal(created.body.feedRequest.timeline, undefined);
    assert.equal(created.body.feedRequest.hardwareAcknowledgements, undefined);

    const publicQueue = await request(app).get("/api/feed-requests").expect(200);
    assert.equal(publicQueue.body.feedRequests[0].supporterName, undefined);
    assert.equal(publicQueue.body.feedRequests[0].contributionId, undefined);

    const adminQueue = await request(app)
        .get(
            `/api/admin/barns/${DEFAULT_RESOURCE_IDS.barnId}`
            + `/feeders/${DEFAULT_RESOURCE_IDS.feederId}/feed-requests`
        )
        .set("authorization", AUTHORIZATION.viewer)
        .expect(200);
    assert.equal(adminQueue.body.feedRequests[0].supporterName, "Private Supporter");
    assert.equal(adminQueue.body.feedRequests[0].timeline.length, 3);
    await closeApp(app);
});

test("administrator, role and Barn-scope management is platform protected and durable", async () => {
    const app = createTestApp();
    const created = await request(app)
        .post("/api/admin/administrators")
        .set("authorization", AUTHORIZATION.admin)
        .send({
            administratorId: "client-chosen-administrator-id",
            externalIdentityId: "oidc:test-operator",
            displayName: "Test Operator",
            email: "test-operator@example.test",
            status: "REVOKED"
        })
        .expect(201);
    const administratorId = created.body.administrator.administratorId;
    assert.notEqual(administratorId, "client-chosen-administrator-id");
    assert.equal(created.body.administrator.status, "ACTIVE");

    const assigned = await request(app)
        .post(`/api/admin/administrators/${administratorId}/role-assignments`)
        .set("authorization", AUTHORIZATION.admin)
        .send({ role: "VIEWER", platformWide: false })
        .expect(201);
    const roleAssignmentId = assigned.body.roleAssignment.roleAssignmentId;

    const scoped = await request(app)
        .post(
            `/api/admin/administrators/${administratorId}`
            + `/role-assignments/${roleAssignmentId}/barn-scopes`
        )
        .set("authorization", AUTHORIZATION.admin)
        .send({ barnId: DEFAULT_RESOURCE_IDS.barnId })
        .expect(201);
    const barnScopeId = scoped.body.barnScope.barnScopeId;

    await request(app)
        .delete(
            `/api/admin/administrators/${administratorId}/barn-scopes/${barnScopeId}`
        )
        .set("authorization", AUTHORIZATION.admin)
        .send({ reason: "Scope no longer needed" })
        .expect(200);
    await request(app)
        .delete(
            `/api/admin/administrators/${administratorId}`
            + `/role-assignments/${roleAssignmentId}`
        )
        .set("authorization", AUTHORIZATION.admin)
        .send({ reason: "Role no longer needed" })
        .expect(200);

    const details = app.locals.administratorSecurityServices
        .administratorService.getAdministratorDetails(administratorId);
    assert.ok(details.roleAssignments[0].revokedAt);
    assert.ok(details.barnScopes[0].revokedAt);
    await closeApp(app);
});

test("successful and rejected sensitive actions create immutable audit records", async () => {
    const app = createTestApp();
    const pausePath = `/api/admin/barns/${DEFAULT_RESOURCE_IDS.barnId}`
        + `/feeders/${DEFAULT_RESOURCE_IDS.feederId}/pause`;

    await request(app)
        .post(pausePath)
        .set("authorization", AUTHORIZATION.viewer)
        .send({ reason: "Viewer must not pause" })
        .expect(403);
    await request(app)
        .post(pausePath)
        .set("authorization", AUTHORIZATION.welfare)
        .send({ reason: "Welfare observation" })
        .expect(200);

    const records = app.locals.administratorSecurityServices.store
        .getAuditRecords({ limit: 1000 });
    assert.ok(records.some(record => (
        record.action === "UNAUTHORIZED_ACTION_REJECTED"
        && record.result === "REJECTED"
    )));
    assert.ok(records.some(record => (
        record.action === "FEEDER_PAUSED"
        && record.result === "SUCCEEDED"
    )));

    const database = app.locals.eventEngine.eventStore.database;
    assert.throws(() => database.prepare(`
        UPDATE OperatorAuditRecords SET reason = 'changed' WHERE auditSequence = ?
    `).run(records[0].auditSequence), /append-only/);
    assert.throws(() => database.prepare(`
        DELETE FROM OperatorAuditRecords WHERE auditSequence = ?
    `).run(records[0].auditSequence), /append-only/);
    await closeApp(app);
});

test("feeder pause is durable and stops new lifecycle work until resume", async () => {
    const app = createTestApp({ autoProcess: true });
    const feederPath = `/api/admin/barns/${DEFAULT_RESOURCE_IDS.barnId}`
        + `/feeders/${DEFAULT_RESOURCE_IDS.feederId}`;
    await request(app)
        .post(`${feederPath}/pause`)
        .set("authorization", AUTHORIZATION.welfare)
        .send({ reason: "Temporary welfare pause" })
        .expect(200);
    const created = await request(app)
        .post("/api/feed-requests")
        .send({ supporterName: "Paused queue supporter" })
        .expect(202);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
        app.locals.eventEngine.getFeedRequest(created.body.feedRequest.eventId).state,
        "QUEUED"
    );
    await request(app)
        .post(`${feederPath}/resume`)
        .set("authorization", AUTHORIZATION.welfare)
        .send({ reason: "Welfare pause cleared" })
        .expect(200);
    await app.locals.eventEngine.waitForIdle();
    assert.equal(
        app.locals.eventEngine.getFeedRequest(created.body.feedRequest.eventId).state,
        "ARCHIVED"
    );
    await closeApp(app);
});

test("hardware operations enforce role, resource assignment and maintenance status", async () => {
    const app = createTestApp();
    const path = `/api/admin/barns/${DEFAULT_RESOURCE_IDS.barnId}`
        + `/devices/${DEFAULT_DEVICE_ID}/status`;
    await request(app)
        .post(path)
        .set("authorization", AUTHORIZATION.welfare)
        .send({ status: "MAINTENANCE", reason: "Inspection" })
        .expect(403);
    const response = await request(app)
        .post(path)
        .set("authorization", AUTHORIZATION.hardware)
        .send({ status: "MAINTENANCE", reason: "Inspection" })
        .expect(200);
    assert.equal(response.body.device.operationalStatus, "MAINTENANCE");
    await request(app)
        .post(
            `/api/admin/barns/barn_wrong/devices/${DEFAULT_DEVICE_ID}/status`
        )
        .set("authorization", AUTHORIZATION.hardware)
        .send({ status: "AVAILABLE", reason: "Wrong Barn" })
        .expect(403);
    await closeApp(app);
});

test("development reset requires a platform Administrator and is audited", async () => {
    const app = createTestApp();
    await request(app).post("/api/event-engine/reset").send({}).expect(401);
    await request(app)
        .post("/api/event-engine/reset")
        .set("authorization", AUTHORIZATION.viewer)
        .send({ reason: "Not permitted" })
        .expect(403);
    await request(app)
        .post("/api/event-engine/reset")
        .set("authorization", AUTHORIZATION.admin)
        .send({ reason: "Automated reset test" })
        .expect(200);
    const records = app.locals.administratorSecurityServices.store
        .getAuditRecords({ limit: 1000 });
    assert.ok(records.some(record => (
        record.action === "DEVELOPMENT_RESET_ATTEMPTED"
        && record.result === "SUCCEEDED"
    )));
    await closeApp(app);
});

test("all required operator actions append their named audit evidence", async () => {
    const app = createTestApp();
    await app.locals.deviceCommandServices.worker.stop();
    const barnId = DEFAULT_RESOURCE_IDS.barnId;
    const feederId = DEFAULT_RESOURCE_IDS.feederId;
    const feederPath = `/api/admin/barns/${barnId}/feeders/${feederId}`;

    await request(app)
        .get("/api/admin/session")
        .set("authorization", "Development invalid-identity")
        .expect(401);
    const createdAdministrator = await request(app)
        .post("/api/admin/administrators")
        .set("authorization", AUTHORIZATION.admin)
        .send({
            externalIdentityId: "oidc:audit-actions",
            displayName: "Audit Actions Operator",
            email: "audit-actions@example.test"
        })
        .expect(201);
    const administratorId = createdAdministrator.body.administrator.administratorId;
    const assignmentResponse = await request(app)
        .post(`/api/admin/administrators/${administratorId}/role-assignments`)
        .set("authorization", AUTHORIZATION.admin)
        .send({ role: "VIEWER" })
        .expect(201);
    const assignmentId = assignmentResponse.body.roleAssignment.roleAssignmentId;
    const scopeResponse = await request(app)
        .post(
            `/api/admin/administrators/${administratorId}`
            + `/role-assignments/${assignmentId}/barn-scopes`
        )
        .set("authorization", AUTHORIZATION.admin)
        .send({ barnId })
        .expect(201);
    const barnScopeId = scopeResponse.body.barnScope.barnScopeId;
    await request(app)
        .delete(
            `/api/admin/administrators/${administratorId}/barn-scopes/${barnScopeId}`
        )
        .set("authorization", AUTHORIZATION.admin)
        .send({ reason: "Audit scope removal" })
        .expect(200);
    await request(app)
        .delete(
            `/api/admin/administrators/${administratorId}`
            + `/role-assignments/${assignmentId}`
        )
        .set("authorization", AUTHORIZATION.admin)
        .send({ reason: "Audit role removal" })
        .expect(200);
    await request(app)
        .post(`/api/admin/administrators/${administratorId}/status`)
        .set("authorization", AUTHORIZATION.admin)
        .send({ status: "SUSPENDED", reason: "Audit suspension" })
        .expect(200);
    await request(app)
        .post(`/api/admin/administrators/${administratorId}/status`)
        .set("authorization", AUTHORIZATION.admin)
        .send({ status: "REVOKED", reason: "Audit revocation" })
        .expect(200);

    await request(app)
        .post(`${feederPath}/pause`)
        .set("authorization", AUTHORIZATION.welfare)
        .send({ reason: "Audit pause" })
        .expect(200);
    await request(app)
        .post(`${feederPath}/resume`)
        .set("authorization", AUTHORIZATION.welfare)
        .send({ reason: "Audit resume" })
        .expect(200);
    await request(app)
        .post(`${feederPath}/unavailable`)
        .set("authorization", AUTHORIZATION.welfare)
        .send({ reason: "Audit unavailable" })
        .expect(200);
    await request(app)
        .post(`${feederPath}/resume`)
        .set("authorization", AUTHORIZATION.welfare)
        .send({ reason: "Audit available again" })
        .expect(200);

    await request(app)
        .post(`/api/admin/barns/${barnId}/devices/${DEFAULT_DEVICE_ID}/status`)
        .set("authorization", AUTHORIZATION.hardware)
        .send({ status: "MAINTENANCE", reason: "Audit maintenance" })
        .expect(200);

    const createdFeed = await request(app)
        .post("/api/feed-requests")
        .send({ supporterName: "Retry audit supporter" })
        .expect(202);
    const feedRequest = app.locals.eventEngine.getFeedRequest(
        createdFeed.body.feedRequest.eventId
    );
    const command = app.locals.deviceCommandServices.deviceCommandService
        .ensureCommandForEvent(feedRequest, "RING_BELL").command;
    app.locals.deviceCommandServices.deviceCommandStore.transitionCommand(
        command.commandId,
        "FAILED",
        {
            timestamp: "2026-07-19T12:00:00.000Z",
            lastError: "Confirmed not processed"
        }
    );
    await request(app)
        .post(
            `/api/admin/barns/${barnId}`
            + `/device-commands/${command.commandId}/retry`
        )
        .set("authorization", AUTHORIZATION.hardware)
        .send({ reason: "Confirmed safe retry" })
        .expect(202);
    await request(app)
        .post(`/api/admin/barns/${barnId}/hardware-alerts/alert-test/acknowledgements`)
        .set("authorization", AUTHORIZATION.hardware)
        .send({
            deviceId: DEFAULT_DEVICE_ID,
            emergencyRelated: true,
            reason: "Alert inspected"
        })
        .expect(201);

    const actions = new Set(app.locals.administratorSecurityServices.store
        .getAuditRecords({ limit: 1000 }).map(record => record.action));
    for (const action of [
        "LOGIN_ACCEPTED",
        "LOGIN_REJECTED",
        "ROLE_ASSIGNED",
        "ROLE_REMOVED",
        "BARN_SCOPE_ASSIGNED",
        "BARN_SCOPE_REMOVED",
        "ADMINISTRATOR_SUSPENDED",
        "ADMINISTRATOR_REVOKED",
        "FEEDER_PAUSED",
        "FEEDER_RESUMED",
        "FEEDER_MARKED_UNAVAILABLE",
        "DEVICE_PLACED_IN_MAINTENANCE",
        "DEVICE_COMMAND_RETRY_REQUESTED",
        "EMERGENCY_RELATED_ACKNOWLEDGED"
    ]) {
        assert.ok(actions.has(action), `Missing operator audit action ${action}`);
    }
    await closeApp(app);
});

test("administrator identities, assignments and audit history recover after restart", async t => {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-admin-restart-"));
    const databasePath = join(directory, "events.sqlite");
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = createTestApp({ config: { databasePath } });
    const created = await request(first)
        .post("/api/admin/administrators")
        .set("authorization", AUTHORIZATION.admin)
        .send({
            externalIdentityId: "oidc:restart-test",
            displayName: "Restart Operator",
            email: "restart-operator@example.test"
        })
        .expect(201);
    const administratorId = created.body.administrator.administratorId;
    await closeApp(first);

    const second = createTestApp({ config: { databasePath } });
    assert.equal(
        second.locals.administratorSecurityServices.store
            .getAdministrator(administratorId).displayName,
        "Restart Operator"
    );
    assert.ok(second.locals.administratorSecurityServices.store
        .getAuditRecords({ limit: 1000 })
        .some(record => record.targetId === administratorId));
    await closeApp(second);
});

test("migration 6 upgrades a Phase 7A schema in place", t => {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-admin-migration-"));
    const databasePath = join(directory, "events.sqlite");
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON;");
    EVENT_STORE_MIGRATIONS.filter(migration => migration.version <= 5)
        .forEach(migration => {
            database.exec("BEGIN IMMEDIATE;");
            migration.up(database);
            database.exec(`PRAGMA user_version = ${migration.version};`);
            database.exec("COMMIT;");
        });
    const feederCount = database.prepare("SELECT COUNT(*) AS count FROM Feeders")
        .get().count;
    database.close();

    const store = new SqliteEventStore({
        databasePath,
        logger: createTestLogger()
    });
    assert.equal(store.getSchemaVersion(), EVENT_STORE_SCHEMA_VERSION);
    assert.equal(
        store.database.prepare("SELECT COUNT(*) AS count FROM Feeders").get().count,
        feederCount
    );
    assert.ok(store.getTableNames().includes("Administrators"));
    assert.ok(store.getTableNames().includes("OperatorAuditRecords"));
    store.close();
});
