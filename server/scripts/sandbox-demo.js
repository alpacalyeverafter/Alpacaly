import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import dotenv from "dotenv";

import { STRIPE_SANDBOX_EVENT_TYPES } from "../src/payments/sandbox-event-types.js";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SERVER_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const REPOSITORY_DIRECTORY = resolve(SERVER_DIRECTORY, "..");
const API_PORT = 3000;
const WEBSITE_PORT = 8000;
const API_HOST = "127.0.0.1";
const WEBSITE_HOST = "127.0.0.1";
const WEBHOOK_PATH = "/api/payments/webhooks/stripe";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class SandboxPreflightError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "SandboxPreflightError";
        this.code = code;
    }
}

export class SandboxLaunchError extends Error {
    constructor(message, code = "SANDBOX_COMPONENT_FAILED") {
        super(message);
        this.name = "SandboxLaunchError";
        this.code = code;
    }
}

function failPreflight(message, code) {
    throw new SandboxPreflightError(message, code);
}

function executableAvailable(command, args, env) {
    const result = spawnSync(command, args, {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
    });
    return !result.error && result.status === 0;
}

export function stripeConfigPath(env = process.env, homeDirectory = homedir()) {
    const configRoot = String(env.XDG_CONFIG_HOME || "").trim()
        || resolve(homeDirectory, ".config");
    return resolve(configRoot, "stripe", "config.toml");
}

function profileTestKey(configText, profileName) {
    let activeSection = null;
    for (const line of String(configText || "").split(/\r?\n/)) {
        const section = /^\s*\[([^\]]+)]\s*$/.exec(line);
        if (section) {
            activeSection = section[1];
            continue;
        }
        if (activeSection !== profileName) {
            continue;
        }
        const key = /^\s*test_mode_api_key\s*=\s*["']([^"']+)["']\s*$/.exec(line);
        if (key) {
            return key[1];
        }
    }
    return null;
}

export function isPortAvailable(port, host = API_HOST) {
    return new Promise(resolveAvailability => {
        const server = createNetServer();
        server.unref();
        server.once("error", () => resolveAvailability(false));
        server.listen({ port, host, exclusive: true }, () => {
            server.close(() => resolveAvailability(true));
        });
    });
}

