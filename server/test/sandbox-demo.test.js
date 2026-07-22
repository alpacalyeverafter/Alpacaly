import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
    SandboxLaunchError,
    SandboxProcessSupervisor,
    launchSandboxComponents,
    main,
    redactSecrets,
    runSandboxPreflight
} from "../scripts/sandbox-demo.js";
import { STRIPE_SANDBOX_EVENT_TYPES } from "../src/payments/sandbox-event-types.js";

const TEST_SECRET_KEY = "sk_test_launcher_fixture_only";
const TEST_WEBHOOK_SECRET = "whsec_launcher_fixture_only";
const TEST_PROFILE = "alpacaly-sandbox-demo";

function preflightEnvironment(overrides = {}) {
    return {
        NODE_ENV: "development",
        PORT: "3000",
        ENABLE_PAYMENT_SANDBOX: "true",
        PAYMENT_PUBLIC_BASE_URL: "http://localhost:8000",
        STRIPE_TEST_SECRET_KEY: TEST_SECRET_KEY,
        STRIPE_TEST_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
        STRIPE_CLI_PROJECT: TEST_PROFILE,
        ...overrides
    };
}

function preflightOptions(overrides = {}) {
    return {
        env: preflightEnvironment(),
        args: [],
        nodeVersion: "24.18.0",
        commandProbe: () => true,
        portProbe: async () => true,
        readStripeConfig: () => [
            `[${TEST_PROFILE}]`,
            "test_mode_api_key = 'rk_test_profile_fixture_only'"
        ].join("\n"),
        ...overrides
    };
}

class FakeChild extends EventEmitter {
    constructor(pid) {
        super();
        this.pid = pid;
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.exitCode = null;
        this.signalCode = null;
        this.signals = [];
    }

    kill(signal) {
        this.signals.push(signal);
        this.signalCode = signal;
        queueMicrotask(() => {
            this.emit("exit", null, signal);
            this.emit("close", null, signal);
            this.stdout.end();
            this.stderr.end();
        });
        return true;
    }
}

function collectingStream() {
    let output = "";
    return {
        stream: new Writable({
            write(chunk, _encoding, callback) {
                output += chunk.toString();
                callback();
            }
        }),
        text: () => output
    };
}

test("sandbox preflight passes without returning or printing secret material", async () => {
    const result = await runSandboxPreflight(preflightOptions());

    assert.equal(result.profileName, TEST_PROFILE);
    assert.equal(result.publicBaseUrl, "http://localhost:8000");
    assert.deepEqual(result.eventTypes, STRIPE_SANDBOX_EVENT_TYPES);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /sk_test_|whsec_|rk_test_/);
});

test("sandbox preflight is fail-closed for unsafe configuration", async t => {
    const cases = [
        [
            "extra arguments",
            { args: ["--live"] },
            "SANDBOX_EXTRA_ARGUMENTS_REJECTED"
        ],
        [
            "missing Node",
            { commandProbe: command => command !== process.execPath },
            "SANDBOX_NODE_UNAVAILABLE"
        ],
        [
            "missing Stripe CLI",
            { commandProbe: command => command !== "stripe" },
            "SANDBOX_STRIPE_CLI_UNAVAILABLE"
        ],
        [
            "disabled sandbox",
            { env: preflightEnvironment({ ENABLE_PAYMENT_SANDBOX: "false" }) },
            "SANDBOX_NOT_ENABLED"
        ],
        [
            "remote public URL",
            { env: preflightEnvironment({ PAYMENT_PUBLIC_BASE_URL: "https://example.com" }) },
            "SANDBOX_PUBLIC_URL_NOT_LOCAL"
        ],
        [
            "live key",
            { env: preflightEnvironment({ STRIPE_TEST_SECRET_KEY: "sk_live_not_allowed" }) },
            "SANDBOX_TEST_KEY_REQUIRED"
        ],
        [
            "missing webhook secret",
            { env: preflightEnvironment({ STRIPE_TEST_WEBHOOK_SECRET: "" }) },
            "SANDBOX_WEBHOOK_SECRET_REQUIRED"
        ],
        [
            "missing named profile",
            { readStripeConfig: () => "[default]\ntest_mode_api_key = 'rk_test_default'" },
            "SANDBOX_STRIPE_PROFILE_NOT_FOUND"
        ],
        [
            "non-test profile",
            { readStripeConfig: () => `[${TEST_PROFILE}]\ntest_mode_api_key = 'sk_live_no'` },
            "SANDBOX_STRIPE_PROFILE_NOT_TEST_ONLY"
        ]
    ];

    for (const [name, override, expectedCode] of cases) {
        await t.test(name, async () => {
            await assert.rejects(
                () => runSandboxPreflight(preflightOptions(override)),
                error => error.code === expectedCode
                    && !error.message.includes(TEST_SECRET_KEY)
                    && !error.message.includes(TEST_WEBHOOK_SECRET)
            );
        });
    }
});

