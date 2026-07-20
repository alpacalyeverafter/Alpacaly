import { parentPort, workerData } from "node:worker_threads";

import pg from "pg";

const { Pool, types } = pg;

types.setTypeParser(20, value => Number(value));
// Keep JSON/JSONB compatible with the existing store mappers, which deliberately
// parse persisted JSON at the domain boundary.
types.setTypeParser(114, value => value);
types.setTypeParser(3802, value => value);

const identifiers = new Map();
let transactionClient = null;

function sslConfiguration(mode) {
    if (mode === "disable") {
        return false;
    }
    return {
        rejectUnauthorized: mode === "verify-full",
        ...(workerData.tlsCa ? { ca: workerData.tlsCa } : {})
    };
}

const pool = new Pool({
    connectionString: workerData.connectionString,
    min: workerData.poolMin,
    max: workerData.poolMax,
    connectionTimeoutMillis: workerData.connectionTimeoutMs,
    application_name: workerData.applicationName,
    ssl: sslConfiguration(workerData.sslMode)
});

pool.on("connect", client => {
    const settings = [
        `SET statement_timeout = ${Number(workerData.statementTimeoutMs)}`,
        `SET lock_timeout = ${Number(workerData.lockTimeoutMs)}`,
        `SET idle_in_transaction_session_timeout = ${Number(
            workerData.idleTransactionTimeoutMs
        )}`
    ];
    void client.query(settings.join("; "));
});

function rememberIdentifiers(source) {
    const text = Array.isArray(source) ? source.join("\n") : String(source || "");
    for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9_]*\b/g)) {
        const value = match[0];
        if (/[A-Z]/.test(value)) {
            identifiers.set(value.toLowerCase(), value);
        }
    }
}

function translateSql(source) {
    rememberIdentifiers(source);
    let sql = String(source).trim();
    let ignoreConflict = false;
    if (/^INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql)) {
        sql = sql.replace(/^INSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO");
        ignoreConflict = true;
    }

    let output = "";
    let parameter = 0;
    let quote = null;
    for (let index = 0; index < sql.length; index += 1) {
        const character = sql[index];
        if (quote) {
            output += character;
            if (character === quote) {
                if (sql[index + 1] === quote) {
                    output += sql[index + 1];
                    index += 1;
                } else {
                    quote = null;
                }
            }
            continue;
        }
        if (character === "'" || character === '"') {
            quote = character;
            output += character;
            continue;
        }
        if (character === "?") {
            parameter += 1;
            const prior = output.match(/\bIS\s+NOT\s*$/i);
            if (prior) {
                output = output.slice(0, prior.index) + "IS DISTINCT FROM ";
            } else {
                const nullable = output.match(/\bIS\s*$/i);
                if (nullable) {
                    output = output.slice(0, nullable.index) + "IS NOT DISTINCT FROM ";
                }
            }
            const nullPredicate = /^\s+IS\s+(?:NOT\s+)?NULL\b/i.test(
                sql.slice(index + 1)
            );
            // PostgreSQL cannot infer the type of a null parameter used only by
            // an IS NULL predicate. The cast preserves nullness and is confined
            // to this PostgreSQL compatibility path.
            output += nullPredicate
                ? `CAST($${parameter} AS TEXT)`
                : `$${parameter}`;
            continue;
        }
        output += character;
    }

    if (ignoreConflict) {
        const suffix = output.endsWith(";") ? ";" : "";
        output = `${output.replace(/;$/, "")} ON CONFLICT DO NOTHING${suffix}`;
    }
    return output;
}

function normalizeRow(row) {
    if (!row) {
        return row;
    }
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [
        identifiers.get(key.toLowerCase()) || key,
        value
    ]));
}

function serializeError(error) {
    return {
        message: String(error?.message || error),
        name: error?.name || "Error",
        code: error?.code,
        constraint: error?.constraint,
        detail: error?.detail
    };
}

function respond(sharedBuffer, payload) {
    const control = new Int32Array(sharedBuffer, 0, 2);
    const output = new Uint8Array(sharedBuffer, 8);
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    if (encoded.byteLength > output.byteLength) {
        const fallback = new TextEncoder().encode(JSON.stringify({
            ok: false,
            error: { message: "PostgreSQL response exceeded the synchronous adapter buffer." }
        }));
        output.set(fallback);
        Atomics.store(control, 1, fallback.byteLength);
    } else {
        output.set(encoded);
        Atomics.store(control, 1, encoded.byteLength);
    }
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
}

async function query(sql, parameters = []) {
    const client = transactionClient || pool;
    const result = await client.query(translateSql(sql), parameters);
    return {
        rows: result.rows.map(normalizeRow),
        changes: result.rowCount ?? 0
    };
}

async function execute(message) {
    switch (message.action) {
        case "registerIdentifiers":
            rememberIdentifiers(message.source);
            return true;
        case "query":
            return query(message.sql, message.parameters);
        case "exec": {
            const sql = String(message.sql).trim();
            if (/^BEGIN(?:\s|;|$)/i.test(sql)) {
                if (transactionClient) {
                    throw new Error("A PostgreSQL transaction is already active.");
                }
                transactionClient = await pool.connect();
                try {
                    await transactionClient.query("BEGIN");
                } catch (error) {
                    transactionClient.release();
                    transactionClient = null;
                    throw error;
                }
                return true;
            }
            if (/^(?:COMMIT|ROLLBACK)(?:\s|;|$)/i.test(sql)) {
                if (!transactionClient) {
                    throw new Error("No PostgreSQL transaction is active.");
                }
                const client = transactionClient;
                transactionClient = null;
                try {
                    await client.query(sql.replace(/;$/, ""));
                } finally {
                    client.release();
                }
                return true;
            }
            await (transactionClient || pool).query(sql);
            return true;
        }
        case "diagnostics": {
            const startedAt = performance.now();
            await pool.query("SELECT 1");
            return {
                totalConnections: pool.totalCount,
                idleConnections: pool.idleCount,
                waitingRequests: pool.waitingCount,
                inTransaction: Boolean(transactionClient),
                roundTripMs: Math.round((performance.now() - startedAt) * 100) / 100
            };
        }
        case "close":
            if (transactionClient) {
                const client = transactionClient;
                transactionClient = null;
                try {
                    await client.query("ROLLBACK");
                } finally {
                    client.release();
                }
            }
            await pool.end();
            return true;
        default:
            throw new Error(`Unsupported PostgreSQL adapter action: ${message.action}`);
    }
}

parentPort.on("message", async message => {
    try {
        const value = await execute(message);
        respond(message.sharedBuffer, { ok: true, value });
    } catch (error) {
        respond(message.sharedBuffer, { ok: false, error: serializeError(error) });
    }
});