export async function runSandboxPreflight({
    env = process.env,
    args = [],
    nodeVersion = process.versions.node,
    commandProbe = executableAvailable,
    portProbe = isPortAvailable,
    readStripeConfig = path => readFileSync(path, "utf8"),
    homeDirectory = homedir()
} = {}) {
    if (args.length > 0 || String(env.STRIPE_CLI_EXTRA_ARGS || "").trim()) {
        failPreflight(
            "The sandbox demo accepts no extra command-line arguments.",
            "SANDBOX_EXTRA_ARGUMENTS_REJECTED"
        );
    }
    if (!commandProbe(process.execPath, ["--version"], env)) {
        failPreflight("Node.js is not available.", "SANDBOX_NODE_UNAVAILABLE");
    }
    if (Number(String(nodeVersion).split(".")[0]) !== 24) {
        failPreflight("The sandbox demo requires Node.js 24.", "SANDBOX_NODE_UNSUPPORTED");
    }
    if (!commandProbe("stripe", ["--version"], env)) {
        failPreflight("The Stripe CLI is not available.", "SANDBOX_STRIPE_CLI_UNAVAILABLE");
    }
    if (String(env.NODE_ENV || "development").trim().toLowerCase() === "production") {
        failPreflight("The sandbox demo cannot run in production mode.", "SANDBOX_PRODUCTION_REJECTED");
    }
    if (String(env.ENABLE_PAYMENT_SANDBOX || "").trim().toLowerCase() !== "true") {
        failPreflight(
            "ENABLE_PAYMENT_SANDBOX must be true.",
            "SANDBOX_NOT_ENABLED"
        );
    }
    if (String(env.PORT || API_PORT).trim() !== String(API_PORT)) {
        failPreflight("The sandbox API port must be 3000.", "SANDBOX_API_PORT_INVALID");
    }

    let publicUrl;
    try {
        publicUrl = new URL(String(env.PAYMENT_PUBLIC_BASE_URL || ""));
    } catch {
        failPreflight(
            "PAYMENT_PUBLIC_BASE_URL must be the local website URL on port 8000.",
            "SANDBOX_PUBLIC_URL_INVALID"
        );
    }
    if (
        publicUrl.protocol !== "http:"
        || !LOOPBACK_HOSTS.has(publicUrl.hostname)
        || publicUrl.port !== String(WEBSITE_PORT)
        || !["", "/"].includes(publicUrl.pathname)
        || publicUrl.username
        || publicUrl.password
        || publicUrl.search
        || publicUrl.hash
    ) {
        failPreflight(
            "PAYMENT_PUBLIC_BASE_URL must be an HTTP loopback URL on port 8000.",
            "SANDBOX_PUBLIC_URL_NOT_LOCAL"
        );
    }

    const stripeKey = String(env.STRIPE_TEST_SECRET_KEY || "").trim();
    if (!stripeKey.startsWith("sk_test_") || stripeKey.length < 12) {
        failPreflight(
            "STRIPE_TEST_SECRET_KEY must contain a Stripe test-mode secret key.",
            "SANDBOX_TEST_KEY_REQUIRED"
        );
    }
    const webhookSecret = String(env.STRIPE_TEST_WEBHOOK_SECRET || "").trim();
    if (!webhookSecret.startsWith("whsec_") || webhookSecret.length < 10) {
        failPreflight(
            "STRIPE_TEST_WEBHOOK_SECRET must contain a local test webhook secret.",
            "SANDBOX_WEBHOOK_SECRET_REQUIRED"
        );
    }

    const profileName = String(env.STRIPE_CLI_PROJECT || "").trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(profileName)) {
        failPreflight(
            "STRIPE_CLI_PROJECT must name an existing sandbox profile.",
            "SANDBOX_STRIPE_PROFILE_REQUIRED"
        );
    }
    let stripeConfig;
    try {
        stripeConfig = readStripeConfig(stripeConfigPath(env, homeDirectory));
    } catch {
        failPreflight(
            "The Stripe CLI configuration could not be read.",
            "SANDBOX_STRIPE_CONFIG_UNAVAILABLE"
        );
    }
    const profileKey = profileTestKey(stripeConfig, profileName);
    if (!profileKey) {
        failPreflight(
            "The configured Stripe CLI sandbox profile does not exist or is not authenticated.",
            "SANDBOX_STRIPE_PROFILE_NOT_FOUND"
        );
    }
    if (!/^(?:rk|sk)_test_/.test(profileKey)) {
        failPreflight(
            "The configured Stripe CLI profile is not test-only.",
            "SANDBOX_STRIPE_PROFILE_NOT_TEST_ONLY"
        );
    }

    const [apiPortAvailable, websitePortAvailable] = await Promise.all([
        portProbe(API_PORT, API_HOST),
        portProbe(WEBSITE_PORT, WEBSITE_HOST)
    ]);
    if (!apiPortAvailable) {
        failPreflight("Port 3000 is already in use.", "SANDBOX_API_PORT_IN_USE");
    }
    if (!websitePortAvailable) {
        failPreflight("Port 8000 is already in use.", "SANDBOX_WEBSITE_PORT_IN_USE");
    }

    return Object.freeze({
        apiPort: API_PORT,
        websitePort: WEBSITE_PORT,
        profileName,
        publicBaseUrl: publicUrl.toString().replace(/\/$/, ""),
        eventTypes: [...STRIPE_SANDBOX_EVENT_TYPES]
    });
}

export function redactSecrets(value, secrets = []) {
    let redacted = String(value ?? "");
    for (const secret of secrets) {
        const normalized = String(secret || "");
        if (normalized.length >= 4) {
            redacted = redacted.replaceAll(normalized, "<redacted>");
        }
    }
    return redacted
        .replace(/\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9_-]{4,}\b/g, "<redacted>")
        .replace(/\bwhsec_[A-Za-z0-9_-]{4,}\b/g, "<redacted>")
        .replace(/\b(?:stripe-signature|authorization)\s*[:=]\s*[^\s,]+/gi, matched => (
            `${matched.split(/[:=]/, 1)[0]}=<redacted>`
        ));
}

function writeLine(stream, label, line, secrets) {
    const safeLine = redactSecrets(line, secrets).trimEnd();
    if (safeLine) {
        stream.write(`[${label}] ${safeLine}\n`);
    }
}

function attachLabeledOutput(source, {
    label,
    stream,
    secrets,
    onLine = () => {}
}) {
    if (!source?.on) {
        return;
    }
    let pending = "";
    source.setEncoding?.("utf8");
    source.on("data", chunk => {
        pending += String(chunk);
        const lines = pending.split(/[\r\n]+/);
        pending = lines.pop() || "";
        for (const line of lines) {
            onLine(line);
            writeLine(stream, label, line, secrets);
        }
    });
    source.on("end", () => {
        if (pending) {
            onLine(pending);
            writeLine(stream, label, pending, secrets);
            pending = "";
        }
    });
}

function delay(milliseconds) {
    return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

export async function waitForHttp(url, {
    timeoutMs = 10_000,
    fetchImpl = globalThis.fetch,
    delayImpl = delay
} = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetchImpl(url, {
                signal: AbortSignal.timeout(Math.min(1000, timeoutMs))
            });
            if (response.ok) {
                return;
            }
        } catch {
            // Startup probes are retried until the bounded deadline.
        }
        await delayImpl(100);
    }
    throw new SandboxLaunchError(
        "A local component did not become ready in time.",
        "SANDBOX_STARTUP_TIMEOUT"
    );
}

