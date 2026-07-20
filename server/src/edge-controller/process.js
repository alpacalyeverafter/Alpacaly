import { DEFAULT_EDGE_WELFARE_CONFIGURATION, loadEdgeConfig } from "./config.js";
import { SecureMqttEdgeProcess } from "./secure-mqtt-edge-process.js";
import { SqliteEdgeStore } from "./sqlite-edge-store.js";

const config = loadEdgeConfig();
let store = null;
if (config.bootstrapSimulatedFixtures) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    store = new SqliteEdgeStore({
        databasePath: config.databasePath,
        controllerId: config.controllerId
    });
    store.installWelfareConfiguration(DEFAULT_EDGE_WELFARE_CONFIGURATION, {
        createdAt: now.toISOString(),
        expiresAt
    });
    for (const feederId of config.feederIds) {
        store.installCalibration({
            calibrationId: `explicit_simulator_fixture_${feederId}`,
            feederId,
            version: "simulated-calibration-v1",
            feedType: "EXPLICIT_SIMULATOR_FIXTURE",
            testCount: 3,
            commandedDurationMs: 100,
            measuredOutputValues: [1, 1, 1],
            average: 1,
            variance: 0,
            tolerance: 0.25,
            hopperFillConditions: "SIMULATED_FULL",
            createdAt: now.toISOString(),
            expiresAt,
            approved: true,
            approvingOperatorIdentity: "explicit-development-bootstrap",
            notes: "Simulation only; this is not a physical feeder calibration.",
            simulated: true
        });
    }
}
const processRuntime = new SecureMqttEdgeProcess({ config, ...(store ? { store } : {}) });

async function shutdown(signal) {
    try {
        await processRuntime.shutdown({ closeStore: true });
        process.stdout.write(`${signal}: edge outputs are OFF and the journal is closed.\n`);
        process.exitCode = 0;
    } catch (error) {
        process.stderr.write(`Edge shutdown failed: ${String(error.message || error)}\n`);
        process.exitCode = 1;
    }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
processRuntime.start();
