import { randomUUID } from "node:crypto";

const COUNT_TABLES = Object.freeze([
    "ProviderEvents",
    "Contributions",
    "FeedIntents",
    "Outbox",
    "Events",
    "LifecycleHistory",
    "DeviceCommands",
    "DeviceCommandHistory",
    "DeviceAcknowledgements",
    "AuditRecords",
    "OperatorAuditRecords",
    "Administrators",
    "RoleAssignments",
    "EmergencyStops",
    "ApprovalRequests",
    "ApprovalDecisions",
    "OperatorResolutionCases",
    "SimulatedControllers",
    "SimulatedControllerFeederAssignments",
    "DistributedWorkClaims",
    "WorkClaimHistory",
    "RestoredCommandReviews"
]);

const UNIQUE_IDENTITIES = Object.freeze([
    ["ProviderEvents", "providerEventId"],
    ["Contributions", "contributionId"],
    ["FeedIntents", "feedIntentId"],
    ["Events", "eventId"],
    ["DeviceCommands", "commandId"],
    ["DeviceAcknowledgements", "acknowledgementId"],
    ["Administrators", "administratorId"],
    ["EmergencyStops", "emergencyStopId"],
    ["OperatorResolutionCases", "resolutionCaseId"]
]);

function count(database, sql, ...parameters) {
    return Number(database.prepare(sql).get(...parameters).count);
}

