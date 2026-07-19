const administratorStatuses = ["ACTIVE", "SUSPENDED", "REVOKED"]
    .map(value => `'${value}'`).join(", ");
const roles = ["VIEWER", "WELFARE_OPERATOR", "HARDWARE_OPERATOR", "ADMINISTRATOR"]
    .map(value => `'${value}'`).join(", ");
const feederStatuses = ["AVAILABLE", "PAUSED", "WELFARE_UNAVAILABLE", "MAINTENANCE"]
    .map(value => `'${value}'`).join(", ");
const deviceStatuses = ["AVAILABLE", "PAUSED", "MAINTENANCE"]
    .map(value => `'${value}'`).join(", ");

export const migration006AdministratorSecurityFoundation = Object.freeze({
    version: 6,
    name: "administrator_security_foundation",
    up(database) {
        database.exec(`
            CREATE TABLE Administrators (
                administratorId TEXT PRIMARY KEY,
                externalIdentityId TEXT NOT NULL UNIQUE,
                displayName TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL CHECK (status IN (${administratorStatuses})),
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL,
                lastAuthenticatedAt TEXT
            ) STRICT;

            CREATE TABLE RoleAssignments (
                roleAssignmentId TEXT PRIMARY KEY,
                administratorId TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN (${roles})),
                platformWide INTEGER NOT NULL DEFAULT 0 CHECK (platformWide IN (0, 1)),
                assignedAt TEXT NOT NULL,
                revokedAt TEXT,
                FOREIGN KEY (administratorId)
                    REFERENCES Administrators(administratorId) ON DELETE RESTRICT
            ) STRICT;

            CREATE UNIQUE INDEX idx_active_role_assignments
                ON RoleAssignments(administratorId, role, platformWide)
                WHERE revokedAt IS NULL;

            CREATE TABLE BarnScopes (
                barnScopeId TEXT PRIMARY KEY,
                roleAssignmentId TEXT NOT NULL,
                administratorId TEXT NOT NULL,
                barnId TEXT NOT NULL,
                assignedAt TEXT NOT NULL,
                revokedAt TEXT,
                FOREIGN KEY (roleAssignmentId)
                    REFERENCES RoleAssignments(roleAssignmentId) ON DELETE RESTRICT,
                FOREIGN KEY (administratorId)
                    REFERENCES Administrators(administratorId) ON DELETE RESTRICT,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT
            ) STRICT;

            CREATE UNIQUE INDEX idx_active_barn_scopes
                ON BarnScopes(roleAssignmentId, barnId)
                WHERE revokedAt IS NULL;

            CREATE TABLE OperatorAuditRecords (
                auditSequence INTEGER PRIMARY KEY AUTOINCREMENT,
                auditRecordId TEXT NOT NULL UNIQUE,
                administratorId TEXT,
                effectiveRole TEXT CHECK (
                    effectiveRole IS NULL OR effectiveRole IN (${roles})
                ),
                barnId TEXT,
                feederId TEXT,
                deviceId TEXT,
                action TEXT NOT NULL,
                targetType TEXT NOT NULL,
                targetId TEXT,
                reason TEXT,
                requestId TEXT,
                authenticationStrength TEXT,
                timestamp TEXT NOT NULL,
                result TEXT NOT NULL CHECK (result IN ('SUCCEEDED', 'REJECTED', 'FAILED')),
                beforeSummaryJson TEXT NOT NULL DEFAULT 'null',
                afterSummaryJson TEXT NOT NULL DEFAULT 'null',
                metadataJson TEXT NOT NULL DEFAULT 'null',
                FOREIGN KEY (administratorId)
                    REFERENCES Administrators(administratorId) ON DELETE RESTRICT
            ) STRICT;

            CREATE TABLE WelfareNotes (
                welfareNoteId TEXT PRIMARY KEY,
                administratorId TEXT NOT NULL,
                barnId TEXT NOT NULL,
                feederId TEXT,
                note TEXT NOT NULL,
                createdAt TEXT NOT NULL,
                FOREIGN KEY (administratorId)
                    REFERENCES Administrators(administratorId) ON DELETE RESTRICT,
                FOREIGN KEY (barnId) REFERENCES Barns(barnId) ON DELETE RESTRICT,
                FOREIGN KEY (feederId) REFERENCES Feeders(feederId) ON DELETE RESTRICT
            ) STRICT;

            ALTER TABLE Feeders
                ADD COLUMN operationalStatus TEXT NOT NULL DEFAULT 'AVAILABLE'
                CHECK (operationalStatus IN (${feederStatuses}));
            ALTER TABLE Feeders ADD COLUMN operationalReason TEXT;
            ALTER TABLE Feeders ADD COLUMN operationalUpdatedAt TEXT;

            ALTER TABLE Devices
                ADD COLUMN operationalStatus TEXT NOT NULL DEFAULT 'AVAILABLE'
                CHECK (operationalStatus IN (${deviceStatuses}));
            ALTER TABLE Devices ADD COLUMN operationalReason TEXT;
            ALTER TABLE Devices ADD COLUMN operationalUpdatedAt TEXT;

            CREATE INDEX idx_role_assignments_administrator
                ON RoleAssignments(administratorId, revokedAt, role);
            CREATE INDEX idx_barn_scopes_administrator
                ON BarnScopes(administratorId, barnId, revokedAt);
            CREATE INDEX idx_operator_audit_barn
                ON OperatorAuditRecords(barnId, auditSequence);
            CREATE INDEX idx_operator_audit_administrator
                ON OperatorAuditRecords(administratorId, auditSequence);
            CREATE INDEX idx_operator_audit_request
                ON OperatorAuditRecords(requestId, auditSequence);
            CREATE INDEX idx_welfare_notes_barn
                ON WelfareNotes(barnId, feederId, createdAt);

            CREATE TRIGGER administrator_identity_immutable
            BEFORE UPDATE OF administratorId, externalIdentityId, createdAt ON Administrators
            BEGIN
                SELECT RAISE(ABORT, 'Administrator identity fields are immutable');
            END;

            CREATE TRIGGER role_assignment_identity_immutable
            BEFORE UPDATE OF roleAssignmentId, administratorId, role, platformWide,
                             assignedAt ON RoleAssignments
            BEGIN
                SELECT RAISE(ABORT, 'RoleAssignment identity fields are immutable');
            END;

            CREATE TRIGGER barn_scope_identity_immutable
            BEFORE UPDATE OF barnScopeId, roleAssignmentId, administratorId,
                             barnId, assignedAt ON BarnScopes
            BEGIN
                SELECT RAISE(ABORT, 'BarnScope identity fields are immutable');
            END;

            CREATE TRIGGER barn_scope_validate_assignment_insert
            BEFORE INSERT ON BarnScopes
            WHEN NOT EXISTS (
                SELECT 1
                FROM RoleAssignments
                WHERE roleAssignmentId = NEW.roleAssignmentId
                  AND administratorId = NEW.administratorId
                  AND platformWide = 0
                  AND revokedAt IS NULL
            )
            BEGIN
                SELECT RAISE(ABORT, 'BarnScope requires an active barn-scoped RoleAssignment');
            END;

            CREATE TRIGGER operator_audit_records_append_only_update
            BEFORE UPDATE ON OperatorAuditRecords
            BEGIN
                SELECT RAISE(ABORT, 'OperatorAuditRecords are append-only');
            END;

            CREATE TRIGGER operator_audit_records_append_only_delete
            BEFORE DELETE ON OperatorAuditRecords
            BEGIN
                SELECT RAISE(ABORT, 'OperatorAuditRecords are append-only');
            END;

            CREATE TRIGGER welfare_notes_append_only_update
            BEFORE UPDATE ON WelfareNotes
            BEGIN
                SELECT RAISE(ABORT, 'WelfareNotes are append-only');
            END;

            CREATE TRIGGER welfare_notes_append_only_delete
            BEFORE DELETE ON WelfareNotes
            BEGIN
                SELECT RAISE(ABORT, 'WelfareNotes are append-only');
            END;
        `);
    }
});