export class SandboxProcessSupervisor {
    constructor({
        spawnImpl = spawn,
        output = process.stdout,
        secrets = [],
        shutdownTimeoutMs = 5000
    } = {}) {
        this.spawnImpl = spawnImpl;
        this.output = output;
        this.secrets = secrets;
        this.shutdownTimeoutMs = shutdownTimeoutMs;
        this.components = [];
        this.stopping = false;
        this.failure = new Promise((_, reject) => {
            this.rejectFailure = reject;
        });
        this.failure.catch(() => {});
    }

    start({ name, command, args, cwd, env, onLine = () => {}, detached = false }) {
        if (this.stopping) {
            throw new SandboxLaunchError("Sandbox shutdown has already started.");
        }
        let child;
        try {
            child = this.spawnImpl(command, args, {
                cwd,
                env,
                detached,
                stdio: ["ignore", "pipe", "pipe"]
            });
        } catch {
            throw new SandboxLaunchError(
                `${name} could not be started.`,
                "SANDBOX_COMPONENT_START_FAILED"
            );
        }
        const component = {
            name,
            child,
            detached,
            exited: new Promise(resolveExit => child.once("close", resolveExit))
        };
        this.components.push(component);
        attachLabeledOutput(child.stdout, {
            label: name,
            stream: this.output,
            secrets: this.secrets,
            onLine
        });
        attachLabeledOutput(child.stderr, {
            label: name,
            stream: this.output,
            secrets: this.secrets,
            onLine
        });
        child.once("error", () => this.componentFailed(component));
        child.once("exit", () => {
            if (!this.stopping) {
                this.componentFailed(component);
            }
        });
        return component;
    }

    componentFailed(component) {
        if (this.stopping) {
            return;
        }
        this.rejectFailure(new SandboxLaunchError(
            `${component.name} stopped unexpectedly.`,
            "SANDBOX_COMPONENT_STOPPED"
        ));
    }

    signal(component, signal) {
        const { child, detached } = component;
        if (child.exitCode !== null || child.signalCode !== null) {
            return;
        }
        try {
            if (detached && process.platform !== "win32" && child.pid) {
                process.kill(-child.pid, signal);
            } else {
                child.kill(signal);
            }
        } catch {
            // A process that exited between the state check and signal is already stopped.
        }
    }

    async stop() {
        if (this.stopping) {
            return;
        }
        this.stopping = true;
        this.components.forEach(component => this.signal(component, "SIGTERM"));
        const exited = Promise.allSettled(this.components.map(component => component.exited));
        let shutdownTimer;
        const timedOut = await Promise.race([
            exited.then(() => false),
            new Promise(resolveTimeout => {
                shutdownTimer = setTimeout(() => resolveTimeout(true), this.shutdownTimeoutMs);
            })
        ]);
        clearTimeout(shutdownTimer);
        if (timedOut) {
            this.components.forEach(component => this.signal(component, "SIGKILL"));
            let killTimer;
            await Promise.race([
                exited,
                new Promise(resolveTimeout => {
                    killTimer = setTimeout(resolveTimeout, 1000);
                })
            ]);
            clearTimeout(killTimer);
        }
    }
}

function minimalChildEnvironment(env) {
    return Object.fromEntries([
        "HOME",
        "LANG",
        "LC_ALL",
        "NO_COLOR",
        "PATH",
        "TERM",
        "TMPDIR",
        "XDG_CONFIG_HOME"
    ].filter(name => env[name] !== undefined).map(name => [name, env[name]]));
}

function raceStartup(promise, supervisor) {
    return Promise.race([promise, supervisor.failure]);
}

