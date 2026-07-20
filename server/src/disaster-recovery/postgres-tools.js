import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import pg from "pg";

const { Client } = pg;

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
    captureOutput = false
} = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
            env: {
                ...env,
                ...(connectionString ? { PGDATABASE: connectionString } : {})
            },
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
            failure.toolOutput = stderr.slice(0, 2000);
            reject(failure);
        });
    });
}

export async function assertPostgresToolAvailable(binary, runner = runPostgresTool) {
    const result = await runner(binary, ["--version"], { captureOutput: true });
    return result.stdout || result.stderr;
}