test("sandbox preflight reports conflicts on both fixed ports", async t => {
    for (const [port, expectedCode] of [
        [3000, "SANDBOX_API_PORT_IN_USE"],
        [8000, "SANDBOX_WEBSITE_PORT_IN_USE"]
    ]) {
        await t.test(String(port), async () => {
            await assert.rejects(
                () => runSandboxPreflight(preflightOptions({
                    portProbe: async candidate => candidate !== port
                })),
                error => error.code === expectedCode
            );
        });
    }
});

test("launcher redaction removes configured and secret-shaped values", () => {
    const output = redactSecrets(
        `key=${TEST_SECRET_KEY} webhook=${TEST_WEBHOOK_SECRET} `
        + "authorization:Bearer-token rk_live_accidental pk_test_accidental",
        [TEST_SECRET_KEY, TEST_WEBHOOK_SECRET]
    );

    assert.doesNotMatch(output, /launcher_fixture|rk_live_|pk_test_|Bearer-token/);
    assert.match(output, /<redacted>/);
});

test("launcher uses only the named test profile and Phase 8A event allow-list", async () => {
    const starts = [];
    const supervisor = {
        failure: new Promise(() => {}),
        start(component) {
            starts.push(component);
            if (component.name === "stripe") {
                queueMicrotask(() => component.onLine(
                    `Ready! Your webhook signing secret is ${TEST_WEBHOOK_SECRET}`
                ));
            }
        }
    };
    const env = preflightEnvironment({ PATH: "/usr/bin", HOME: "/tmp/test-home" });
    const preflight = await runSandboxPreflight(preflightOptions());

    await launchSandboxComponents({
        preflight,
        env,
        supervisor,
        webhookSecret: TEST_WEBHOOK_SECRET,
        httpWaiter: async () => {},
        startupTimeoutMs: 100
    });

    const stripe = starts.find(component => component.name === "stripe");
    assert.deepEqual(stripe.args, [
        "listen",
        "--project-name",
        TEST_PROFILE,
        "--events",
        STRIPE_SANDBOX_EVENT_TYPES.join(","),
        "--forward-to",
        "http://127.0.0.1:3000/api/payments/webhooks/stripe"
    ]);
    assert.doesNotMatch(stripe.args.join(" "), /--live|api-key|sk_test_|whsec_/);
    assert.equal(stripe.env.STRIPE_TEST_SECRET_KEY, undefined);
    assert.equal(starts.find(component => component.name === "website")
        .env.STRIPE_TEST_WEBHOOK_SECRET, undefined);
});

test("startup failure stops components that already started", async () => {
    const child = new FakeChild(101);
    let spawnCount = 0;
    const supervisor = new SandboxProcessSupervisor({
        spawnImpl: () => {
            spawnCount += 1;
            if (spawnCount > 1) {
                throw new Error("fixture startup failure");
            }
            return child;
        },
        output: collectingStream().stream,
        shutdownTimeoutMs: 50
    });
    supervisor.start({
        name: "api",
        command: "node",
        args: [],
        cwd: "/tmp",
        env: {},
        detached: false
    });
    assert.throws(
        () => supervisor.start({
            name: "website",
            command: "node",
            args: [],
            cwd: "/tmp",
            env: {},
            detached: false
        }),
        error => error instanceof SandboxLaunchError
    );

    await supervisor.stop();
    assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("clean shutdown signals every managed child", async () => {
    const children = [new FakeChild(201), new FakeChild(202), new FakeChild(203)];
    const supervisor = new SandboxProcessSupervisor({
        spawnImpl: () => children.shift(),
        output: collectingStream().stream,
        shutdownTimeoutMs: 50
    });
    const started = ["api", "website", "stripe"].map(name => supervisor.start({
        name,
        command: name,
        args: [],
        cwd: "/tmp",
        env: {},
        detached: false
    }).child);

    await supervisor.stop();
    started.forEach(child => assert.deepEqual(child.signals, ["SIGTERM"]));
});

test("top-level startup failure is redacted and returns a failure status", async () => {
    const stdout = collectingStream();
    const stderr = collectingStream();
    let stopped = false;
    const status = await main({
        env: preflightEnvironment(),
        args: [],
        output: stdout.stream,
        errorOutput: stderr.stream,
        preflightRunner: async () => ({
            profileName: TEST_PROFILE,
            publicBaseUrl: "http://localhost:8000",
            eventTypes: STRIPE_SANDBOX_EVENT_TYPES
        }),
        supervisorFactory: () => ({
            failure: new Promise(() => {}),
            async stop() {
                stopped = true;
            }
        }),
        launcher: async () => {
            throw new SandboxLaunchError(
                `Fixture failure ${TEST_SECRET_KEY} ${TEST_WEBHOOK_SECRET}`
            );
        }
    });

    assert.equal(status, 1);
    assert.equal(stopped, true);
    assert.doesNotMatch(`${stdout.text()}${stderr.text()}`, /launcher_fixture/);
    assert.match(stderr.text(), /<redacted>/);
});
