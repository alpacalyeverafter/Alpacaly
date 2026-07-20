import assert from "node:assert/strict";
import test from "node:test";

import { SqliteEventStore } from "../src/event-store/sqlite-event-store.js";
import { DistributedClaimStore } from "../src/worker-coordination/distributed-claim-store.js";
import { createTestLogger } from "./helpers.js";

function identity(workerId, serviceType = "test-worker") {
    return {
        workerId,
        serviceType,
        processInstanceId: workerId,
        bootId: `boot-${workerId}`,
        startedAt: "2026-07-20T10:00:00.000Z",
        softwareVersion: "test",
        environment: "test",
        metadata: null
    };
}

function context({ maximumAttempts = 3 } = {}) {
    let now = new Date("2026-07-20T10:00:00.000Z");
    const clock = () => new Date(now);
    const eventStore = new SqliteEventStore({
        databasePath: ":memory:",
        logger: createTestLogger()
    });
    const options = {
        eventStore,
        clock,
        leaseDurationMs: 1000,
        maximumClaimDurationMs: 10_000,
        clockSkewToleranceMs: 0,
        reclaimDelayMs: 0,
        maximumAttempts
    };
    return {
        eventStore,
        first: new DistributedClaimStore(options),
        second: new DistributedClaimStore(options),
        advance(milliseconds) {
            now = new Date(now.getTime() + milliseconds);
        }
    };
}

test("only one worker owns a work item and stale owners are fenced", () => {
    const state = context();
    const firstIdentity = identity("worker-a");
    const secondIdentity = identity("worker-b");
    state.first.registerWorker(firstIdentity);
    state.second.registerWorker(secondIdentity);

    const firstClaim = state.first.claim("TEST", "same-item", firstIdentity);
    assert.ok(firstClaim);
    assert.equal(state.second.claim("TEST", "same-item", secondIdentity), null);

    state.advance(1001);
    const reclaimed = state.second.claim("TEST", "same-item", secondIdentity);
    assert.ok(reclaimed);
    assert.equal(reclaimed.claimGeneration, firstClaim.claimGeneration + 1);
    assert.equal(state.first.complete(firstClaim, firstIdentity), false);
    assert.equal(state.second.complete(reclaimed, secondIdentity), true);
    assert.equal(state.second.get("TEST", "same-item").state, "COMPLETED");

    state.eventStore.close();
});

test("bounded retry moves exhausted work to the dead letter state", () => {
    const state = context({ maximumAttempts: 2 });
    const worker = identity("retry-worker");
    state.first.registerWorker(worker);

    const firstClaim = state.first.claim("TEST", "failing-item", worker);
    state.first.fail(firstClaim, worker, {
        error: new Error("first failure"),
        retryAt: "2026-07-20T10:00:00.000Z"
    });
    const secondClaim = state.first.claim("TEST", "failing-item", worker);
    state.first.fail(secondClaim, worker, {
        error: new Error("second failure"),
        retryAt: "2026-07-20T10:00:00.000Z"
    });

    const finalClaim = state.first.get("TEST", "failing-item");
    assert.equal(finalClaim.state, "DEAD_LETTER");
    assert.equal(finalClaim.terminal, true);
    assert.equal(state.first.claim("TEST", "failing-item", worker), null);
    assert.deepEqual(
        state.first.getHistory("TEST", "failing-item").map(entry => entry.action),
        ["CLAIMED", "FAILED", "CLAIMED", "DEAD_LETTER"]
    );

    state.eventStore.close();
});

test("potentially completed work is never retried automatically", () => {
    const state = context();
    const worker = identity("uncertain-worker");
    state.first.registerWorker(worker);
    const claim = state.first.claim("DEVICE_COMMAND", "uncertain-item", worker);
    state.first.fail(claim, worker, {
        error: new Error("connection lost after send"),
        potentiallyCompleted: true,
        failureCode: "PHYSICAL_OUTCOME_UNKNOWN"
    });

    const finalClaim = state.first.get("DEVICE_COMMAND", "uncertain-item");
    assert.equal(finalClaim.state, "OPERATOR_REVIEW");
    assert.equal(finalClaim.operatorReviewRequired, true);
    assert.equal(state.first.claim(
        "DEVICE_COMMAND",
        "uncertain-item",
        worker
    ), null);

    state.eventStore.close();
});

test("claim history is append-only", () => {
    const state = context();
    const worker = identity("audit-worker");
    state.first.registerWorker(worker);
    state.first.claim("TEST", "audited-item", worker);

    assert.throws(() => state.eventStore.database.exec(`
        UPDATE WorkClaimHistory SET action = 'ALTERED'
    `), /append-only/);
    assert.throws(() => state.eventStore.database.exec(`
        DELETE FROM WorkClaimHistory
    `), /append-only/);

    state.eventStore.close();
});
