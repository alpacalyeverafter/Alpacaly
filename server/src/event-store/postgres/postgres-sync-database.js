import { Worker } from "node:worker_threads";

const RESPONSE_BUFFER_BYTES = 16 * 1024 * 1024;

class PostgresSyncStatement {
    constructor(database, sql) {
        this.database = database;
        this.sql = sql;
    }

    run(...parameters) {
        const result = this.database.query(this.sql, parameters);
        return { changes: result.changes };
    }

    get(...parameters) {
        return this.database.query(this.sql, parameters).rows[0];
    }

    all(...parameters) {
        return this.database.query(this.sql, parameters).rows;
    }
}

export class PostgresSyncDatabase {
    constructor({
        connectionString,
        poolMin = 1,
        poolMax = 10,
        connectionTimeoutMs = 5000,
        statementTimeoutMs = 15000,
        lockTimeoutMs = 5000,
        idleTransactionTimeoutMs = 15000,
        sslMode = "verify-full",
        tlsCa = null,
        applicationName = "alpacaly-server",
        requestTimeoutMs = 30000
    }) {
        this.closed = false;
        this.requestTimeoutMs = requestTimeoutMs;
        this.worker = new Worker(
            new URL("./postgres-database-worker.js", import.meta.url),
            {
                workerData: {
                    connectionString,
                    poolMin,
                    poolMax,
                    connectionTimeoutMs,
                    statementTimeoutMs,
                    lockTimeoutMs,
                    idleTransactionTimeoutMs,
                    sslMode,
                    tlsCa,
                    applicationName
                }
            }
        );
        this.worker.unref();
        this.workerError = null;
        this.worker.on("error", error => {
            this.workerError = error;
        });
        this.request("diagnostics");
    }

    request(action, payload = {}) {
        if (this.closed && action !== "close") {
            throw new Error("PostgreSQL database adapter is closed.");
        }
        if (this.workerError) {
            throw this.workerError;
        }
        const sharedBuffer = new SharedArrayBuffer(RESPONSE_BUFFER_BYTES + 8);
        const control = new Int32Array(sharedBuffer, 0, 2);
        this.worker.postMessage({ action, ...payload, sharedBuffer });
        const status = Atomics.wait(control, 0, 0, this.requestTimeoutMs);
        if (status === "timed-out") {
            throw new Error(`PostgreSQL ${action} operation timed out.`);
        }
        const length = Atomics.load(control, 1);
        const bytes = new Uint8Array(sharedBuffer, 8, length);
        const response = JSON.parse(new TextDecoder().decode(bytes));
        if (!response.ok) {
            const error = new Error(response.error.message);
            Object.assign(error, response.error);
            throw error;
        }
        return response.value;
    }

    prepare(sql) {
        return new PostgresSyncStatement(this, sql);
    }

    query(sql, parameters) {
        return this.request("query", { sql, parameters });
    }

    exec(sql) {
        return this.request("exec", { sql });
    }

    registerIdentifiers(source) {
        return this.request("registerIdentifiers", { source });
    }

    getDiagnostics() {
        return this.request("diagnostics");
    }

    close() {
        if (this.closed) {
            return;
        }
        try {
            this.request("close");
        } finally {
            this.closed = true;
            void this.worker.terminate();
        }
    }
}
