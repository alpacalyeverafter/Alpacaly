export const DEFAULTS = Object.freeze({
    serviceName: "alpacaly-server",
    nodeEnv: "development",
    port: 3000,
    logLevel: "info",
    maxDailyFeeds: 100,
    enforceFeedingWindow: false,
    feedingWindowStart: "08:00",
    feedingWindowEnd: "18:00",
    requestBodyLimit: "16kb",
    corsOrigin: "*",
    databasePath: "./data/alpacaly.sqlite",
    outboxPollIntervalMs: 250,
    outboxRetryDelayMs: 1000,
    lifecycleCountdownMs: 10000,
    lifecycleBellMs: 3000,
    lifecycleDispensingMs: 2000,
    lifecycleArchiveDelayMs: 2000
});