export class RestoredDataReconciler {
    constructor({
        eventStore,
        expectedSchemaVersion = eventStore.getSchemaVersion(),
        clock = () => new Date(),
        idGenerator = randomUUID
    }) {
        this.eventStore = eventStore;
        this.database = eventStore.database;
        this.expectedSchemaVersion = expectedSchemaVersion;
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    run({ requireRecoveryMode = true } = {}) {
        const checks = [];
        const add = (name, status, details = {}) => {
            checks.push({ name, status, details });
        };
        const schemaVersion = this.eventStore.getSchemaVersion();
        add(
            "schema_migration_version",
            schemaVersion === this.expectedSchemaVersion ? "PASS" : "BLOCKED",
            { actual: schemaVersion, expected: this.expectedSchemaVersion }
        );
        const recoveryMode = this.database.prepare(`
            SELECT mode FROM RecoverySafetyState WHERE recoveryStateId = 'central'
        `).get()?.mode;
        add(
            "restore_safety_mode",
            !requireRecoveryMode || recoveryMode === "BLOCKED" ? "PASS" : "BLOCKED",
            { mode: recoveryMode || "MISSING" }
        );

        const tableNames = new Set(this.eventStore.getTableNames().map(name => (
            String(name).toLowerCase()
        )));
        const tableCounts = {};
        COUNT_TABLES.forEach(table => {
            if (tableNames.has(table.toLowerCase())) {
                tableCounts[table] = count(this.database, `SELECT COUNT(*) AS count FROM ${table}`);
            } else {
                tableCounts[table] = null;
            }
        });
        add(
            "required_table_counts",
            Object.values(tableCounts).every(value => value !== null) ? "PASS" : "BLOCKED",
            tableCounts
        );

        if (this.eventStore.databaseType === "sqlite") {
            const violations = this.database.prepare("PRAGMA foreign_key_check;").all();
            add("foreign_keys", violations.length === 0 ? "PASS" : "BLOCKED", {
                violationCount: violations.length
            });
        } else {
            const invalidConstraints = count(this.database, `
                SELECT COUNT(*) AS count FROM pg_constraint
                WHERE contype = 'f' AND convalidated = FALSE
            `);
            add("foreign_keys", invalidConstraints === 0 ? "PASS" : "BLOCKED", {
                unvalidatedConstraintCount: invalidConstraints
            });
        }

        const duplicateIdentities = {};
        UNIQUE_IDENTITIES.forEach(([table, identity]) => {
            duplicateIdentities[`${table}.${identity}`] = count(this.database, `
                SELECT COUNT(*) AS count FROM (
                    SELECT ${identity} FROM ${table}
                    GROUP BY ${identity} HAVING COUNT(*) > 1
                ) duplicate_identities
            `);
        });
        add(
            "unique_identities",
            Object.values(duplicateIdentities).every(value => value === 0)
                ? "PASS" : "BLOCKED",
            duplicateIdentities
        );

        const relationships = {
            providerEventContributionOrphans: count(this.database, `
                SELECT COUNT(*) AS count FROM Contributions contribution
                LEFT JOIN ProviderEvents provider
                  ON provider.providerEventId = contribution.providerEventId
                WHERE provider.providerEventId IS NULL
            `),
            eligibleContributionsWithoutIntent: count(this.database, `
                SELECT COUNT(*) AS count FROM Contributions contribution
                LEFT JOIN FeedIntents intent
                  ON intent.contributionId = contribution.contributionId
                WHERE contribution.eligibilityStatus = 'ELIGIBLE'
                  AND intent.feedIntentId IS NULL
            `),
            completedIntentsWithoutEvent: count(this.database, `
                SELECT COUNT(*) AS count FROM FeedIntents intent
                LEFT JOIN Events event ON event.feedIntentId = intent.feedIntentId
                WHERE intent.status = 'COMPLETED' AND event.eventId IS NULL
            `),
            eventsWithoutLifecycleHistory: count(this.database, `
                SELECT COUNT(*) AS count FROM Events event
                LEFT JOIN LifecycleHistory history ON history.eventId = event.eventId
                WHERE history.eventId IS NULL
            `),
            commandsWithoutHistory: count(this.database, `
                SELECT COUNT(*) AS count FROM DeviceCommands command
                LEFT JOIN DeviceCommandHistory history
                  ON history.commandId = command.commandId
                WHERE history.commandId IS NULL
            `),
            acknowledgementOrphans: count(this.database, `
                SELECT COUNT(*) AS count FROM DeviceAcknowledgements acknowledgement
                LEFT JOIN DeviceCommands command
                  ON command.commandId = acknowledgement.commandId
                WHERE command.commandId IS NULL
            `),
            roleAssignmentOrphans: count(this.database, `
                SELECT COUNT(*) AS count FROM RoleAssignments assignment
                LEFT JOIN Administrators administrator
                  ON administrator.administratorId = assignment.administratorId
                WHERE administrator.administratorId IS NULL
            `),
            approvalDecisionOrphans: count(this.database, `
                SELECT COUNT(*) AS count FROM ApprovalDecisions decision
                LEFT JOIN ApprovalRequests request
                  ON request.approvalRequestId = decision.approvalRequestId
                WHERE request.approvalRequestId IS NULL
            `)
        };
        add(
            "domain_relationships",
            Object.values(relationships).every(value => value === 0) ? "PASS" : "BLOCKED",
            relationships
        );

        const activeClaims = count(this.database, `
            SELECT COUNT(*) AS count FROM DistributedWorkClaims WHERE state = 'ACTIVE'
        `);
        const operatorReviewClaims = count(this.database, `
            SELECT COUNT(*) AS count FROM DistributedWorkClaims
            WHERE state = 'OPERATOR_REVIEW'
        `);
        const deadLetterClaims = count(this.database, `
            SELECT COUNT(*) AS count FROM DistributedWorkClaims
            WHERE state = 'DEAD_LETTER'
        `);
        add("restored_worker_claims", activeClaims === 0 ? "PASS" : "BLOCKED", {
            active: activeClaims,
            operatorReview: operatorReviewClaims,
            deadLetter: deadLetterClaims
        });
        if (deadLetterClaims > 0) {
            add("dead_letter_visibility", "WARNING", { count: deadLetterClaims });
        } else {
            add("dead_letter_visibility", "PASS", { count: 0 });
        }

        const unsafeCommandsWithoutReview = count(this.database, `
            SELECT COUNT(*) AS count FROM DeviceCommands command
            LEFT JOIN RestoredCommandReviews review ON review.commandId = command.commandId
            WHERE command.status IN ('SENT', 'TIMED_OUT', 'OUTCOME_UNKNOWN')
              AND (review.commandId IS NULL OR review.reviewStatus <> 'REVIEW_REQUIRED')
        `);
        const unknownWithoutCase = count(this.database, `
            SELECT COUNT(*) AS count FROM DeviceCommands command
            LEFT JOIN OperatorResolutionCases resolution
              ON resolution.commandId = command.commandId
            WHERE command.status = 'OUTCOME_UNKNOWN'
              AND resolution.resolutionCaseId IS NULL
        `);
        add(
            "restored_device_commands",
            unsafeCommandsWithoutReview === 0 && unknownWithoutCase === 0
                ? "PASS" : "BLOCKED",
            { unsafeCommandsWithoutReview, outcomeUnknownWithoutCase: unknownWithoutCase }
        );

        const invalidAssignmentGenerations = count(this.database, `
            SELECT COUNT(*) AS count FROM SimulatedControllerFeederAssignments
            WHERE assignmentGeneration < 1
        `);
        add(
            "controller_assignments_and_generations",
            invalidAssignmentGenerations === 0 ? "PASS" : "BLOCKED",
            { invalidAssignmentGenerations }
        );

        const activeEmergencyStops = count(this.database, `
            SELECT COUNT(*) AS count FROM EmergencyStops WHERE status = 'ACTIVE'
        `);
        const openResolutionCases = count(this.database, `
            SELECT COUNT(*) AS count FROM OperatorResolutionCases WHERE status = 'OPEN'
        `);
        add("operator_safety_evidence", "PASS", {
            activeEmergencyStops,
            openResolutionCases,
            approvalRequests: tableCounts.ApprovalRequests,
            approvalDecisions: tableCounts.ApprovalDecisions,
            operatorAuditRecords: tableCounts.OperatorAuditRecords
        });

        const appendOnlyTriggerNames = this.eventStore.databaseType === "sqlite"
            ? this.database.prepare(`
                SELECT name FROM sqlite_schema
                WHERE type = 'trigger' AND name LIKE '%append_only%'
                ORDER BY name
            `).all().map(row => String(row.name).toLowerCase())
            : this.database.prepare(`
                SELECT tgname AS name FROM pg_trigger
                WHERE NOT tgisinternal AND tgname LIKE '%append_only%'
                ORDER BY tgname
            `).all().map(row => String(row.name).toLowerCase());
        const requiredTriggerEvidence = [
            "operator_audit_records_append_only",
            "work_claim_history_append_only",
            "approval_decisions_append_only",
            "approval_history_append_only",
            "disaster_recovery_events_append_only",
            ...(this.eventStore.databaseType === "postgres" ? [
                "audit_records_append_only",
                "device_command_history_append_only",
                "device_command_audit_append_only"
            ] : [])
        ];
        const missingTriggerEvidence = requiredTriggerEvidence.filter(required => (
            !appendOnlyTriggerNames.some(name => name.includes(required))
        ));
        add(
            "audit_immutability_evidence",
            missingTriggerEvidence.length === 0 ? "PASS" : "BLOCKED",
            {
                appendOnlyTriggerCount: appendOnlyTriggerNames.length,
                missingTriggerEvidence
            }
        );

        const status = checks.some(check => check.status === "BLOCKED")
            ? "BLOCKED"
            : checks.some(check => check.status === "WARNING")
                ? "WARNING"
                : "PASS";
        return Object.freeze({
            reportVersion: 1,
            reportId: `reconciliation-${this.idGenerator()}`,
            createdAt: this.clock().toISOString(),
            status,
            schemaVersion,
            databaseType: this.eventStore.databaseType,
            checks
        });
    }
}
