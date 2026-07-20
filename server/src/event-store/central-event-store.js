import { PostgresEventStore } from "./postgres-event-store.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

export function createCentralEventStore({ config, logger }) {
    if (config.centralDatabaseType === "postgres") {
        return new PostgresEventStore({ config, logger });
    }
    return new SqliteEventStore({
        databasePath: config.databasePath || ":memory:",
        logger
    });
}