export async function launchSandboxComponents({
    preflight,
    env,
    supervisor,
    webhookSecret,
    httpWaiter = waitForHttp,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS
}) {
    const apiEnvironment = {
        ...env,
        PORT: String(API_PORT),
        SANDBOX_DEMO_BIND_HOST: API_HOST
    };
    supervisor.start({
        name: "api",
        command: process.execPath,
        args: ["src/server.js"],
        cwd: SERVER_DIRECTORY,
        env: apiEnvironment,
        detached: process.platform !== "win32"
    });
    await raceStartup(httpWaiter(
        `http://${API_HOST}:${API_PORT}/health`,
        { timeoutMs: 10_000 }
    ), supervisor);

    const websiteEnvironment = minimalChildEnvironment(env);
    supervisor.start({
        name: "website",
        command: process.execPath,
        args: ["scripts/sandbox-static-server.js"],
        cwd: SERVER_DIRECTORY,
        env: websiteEnvironment,
        detached: process.platform !== "win32"
    });
    await raceStartup(httpWaiter(
        `http://${WEBSITE_HOST}:${WEBSITE_PORT}/index.html`,
        { timeoutMs: 10_000 }
    ), supervisor);

    let resolveStripeReady;
    let rejectStripeReady;
    const stripeReady = new Promise((resolveReady, rejectReady) => {
        resolveStripeReady = resolveReady;
        rejectStripeReady = rejectReady;
    });
    const stripeEnvironment = minimalChildEnvironment(env);
    supervisor.start({
        name: "stripe",
        command: "stripe",
        args: [
            "listen",
            "--project-name",
            preflight.profileName,
            "--events",
            preflight.eventTypes.join(","),
            "--forward-to",
            `http://${API_HOST}:${API_PORT}${WEBHOOK_PATH}`
        ],
        cwd: REPOSITORY_DIRECTORY,
        env: stripeEnvironment,
        detached: process.platform !== "win32",
        onLine: line => {
            if (!/\bReady!/.test(line)) {
                return;
            }
            const reportedSecret = /\bwhsec_[A-Za-z0-9_-]+\b/.exec(line)?.[0] || null;
            if (!reportedSecret || reportedSecret !== webhookSecret) {
                rejectStripeReady(new SandboxLaunchError(
                    "The configured webhook secret does not match the named Stripe sandbox profile.",
                    "SANDBOX_WEBHOOK_SECRET_MISMATCH"
                ));
                return;
            }
            resolveStripeReady();
        }
    });
    let stripeStartupTimer;
    const stripeStartupTimeout = new Promise((_, reject) => {
        stripeStartupTimer = setTimeout(() => reject(new SandboxLaunchError(
            "Stripe event forwarding did not become ready in time.",
            "SANDBOX_STRIPE_STARTUP_TIMEOUT"
        )), startupTimeoutMs);
    });
    try {
        await raceStartup(Promise.race([
            stripeReady,
            stripeStartupTimeout
        ]), supervisor);
    } finally {
        clearTimeout(stripeStartupTimer);
    }
}

function safeErrorMessage(error, secrets) {
    const fallback = "The sandbox demo could not be started safely.";
    if (!(error instanceof SandboxPreflightError || error instanceof SandboxLaunchError)) {
        return fallback;
    }
    return redactSecrets(error.message, secrets);
}

export async function main({
    env = process.env,
    args = process.argv.slice(2),
    output = process.stdout,
    errorOutput = process.stderr,
    preflightRunner = runSandboxPreflight,
    launcher = launchSandboxComponents,
    supervisorFactory = options => new SandboxProcessSupervisor(options)
} = {}) {
    dotenv.config({ path: resolve(SERVER_DIRECTORY, ".env"), quiet: true });
    const secrets = [env.STRIPE_TEST_SECRET_KEY, env.STRIPE_TEST_WEBHOOK_SECRET]
        .filter(Boolean);
    let supervisor;
    let signalHandled = false;
    let resolveSignal;
    const signalled = new Promise(resolve => {
        resolveSignal = resolve;
    });
    const handleSignal = async signal => {
        if (signalHandled) {
            return;
        }
        signalHandled = true;
        writeLine(output, "sandbox", `Stopping after ${signal}...`, secrets);
        await supervisor?.stop();
        writeLine(output, "sandbox", "All sandbox components stopped.", secrets);
        resolveSignal();
    };

    try {
        const preflight = await preflightRunner({ env, args });
        writeLine(output, "sandbox", "Preflight passed. No secret values will be shown.", secrets);
        supervisor = supervisorFactory({ output, secrets });
        process.once("SIGINT", handleSignal);
        process.once("SIGTERM", handleSignal);
        await launcher({
            preflight,
            env,
            supervisor,
            webhookSecret: env.STRIPE_TEST_WEBHOOK_SECRET
        });
        writeLine(
            output,
            "sandbox",
            `Ready: website ${preflight.publicBaseUrl} • API http://${API_HOST}:${API_PORT}`,
            secrets
        );
        writeLine(output, "sandbox", "Press Control+C to stop every component.", secrets);
        await Promise.race([
            supervisor.failure.then(() => {}),
            signalled
        ]);
        if (!signalHandled) {
            await supervisor.failure;
        }
        return 0;
    } catch (error) {
        writeLine(errorOutput, "sandbox", safeErrorMessage(error, secrets), secrets);
        await supervisor?.stop();
        return 1;
    } finally {
        process.removeListener("SIGINT", handleSignal);
        process.removeListener("SIGTERM", handleSignal);
    }
}

const invokedPath = process.argv[1]
    ? pathToFileURL(resolve(process.argv[1])).href
    : null;
if (invokedPath === import.meta.url) {
    process.exitCode = await main();
}
