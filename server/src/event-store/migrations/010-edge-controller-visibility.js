export const migration010EdgeControllerVisibility = Object.freeze({
    version: 10,
    name: "edge_controller_visibility",
    up(database) {
        database.exec(`
            CREATE TABLE EdgeControllerStatus (
                controllerId TEXT PRIMARY KEY,
                controllerBootId TEXT NOT NULL,
                bootCounter INTEGER NOT NULL CHECK (bootCounter > 0),
                statusVersion TEXT NOT NULL,
                statusJson TEXT NOT NULL,
                receivedAt TEXT NOT NULL,
                FOREIGN KEY (controllerId)
                    REFERENCES SimulatedControllers(controllerId) ON DELETE RESTRICT
            ) STRICT, WITHOUT ROWID;

            CREATE TABLE EdgeControllerStatusHistory (
                statusSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                controllerId TEXT NOT NULL,
                controllerBootId TEXT NOT NULL,
                bootCounter INTEGER NOT NULL CHECK (bootCounter > 0),
                statusVersion TEXT NOT NULL,
                receivedAt TEXT NOT NULL,
                summaryJson TEXT NOT NULL,
                FOREIGN KEY (controllerId)
                    REFERENCES SimulatedControllers(controllerId) ON DELETE RESTRICT
            ) STRICT;

            CREATE INDEX edge_controller_status_history_recent
                ON EdgeControllerStatusHistory(controllerId, statusSequence DESC);

            CREATE TRIGGER edge_controller_status_history_append_only_update
            BEFORE UPDATE ON EdgeControllerStatusHistory
            BEGIN SELECT RAISE(ABORT, 'Edge controller status history is append-only'); END;
            CREATE TRIGGER edge_controller_status_history_append_only_delete
            BEFORE DELETE ON EdgeControllerStatusHistory
            BEGIN SELECT RAISE(ABORT, 'Edge controller status history is append-only'); END;
        `);
    }
});
