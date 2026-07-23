import pino from "pino";

import { createContributionLedgerServices } from "../src/contribution-ledger/index.js";
import { createDeviceCommandServices } from "../src/device-commands/index.js";

export const testConfig = Object.freeze({
    serviceName: "alpacaly-server",
    nodeEnv: "test",
    port: 3000,
    logLevel: "silent",
    maxDailyFeeds: 100,
    enforceFeedingWindow: false,
    feedingWindowStart: "08:00",
    feedingWindowEnd: "18:00",
    requestBodyLimit: "16kb",
    corsOrigin: "*",
    paymentSandboxEnabled: true,
    paymentDonationAmountMinor: 500,
    paymentDonationCurrency: "GBP",
    paymentPublicBaseUrl: "http://localhost:8000",
    paymentProviderTimeoutMs: 1000,
    paymentWebhookToleranceSeconds: 300,
    paymentWebhookBodyLimit: "256kb",
    feedCreditReservationLifetimeMs: 30 * 60 * 1000,
    feedCreditConfirmationTimeoutMs: 60 * 1000,
    feedCreditPresenceTtlMs: 15 * 1000,
    feedCreditReconciliationIntervalMs: 1000,
    stripeTestSecretKey: "sk_test_alpacaly_fixture",
    stripeTestWebhookSecret: "whsec_alpacaly_fixture",
    databasePath: ":memory:",
    enableDemoReset: true,
    enableDevelopmentContributionSimulation: true,
    enableDevelopmentAuthentication: true,
    managedIdentityProviderConfigured: false,
    supporterAuthProvider: "development",
    enableDevelopmentSupporterAuthentication: true,
    supporterAuthBaseUrl: "http://localhost:3000",
    supporterPublicReturnUrl: "http://localhost:8000/index.html",
    supporterCsrfSecret: "test-supporter-csrf-secret-with-32-characters",
    supporterSessionRollingSeconds: 3600,
    supporterSessionAbsoluteSeconds: 604800,
    supporterRecentAuthenticationSeconds: 600,
    auth0IssuerBaseUrl: null,
    auth0ClientId: null,
    auth0ClientSecret: null,
    auth0SessionSecret: null,
    criticalApprovalLifetimeMs: 15 * 60 * 1000,
    outboxPollIntervalMs: 250,
    outboxRetryDelayMs: 0,
    deviceCommandPollIntervalMs: 10,
    deviceCommandRetryDelayMs: 0,
    deviceCommandMaximumAttempts: 3,
    deviceAcknowledgementTimeoutMs: 1000,
    simulatedControllerHeartbeatIntervalMs: 1000,
    simulatedControllerHeartbeatTimeoutMs: 3000,
    enableSimulatedControllerConfiguration: true,
    lifecycleCountdownMs: 0,
    lifecycleBellMs: 0,
    lifecycleDispensingMs: 0,
    lifecycleArchiveDelayMs: 0
});

export function createTestLogger() {
    return pino({ enabled: false });
}

const ledgerServicesByEngine = new WeakMap();
const deviceServicesByEngine = new WeakMap();

export function getTestDeviceCommandServices(eventEngine) {
    if (!deviceServicesByEngine.has(eventEngine)) {
        deviceServicesByEngine.set(eventEngine, createDeviceCommandServices({
            eventEngine,
            config: eventEngine.config,
            logger: createTestLogger(),
            clock: eventEngine.clock,
            adapterSleep: async () => {},
            workerSleep: async () => {},
            startWorker: false
        }));
    }
    return deviceServicesByEngine.get(eventEngine);
}

export function getTestContributionLedgerServices(eventEngine) {
    if (!ledgerServicesByEngine.has(eventEngine)) {
        ledgerServicesByEngine.set(eventEngine, createContributionLedgerServices({
            eventEngine,
            logger: createTestLogger(),
            clock: eventEngine.clock
        }));
    }
    return ledgerServicesByEngine.get(eventEngine);
}

export function submitTestFeedRequest(eventEngine, payload, {
    feederId = eventEngine.getDefaultFeederId()
} = {}) {
    getTestDeviceCommandServices(eventEngine);
    return getTestContributionLedgerServices(eventEngine)
        .developmentWebsiteContributionService
        .simulate(payload, { feederId });
}
