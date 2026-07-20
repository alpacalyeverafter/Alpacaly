import { createOperatorAuditRecord } from "../domain/administrator-security.js";

const SENSITIVE_KEY = /password|authorization|cookie|secret|token|private.?key|api.?key|payment.?details/i;

export function sanitizeAuditValue(value, depth = 0) {
    if (depth > 8) {
        return "[DEPTH_LIMIT]";
    }
    if (Array.isArray(value)) {
        return value.slice(0, 100).map(item => sanitizeAuditValue(item, depth + 1));
    }
    if (!value || typeof value !== "object") {
        return typeof value === "string" ? value.slice(0, 2000) : value;
    }

    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeAuditValue(item, depth + 1)
    ]));
}

export class OperatorAuditService {
    constructor({ store, clock = () => new Date(), idGenerator }) {
        this.store = store;
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    create(input) {
        return createOperatorAuditRecord({
            ...input,
            beforeSummary: sanitizeAuditValue(input.beforeSummary),
            afterSummary: sanitizeAuditValue(input.afterSummary),
            metadata: sanitizeAuditValue(input.metadata)
        }, {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        });
    }

    record(input) {
        const record = this.create(input);
        return this.store.appendAuditRecord(record);
    }
}
