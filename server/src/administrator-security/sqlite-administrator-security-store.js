function parseJson(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    return JSON.parse(value);
}

function serializeJson(value) {
    return JSON.stringify(value ?? null);
}

function mapAdministrator(row) {
    return row ? {
        administratorId: row.administratorId,
        externalIdentityId: row.externalIdentityId,
        displayName: row.displayName,
        email: row.email,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastAuthenticatedAt: row.lastAuthenticatedAt
    } : null;
}

function mapRoleAssignment(row) {
    return row ? {
        roleAssignmentId: row.roleAssignmentId,
        administratorId: row.administratorId,
        role: row.role,
        platformWide: row.platformWide === 1,
        assignedAt: row.assignedAt,
        revokedAt: row.revokedAt
    } : null;
}

function mapBarnScope(row) {
    return row ? {
        barnScopeId: row.barnScopeId,
        roleAssignmentId: row.roleAssignmentId,
        administratorId: row.administratorId,
        barnId: row.barnId,
        assignedAt: row.assignedAt,
        revokedAt: row.revokedAt
    } : null;
}

function mapAuditRecord(row) {
    return row ? {
        auditSequence: row.auditSequence,
        auditRecordId: row.auditRecordId,
        administratorId: row.administratorId,
        effectiveRole: row.effectiveRole,
        barnId: row.barnId,
        feederId: row.feederId,
        deviceId: row.deviceId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        reason: row.reason,
        requestId: row.requestId,
        approvalId: row.approvalId,
        authenticationStrength: row.authenticationStrength,
        timestamp: row.timestamp,
        result: row.result,
        beforeSummary: parseJson(row.beforeSummaryJson),
        afterSummary: parseJson(row.afterSummaryJson),
        metadata: parseJson(row.metadataJson)
    } : null;
}

export class SqliteAdministratorSecurityStore {
    constructor({ eventStore }) {
        this.eventStore = eventStore;
        this.database = eventStore.database;
        this.prepareStatements();
    }

