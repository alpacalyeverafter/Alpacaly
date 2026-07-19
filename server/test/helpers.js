import pino from "pino";

import { createContributionLedgerServices } from "../src/contribution-ledger/index.js";

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
    databasePath: ":memory:",
    enableDemoReset: true,
    enableDevelopmentContributionSimulation: true,
    outboxPollIntervalMs: 250,
    outboxRetryDelayMs: 0,
    lifecycleCountdownMs: 0,
    lifecycleBellMs: 0,
    lifecycleDispensingMs: 0,
    lifecycleArchiveDelayMs: 0
});

export function createTestLogger() {
    return pino({ enabled: false });
}

const ledgerServicesByEngine = new WeakMap();

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
    return getTestContributionLedgerServices(eventEngine)
        .developmentWebsiteContributionService
        .simulate(payload, { feederId });
}
