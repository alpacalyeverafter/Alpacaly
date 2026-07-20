import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import pg from "pg";

const { Client } = pg;

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const POSTGRES_SSL_MODES = new Set([
    "disable", "allow", "prefer", "require", "verify-ca", "verify-full"
]);

function invalidToolConnection(reason) {
    const error = new Error(`PostgreSQL tool connection ${reason}.`);
    error.code = "POSTGRES_TOOL_CONNECTION_INVALID";
    return error;
}

function decodeConnectionPart(value, name) {
    let decoded;
    try {
        decoded = decodeURIComponent(value);
    } catch {
        throw invalidToolConnection(`has an invalid encoded ${name}`);
    }
    if (decoded.includes("\0")) {
        throw invalidToolConnection(`has an invalid ${name}`);
    }
    return decoded;
}

function redactToolOutput(output, connectionString) {
    if (!connectionString) {
        return output;
    }
    const parsed = new URL(connectionString);
    const secrets = [
        connectionString,
        parsed.password,
        decodeURIComponent(parsed.password)
    ].filter(Boolean);
    return secrets.reduce(
        (redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
        output
    );
}

export function createPostgresToolEnvironment(connectionString, {
    env = process.env,
    sslMode = "disable",
    tlsCaPath = null
} = {}) {
    if (typeof connectionString !== "string" || !connectionString.trim()) {
        throw invalidToolConnection("requires a PostgreSQL URL");
    }
    let parsed;
    try {
        parsed = new URL(connectionString);
    } catch {
        throw invalidToolConnection("requires a valid PostgreSQL URL");
    }
    if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) {
        throw invalidToolConnection("must use the postgres or postgresql scheme");
    }

    const host = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname;
    if (!host) {
        throw invalidToolConnection("requires a host");
    }
    const username = decodeConnectionPart(parsed.username, "username");
    if (!username) {
        throw invalidToolConnection("requires a username");
    }
    const database = decodeConnectionPart(parsed.pathname.slice(1), "database name");
    if (!database) {
        throw invalidToolConnection("requires a database name");
    }
    const port = parsed.port || "5432";
    const numericPort = Number(port);
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
        throw invalidToolConnection("has an invalid port");
    }
    const normalizedSslMode = String(sslMode || "").trim().toLowerCase();
    if (!POSTGRES_SSL_MODES.has(normalizedSslMode)) {
        throw invalidToolConnection("has an invalid SSL mode");
    }
    const password = decodeConnectionPart(parsed.password, "password");
    const rootCertificate = tlsCaPath === null || tlsCaPath === undefined
        ? null
        : String(tlsCaPath).trim();
    if (rootCertificate?.includes("\0")) {
        throw invalidToolConnection("has an invalid SSL root certificate path");
    }

    const inherited = Object.fromEntries(
        Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith("PG"))
    );
    return {
        ...inherited,
        PGHOST: host,
        PGPORT: port,
        PGUSER: username,
        ...(password ? { PGPASSWORD: password } : {}),
        PGDATABASE: database,
        PGSSLMODE: normalizedSslMode,
        ...(rootCertificate ? { PGSSLROOTCERT: rootCertificate } : {})
    };
}

export function postgresSslConfiguration({ sslMode = "disable", tlsCaPath = null } = {}) {
    if (sslMode === "disable") {
        return false;
    }
    if (sslMode === "verify-full") {
        return {
            rejectUnauthorized: true,
            ...(tlsCaPath ? { ca: readFileSync(tlsCaPath, "utf8") } : {})
        };
    }
    return { rejectUnauthorized: false };
}

export function createPostgresClient(connectionString, options = {}) {
    return new Client({
        connectionString,
        ssl: postgresSslConfiguration(options)
    });
}

export function runPostgresTool(binary, args, {
    connectionString = null,
    env = process.env,
    sslMode = "disable",
    tlsCaPath = null,
    spawnProcess = spawn,
    captureOutput = false
} = {}) {
    return new Promise((resolve, reject) => {
        const versionCheck = args.length === 1 && args[0] === "--version";
        if (connectionString === null && !versionCheck) {
            throw invalidToolConnection("requires a PostgreSQL URL");
        }
        const childEnvironment = connectionString === null
            ? { ...env }
            : createPostgresToolEnvironment(connectionString, {
                env,
                sslMode,
                tlsCaPath
            });
        const child = spawnProcess(binary, args, {
            env: childEnvironment,
            stdio: ["ignore", captureOutput ? "pipe" : "ignore", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("error", error => {
            if (error.code === "ENOENT") {
                const unavailable = new Error(`${binary} is not installed or is not executable.`);
                unavailable.code = "POSTGRES_TOOL_UNAVAILABLE";
                reject(unavailable);
                return;
            }
            reject(error);
        });
        child.on("exit", code => {
            if (code === 0) {
                resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
                return;
            }
            const failure = new Error(`${binary} failed with exit code ${code}.`);
            failure.code = "POSTGRES_TOOL_FAILED";
            failure.toolOutput = redactToolOutput(
                stderr.slice(0, 2000),
                connectionString
            );
            reject(failure);
        });
    });
}

export async function assertPostgresToolAvailable(binary, runner = runPostgresTool) {
    const result = await runner(binary, ["--version"], { captureOutput: true });
    return result.stdout || result.stderr;
}
