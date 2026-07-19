import pino from "pino";

export const testConfig = Object.freeze({
    serviceName: "alpacaly-server",
    nodeEnv: "test",
    port: 3000,
    logLevel: "silent",
    maxDailyFeeds: 100,
    enforceFeedingWindow: false,
    feedingWindowStart: "08:00",
    feedingWindowEnd: "18:00",
    requestBodyLimit: "16kb"
});

export function createTestLogger() {
    return pino({ enabled: false });
}
