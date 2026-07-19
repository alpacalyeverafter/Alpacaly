// ==========================================
// Alpacaly Ever After
// Configuration
// ==========================================

const CONFIG = {

    paymentSimulationMode: true,

    DEMO_MAX_FEEDS: 100,

    apiBaseUrl: "http://localhost:3000",

    apiRequestTimeoutMs: 5000,

    apiPollIntervalMs: 5000

};

if (typeof window !== "undefined") {
    window.CONFIG = CONFIG;
}