    prepareStatements() {
        this.statements = {
            insertAdministrator: this.database.prepare(`
                INSERT INTO Administrators (
                    administratorId, externalIdentityId, displayName, email,
                    status, createdAt, updatedAt, lastAuthenticatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `),
            selectAdministratorById: this.database.prepare(`
                SELECT * FROM Administrators WHERE administratorId = ?
            `),
            selectAdministratorByExternalIdentity: this.database.prepare(`
                SELECT * FROM Administrators WHERE externalIdentityId = ?
            `),
            selectAdministrators: this.database.prepare(`
                SELECT * FROM Administrators ORDER BY createdAt, administratorId
            `),
            updateAdministratorStatus: this.database.prepare(`
                UPDATE Administrators
                SET status = ?, updatedAt = ?
                WHERE administratorId = ? AND status <> ?
            `),
            updateLastAuthenticatedAt: this.database.prepare(`
                UPDATE Administrators
                SET lastAuthenticatedAt = ?, updatedAt = ?
                WHERE administratorId = ? AND status = 'ACTIVE'
            `),
            insertRoleAssignment: this.database.prepare(`
                INSERT INTO RoleAssignments (
                    roleAssignmentId, administratorId, role, platformWide,
                    assignedAt, revokedAt
                ) VALUES (?, ?, ?, ?, ?, ?)
            `),
            selectRoleAssignmentById: this.database.prepare(`
                SELECT * FROM RoleAssignments WHERE roleAssignmentId = ?
            `),
            selectRoleAssignments: this.database.prepare(`
                SELECT *
                FROM RoleAssignments
                WHERE administratorId = ?
                ORDER BY assignedAt, roleAssignmentId
            `),
            revokeRoleAssignment: this.database.prepare(`
                UPDATE RoleAssignments
                SET revokedAt = ?
                WHERE roleAssignmentId = ? AND revokedAt IS NULL
            `),
            revokeScopesForRoleAssignment: this.database.prepare(`
                UPDATE BarnScopes
                SET revokedAt = ?
                WHERE roleAssignmentId = ? AND revokedAt IS NULL
            `),
            insertBarnScope: this.database.prepare(`
                INSERT INTO BarnScopes (
                    barnScopeId, roleAssignmentId, administratorId,
                    barnId, assignedAt, revokedAt
                ) VALUES (?, ?, ?, ?, ?, ?)
            `),
            selectBarnScopeById: this.database.prepare(`
                SELECT * FROM BarnScopes WHERE barnScopeId = ?
            `),
            selectBarnScopes: this.database.prepare(`
                SELECT *
                FROM BarnScopes
                WHERE administratorId = ?
                ORDER BY assignedAt, barnScopeId
            `),
            revokeBarnScope: this.database.prepare(`
                UPDATE BarnScopes
                SET revokedAt = ?
                WHERE barnScopeId = ? AND revokedAt IS NULL
            `),
            selectActiveRoleAssignments: this.database.prepare(`
                SELECT *
                FROM RoleAssignments
                WHERE administratorId = ? AND revokedAt IS NULL
                ORDER BY assignedAt, roleAssignmentId
            `),
            selectActiveBarnScopes: this.database.prepare(`
                SELECT *
                FROM BarnScopes
                WHERE administratorId = ? AND revokedAt IS NULL
                ORDER BY assignedAt, barnScopeId
            `),
            insertAuditRecord: this.database.prepare(`
                INSERT INTO OperatorAuditRecords (
                    auditRecordId, administratorId, effectiveRole, barnId,
                    feederId, deviceId, action, targetType, targetId, reason,
                    requestId, authenticationStrength, timestamp, result,
                    beforeSummaryJson, afterSummaryJson, metadataJson, approvalId
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            selectAuditRecords: this.database.prepare(`
                SELECT *
                FROM OperatorAuditRecords
                WHERE (? IS NULL OR barnId = ?)
                  AND (? IS NULL OR administratorId = ?)
                ORDER BY auditSequence DESC
                LIMIT ?
            `),
            selectFeeder: this.database.prepare(`
                SELECT feederId, barnId, name, createdAt, operationalStatus,
                       operationalReason, operationalUpdatedAt
                FROM Feeders WHERE feederId = ?
            `),
            updateFeederStatus: this.database.prepare(`
                UPDATE Feeders
                SET operationalStatus = ?, operationalReason = ?,
                    operationalUpdatedAt = ?
                WHERE feederId = ? AND barnId = ?
            `),
            selectDevice: this.database.prepare(`
                SELECT deviceId, barnId, name, kind, createdAt, operationalStatus,
                       operationalReason, operationalUpdatedAt
                FROM Devices WHERE deviceId = ?
            `),
            updateDeviceStatus: this.database.prepare(`
                UPDATE Devices
                SET operationalStatus = ?, operationalReason = ?,
                    operationalUpdatedAt = ?
                WHERE deviceId = ? AND barnId = ?
            `),
            insertWelfareNote: this.database.prepare(`
                INSERT INTO WelfareNotes (
                    welfareNoteId, administratorId, barnId, feederId, note, createdAt
                ) VALUES (?, ?, ?, ?, ?, ?)
            `),
            selectWelfareNotes: this.database.prepare(`
                SELECT welfareNoteId, administratorId, barnId, feederId, note, createdAt
                FROM WelfareNotes
                WHERE barnId = ? AND (? IS NULL OR feederId = ?)
                ORDER BY createdAt DESC, welfareNoteId DESC
            `),
            selectBarn: this.database.prepare(`
                SELECT barnId, name, timezone, createdAt FROM Barns WHERE barnId = ?
            `),
            selectFeederForBarn: this.database.prepare(`
                SELECT feederId, barnId, name, createdAt, operationalStatus,
                       operationalReason, operationalUpdatedAt
                FROM Feeders WHERE feederId = ? AND barnId = ?
            `),
            selectDeviceForBarn: this.database.prepare(`
                SELECT deviceId, barnId, name, kind, createdAt, operationalStatus,
                       operationalReason, operationalUpdatedAt
                FROM Devices WHERE deviceId = ? AND barnId = ?
            `)
        };
    }

    getAdministrator(administratorId) {
        this.eventStore.assertOpen();
        return mapAdministrator(
            this.statements.selectAdministratorById.get(administratorId)
        );
    }

    getAdministratorByExternalIdentity(externalIdentityId) {
        this.eventStore.assertOpen();
        return mapAdministrator(
            this.statements.selectAdministratorByExternalIdentity.get(
                externalIdentityId
            )
        );
    }

    getAdministrators() {
        this.eventStore.assertOpen();
        return this.statements.selectAdministrators.all().map(mapAdministrator);
    }

    getRoleAssignment(roleAssignmentId) {
        this.eventStore.assertOpen();
        return mapRoleAssignment(
            this.statements.selectRoleAssignmentById.get(roleAssignmentId)
        );
    }

    getRoleAssignments(administratorId) {
        this.eventStore.assertOpen();
        return this.statements.selectRoleAssignments.all(administratorId)
            .map(mapRoleAssignment);
    }

    getBarnScope(barnScopeId) {
        this.eventStore.assertOpen();
        return mapBarnScope(this.statements.selectBarnScopeById.get(barnScopeId));
    }

    getBarnScopes(administratorId) {
        this.eventStore.assertOpen();
        return this.statements.selectBarnScopes.all(administratorId).map(mapBarnScope);
    }

    getIdentityAssignments(administratorId) {
        this.eventStore.assertOpen();
        const assignments = this.statements.selectActiveRoleAssignments
            .all(administratorId).map(mapRoleAssignment);
        const scopes = this.statements.selectActiveBarnScopes
            .all(administratorId).map(mapBarnScope);
        return assignments.map(assignment => ({
            ...assignment,
            barnIds: scopes
                .filter(scope => scope.roleAssignmentId === assignment.roleAssignmentId)
                .map(scope => scope.barnId)
        }));
    }

    createAdministrator(administrator, auditRecord) {
        return this.eventStore.transaction(() => {
            this.insertAdministrator(administrator);
            this.insertAuditRecord(auditRecord);
            return { ...administrator };
        });
    }

    updateAdministratorStatus(administratorId, status, updatedAt, auditRecord) {
        return this.eventStore.transaction(() => {
            const before = this.getAdministrator(administratorId);
            const result = this.statements.updateAdministratorStatus.run(
                status,
                updatedAt,
                administratorId,
                status
            );
            if (!before || Number(result.changes) !== 1) {
                return null;
            }
            this.insertAuditRecord(auditRecord);
            return this.getAdministrator(administratorId);
        });
    }

    recordAuthentication(administratorId, authenticatedAt, auditRecord) {
        return this.eventStore.transaction(() => {
            const result = this.statements.updateLastAuthenticatedAt.run(
                authenticatedAt,
                authenticatedAt,
                administratorId
            );
            if (Number(result.changes) !== 1) {
                return false;
            }
            this.insertAuditRecord(auditRecord);
            return true;
        });
    }

    assignRole(roleAssignment, auditRecord) {
        return this.eventStore.transaction(() => {
            this.insertRoleAssignment(roleAssignment);
            this.insertAuditRecord(auditRecord);
            return { ...roleAssignment };
        });
    }

    revokeRole(roleAssignmentId, revokedAt, auditRecord) {
        return this.eventStore.transaction(() => {
            const before = this.getRoleAssignment(roleAssignmentId);
            if (!before) {
                return null;
            }
            const result = this.statements.revokeRoleAssignment.run(
                revokedAt,
                roleAssignmentId
            );
            if (Number(result.changes) !== 1) {
                return null;
            }
            this.statements.revokeScopesForRoleAssignment.run(
                revokedAt,
                roleAssignmentId
            );
            this.insertAuditRecord(auditRecord);
            return this.getRoleAssignment(roleAssignmentId);
        });
    }

    assignBarnScope(barnScope, auditRecord) {
        return this.eventStore.transaction(() => {
            this.insertBarnScope(barnScope);
            this.insertAuditRecord(auditRecord);
            return { ...barnScope };
        });
    }

    revokeBarnScope(barnScopeId, revokedAt, auditRecord) {
        return this.eventStore.transaction(() => {
            const before = this.getBarnScope(barnScopeId);
            if (!before) {
                return null;
            }
            const result = this.statements.revokeBarnScope.run(
                revokedAt,
                barnScopeId
            );
            if (Number(result.changes) !== 1) {
                return null;
            }
            this.insertAuditRecord(auditRecord);
            return this.getBarnScope(barnScopeId);
        });
    }

    appendAuditRecord(auditRecord) {
        this.eventStore.assertOpen();
        this.insertAuditRecord(auditRecord);
        return { ...auditRecord };
    }

    getAuditRecords({ barnId = null, administratorId = null, limit = 200 } = {}) {
        this.eventStore.assertOpen();
        const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200));
        return this.statements.selectAuditRecords.all(
            barnId,
            barnId,
            administratorId,
            administratorId,
            safeLimit
        ).map(mapAuditRecord);
    }

    getBarn(barnId) {
        this.eventStore.assertOpen();
        const row = this.statements.selectBarn.get(barnId);
        return row ? { ...row } : null;
    }

    getFeeder(feederId) {
        this.eventStore.assertOpen();
        const row = this.statements.selectFeeder.get(feederId);
        return row ? { ...row } : null;
    }

    getFeederForBarn(feederId, barnId) {
        this.eventStore.assertOpen();
        const row = this.statements.selectFeederForBarn.get(feederId, barnId);
        return row ? { ...row } : null;
    }

    getDevice(deviceId) {
        this.eventStore.assertOpen();
        const row = this.statements.selectDevice.get(deviceId);
        return row ? { ...row } : null;
    }

    getDeviceForBarn(deviceId, barnId) {
        this.eventStore.assertOpen();
        const row = this.statements.selectDeviceForBarn.get(deviceId, barnId);
        return row ? { ...row } : null;
    }

    updateFeederStatus(feederId, barnId, status, reason, updatedAt, auditRecord) {
        return this.eventStore.transaction(() => {
            const result = this.statements.updateFeederStatus.run(
                status,
                reason,
                updatedAt,
                feederId,
                barnId
            );
            if (Number(result.changes) !== 1) {
                return null;
            }
            this.insertAuditRecord(auditRecord);
            return this.getFeeder(feederId);
        });
    }

    updateDeviceStatus(deviceId, barnId, status, reason, updatedAt, auditRecord) {
        return this.eventStore.transaction(() => {
            const result = this.statements.updateDeviceStatus.run(
                status,
                reason,
                updatedAt,
                deviceId,
                barnId
            );
            if (Number(result.changes) !== 1) {
                return null;
            }
            this.insertAuditRecord(auditRecord);
            return this.getDevice(deviceId);
        });
    }

    createWelfareNote(note, auditRecord) {
        return this.eventStore.transaction(() => {
            this.statements.insertWelfareNote.run(
                note.welfareNoteId,
                note.administratorId,
                note.barnId,
                note.feederId,
                note.note,
                note.createdAt
            );
            this.insertAuditRecord(auditRecord);
            return { ...note };
        });
    }

    getWelfareNotes(barnId, feederId = null) {
        this.eventStore.assertOpen();
        return this.statements.selectWelfareNotes.all(
            barnId,
            feederId,
            feederId
        ).map(row => ({ ...row }));
    }

    seedDevelopmentIdentity(administrator, assignment, barnScope = null) {
        return this.eventStore.transaction(() => {
            const existing = this.getAdministratorByExternalIdentity(
                administrator.externalIdentityId
            );
            if (existing) {
                return existing;
            }
            this.insertAdministrator(administrator);
            this.insertRoleAssignment(assignment);
            if (barnScope) {
                this.insertBarnScope(barnScope);
            }
            return { ...administrator };
        });
    }

    insertAdministrator(administrator) {
        this.statements.insertAdministrator.run(
            administrator.administratorId,
            administrator.externalIdentityId,
            administrator.displayName,
            administrator.email,
            administrator.status,
            administrator.createdAt,
            administrator.updatedAt,
            administrator.lastAuthenticatedAt
        );
    }

    insertRoleAssignment(assignment) {
        this.statements.insertRoleAssignment.run(
            assignment.roleAssignmentId,
            assignment.administratorId,
            assignment.role,
            assignment.platformWide ? 1 : 0,
            assignment.assignedAt,
            assignment.revokedAt
        );
    }

    insertBarnScope(scope) {
        this.statements.insertBarnScope.run(
            scope.barnScopeId,
            scope.roleAssignmentId,
            scope.administratorId,
            scope.barnId,
            scope.assignedAt,
            scope.revokedAt
        );
    }

    insertAuditRecord(record) {
        this.statements.insertAuditRecord.run(
            record.auditRecordId,
            record.administratorId,
            record.effectiveRole,
            record.barnId,
            record.feederId,
            record.deviceId,
            record.action,
            record.targetType,
            record.targetId,
            record.reason,
            record.requestId,
            record.authenticationStrength,
            record.timestamp,
            record.result,
            serializeJson(record.beforeSummary),
            serializeJson(record.afterSummary),
            serializeJson(record.metadata),
            record.approvalId
        );
    }
}
