// ==========================================
// Alpacaly Ever After
// Configuration
// ==========================================

const CONFIG = {

    paymentSimulationMode: true,

    DEMO_MAX_FEEDS: 100,

    apiBaseUrl: "http://localhost:3000",

    apiRequestTimeoutMs: 5000,

    apiPollIntervalMs: 5000,

    defaultBarnId: "barn_00000000-0000-4000-8000-000000000001",

    defaultFeederId: "feeder_00000000-0000-4000-8000-000000000002",

    developmentAdministratorIdentity: "local-admin",

    developmentSupporterIdentity: "local-supporter"

};

if (typeof window !== "undefined") {
    window.CONFIG = CONFIG;
}
