import { migration001InitialSchema } from "./001-initial-schema.js";
import {
    migration002ResourceModel,
    seedDefaultResources
} from "./002-resource-model.js";
import { migration003ContributionLedger } from "./003-contribution-ledger.js";
import { migration004DurableFeedIntentOutbox } from "./004-durable-feed-intent-outbox.js";
import { migration005DurableDeviceCommands } from "./005-durable-device-commands.js";
import {
    migration006AdministratorSecurityFoundation
} from "./006-administrator-security-foundation.js";
import { migration007OperatorSafety } from "./007-operator-safety.js";
import {
    migration008SimulatedDeviceControllers
} from "./008-simulated-device-controllers.js";
import {
    migration009SecureMqttTransport
} from "./009-secure-mqtt-transport.js";

export const EVENT_STORE_SCHEMA_VERSION = 9;

export const EVENT_STORE_MIGRATIONS = Object.freeze([
    migration001InitialSchema,
    migration002ResourceModel,
    migration003ContributionLedger,
    migration004DurableFeedIntentOutbox,
    migration005DurableDeviceCommands,
    migration006AdministratorSecurityFoundation,
    migration007OperatorSafety,
    migration008SimulatedDeviceControllers,
    migration009SecureMqttTransport
]);

function readUserVersion(database) {
    return Number(database.prepare("PRAGMA user_version;").get().user_version) || 0;
}

export function runEventStoreMigrations(database, logger) {
    const startingVersion = readUserVersion(database);
    if (startingVersion > EVENT_STORE_SCHEMA_VERSION) {
        throw new Error(
            `Event Store schema version ${startingVersion} is newer than supported version ${EVENT_STORE_SCHEMA_VERSION}.`
        );
    }

    EVENT_STORE_MIGRATIONS
        .filter(migration => migration.version > startingVersion)
        .forEach(migration => {
            if (migration.requiresForeignKeysDisabled) {
                database.exec("PRAGMA foreign_keys = OFF;");
            }
            database.exec("BEGIN IMMEDIATE;");
            try {
                migration.up(database);
                const violations = database.prepare("PRAGMA foreign_key_check;").all();
                if (violations.length > 0) {
                    throw new Error(
                        `Migration ${migration.version} introduced foreign-key violations.`
                    );
                }
                database.exec(`PRAGMA user_version = ${migration.version};`);
                database.exec("COMMIT;");
            } catch (error) {
                database.exec("ROLLBACK;");
                throw error;
            } finally {
                if (migration.requiresForeignKeysDisabled) {
                    database.exec("PRAGMA foreign_keys = ON;");
                }
            }

            logger.info({
                event: "event_store_migrated",
                schemaVersion: migration.version,
                migration: migration.name
            }, "SQLite Event Store migration applied");
        });

    seedDefaultResources(database);
    return readUserVersion(database);
}
