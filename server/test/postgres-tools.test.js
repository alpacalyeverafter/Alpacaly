import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
    createPostgresToolEnvironment,
    runPostgresTool
} from "../src/disaster-recovery/postgres-tools.js";
import {
    createPostgresRestoreArguments
} from "../src/disaster-recovery/postgres-restore-service.js";

function successfulSpawn(calls) {
    return (binary, args, options) => {
        calls.push({ binary, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => child.emit("exit", 0));
        return child;
    };
}

function failingSpawn(toolOutput) {
    return () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
            child.stderr.emit("data", Buffer.from(toolOutput));
            child.emit("exit", 1);
        });
        return child;
    };
}

test("PostgreSQL tool URLs become isolated decoded libpq environments", () => {
    const inherited = {
        PATH: "/test/bin",
        KEEP_ME: "preserved",
        PGHOST: "redirect.invalid",
        PGHOSTADDR: "192.0.2.1",
        PGPORT: "9999",
        PGUSER: "inherited-user",
        PGPASSWORD: "inherited-password",
        PGDATABASE: "inherited-database",
        PGSERVICE: "redirect-service",
        PGSERVICEFILE: "/tmp/redirect-service.conf",
        PGPASSFILE: "/tmp/redirect-passwords",
        PGOPTIONS: "-c search_path=redirected",
        PGSSLROOTCERT: "/tmp/inherited-ca.pem"
    };
    const connectionString = [
        "postgresql://backup%40operator:p%40ss%2Fword",
        "@postgres.internal:5544/alpacaly%20restore"
    ].join("");
    const environment = createPostgresToolEnvironment(connectionString, {
        env: inherited,
        sslMode: "verify-full",
        tlsCaPath: "/etc/alpacaly/postgres-ca.pem"
    });

    assert.equal(environment.PGHOST, "postgres.internal");
    assert.equal(environment.PGPORT, "5544");
    assert.equal(environment.PGUSER, "backup@operator");
    assert.equal(environment.PGPASSWORD, "p@ss/word");
    assert.equal(environment.PGDATABASE, "alpacaly restore");
    assert.equal(environment.PGSSLMODE, "verify-full");
    assert.equal(environment.PGSSLROOTCERT, "/etc/alpacaly/postgres-ca.pem");
    assert.equal(environment.PGSERVICE, undefined);
    assert.equal(environment.PGSERVICEFILE, undefined);
    assert.equal(environment.PGHOSTADDR, undefined);
    assert.equal(environment.PGPASSFILE, undefined);
    assert.equal(environment.PGOPTIONS, undefined);
    assert.equal(environment.KEEP_ME, "preserved");
    assert.equal(environment.PATH, "/test/bin");
    assert.equal(inherited.PGHOST, "redirect.invalid");
});

test("PostgreSQL tool connections support default ports and no password", () => {
    const environment = createPostgresToolEnvironment(
        "postgres://test-user@127.0.0.1/test_database",
        { env: { PGPASSWORD: "must-not-survive" }, sslMode: "disable" }
    );

    assert.equal(environment.PGHOST, "127.0.0.1");
    assert.equal(environment.PGPORT, "5432");
    assert.equal(environment.PGUSER, "test-user");
    assert.equal(environment.PGDATABASE, "test_database");
    assert.equal(environment.PGSSLMODE, "disable");
    assert.equal("PGPASSWORD" in environment, false);
    assert.equal("PGSSLROOTCERT" in environment, false);
});

test("pg_dump and pg_restore share secret-safe environment-only connections", async () => {
    const calls = [];
    const connectionString = [
        "postgres://native-tool-user:native%20tool%20password",
        "@postgres.example:5433/native_tool_database"
    ].join("");
    const options = {
        connectionString,
        env: {
            PATH: "/test/bin",
            PGHOST: "wrong-host",
            PGSERVICE: "wrong-service"
        },
        sslMode: "require",
        spawnProcess: successfulSpawn(calls)
    };

    await runPostgresTool("pg_dump", [
        "--format=custom",
        "--file=/safe/backup.dump"
    ], options);
    await runPostgresTool("pg_restore", createPostgresRestoreArguments(
        "native_tool_database",
        "/safe/backup.dump"
    ), options);

    assert.deepEqual(calls.map(call => call.binary), ["pg_dump", "pg_restore"]);
    assert.deepEqual(calls[0].options.env, calls[1].options.env);
    assert.equal(calls[0].options.env.PGHOST, "postgres.example");
    assert.equal(calls[0].options.env.PGPASSWORD, "native tool password");
    assert.equal(calls[0].options.env.PGSERVICE, undefined);
    const restoreArguments = calls[1].args;
    assert.deepEqual(restoreArguments, [
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "--dbname=native_tool_database",
        "/safe/backup.dump"
    ]);
    assert.equal(restoreArguments.at(-1), "/safe/backup.dump");
    assert.equal(restoreArguments.some(argument => (
        argument === "--file" || argument.startsWith("--file=")
    )), false);
    assert.equal(restoreArguments.includes(connectionString), false);
    assert.equal(restoreArguments.some(argument => (
        argument.includes("native-tool-user")
    )), false);
    assert.equal(restoreArguments.some(argument => (
        argument.includes("native tool password")
    )), false);
});

test("PostgreSQL tool connection URLs fail clearly when incomplete or malformed", () => {
    const invalidConnections = [
        null,
        "",
        "not-a-url",
        "mysql://user:password@localhost/database",
        "postgres:///database",
        "postgres://localhost/database",
        "postgres://user@localhost/",
        "postgres://user%ZZ@localhost/database"
    ];

    invalidConnections.forEach(connectionString => {
        assert.throws(
            () => createPostgresToolEnvironment(connectionString),
            error => error.code === "POSTGRES_TOOL_CONNECTION_INVALID"
                && /^PostgreSQL tool connection /.test(error.message)
        );
    });
    assert.throws(
        () => createPostgresToolEnvironment(
            "postgres://user@localhost/database",
            { sslMode: "not-an-ssl-mode" }
        ),
        error => error.code === "POSTGRES_TOOL_CONNECTION_INVALID"
            && /invalid SSL mode/.test(error.message)
    );
});

test("connecting PostgreSQL tool calls fail before spawn without a URL", async () => {
    let spawned = false;
    await assert.rejects(runPostgresTool("pg_dump", ["--format=custom"], {
        spawnProcess() {
            spawned = true;
        }
    }), error => error.code === "POSTGRES_TOOL_CONNECTION_INVALID"
        && /requires a PostgreSQL URL/.test(error.message));
    assert.equal(spawned, false);
});

test("PostgreSQL tool failures redact URLs and passwords from retained output", async () => {
    const connectionString = [
        "postgres://backup-user:do%20not%20log",
        "@postgres.example/backup_database"
    ].join("");
    const simulatedOutput = [
        `connection ${connectionString} failed`,
        "password do not log was rejected"
    ].join("; ");

    await assert.rejects(runPostgresTool("pg_dump", ["--format=custom"], {
        connectionString,
        spawnProcess: failingSpawn(simulatedOutput)
    }), error => error.code === "POSTGRES_TOOL_FAILED"
        && !error.message.includes(connectionString)
        && !error.toolOutput.includes(connectionString)
        && !error.toolOutput.includes("do not log")
        && error.toolOutput.includes("[REDACTED]"));
});
