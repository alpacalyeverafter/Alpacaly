import { randomUUID } from "node:crypto";

import {
    createContributionAuditRecord,
    createProviderEvent
} from "../domain/contributions.js";

export class ProviderEventIngestionService {
    constructor({ eventStore, logger, clock = () => new Date(), idGenerator = randomUUID }) {
        this.eventStore = eventStore;
        this.logger = logger;
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    ingest({ provider, externalEventId, rawMetadata = null, receivedAt = null }) {
        const providerEvent = createProviderEvent({
            provider,
            externalEventId,
            rawMetadata,
            receivedAt: receivedAt || this.clock().toISOString()
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });

        const existing = this.eventStore.getProviderEventByExternalId(
            providerEvent.provider,
            providerEvent.externalEventId
        );
        if (existing) {
            return this.recordDuplicate(existing);
        }

        const auditRecord = this.audit("PROVIDER_EVENT_RECEIVED", {
            providerEventId: providerEvent.providerEventId,
            details: {
                provider: providerEvent.provider,
                externalEventId: providerEvent.externalEventId
            }
        });

        try {
            this.eventStore.createProviderEvent(providerEvent, auditRecord);
        } catch (error) {
            const concurrentExisting = this.eventStore.getProviderEventByExternalId(
                providerEvent.provider,
                providerEvent.externalEventId
            );
            if (!concurrentExisting) {
                throw error;
            }
            return this.recordDuplicate(concurrentExisting);
        }

        this.logger.info({
            event: "provider_event_received",
            providerEventId: providerEvent.providerEventId,
            provider: providerEvent.provider,
            externalEventId: providerEvent.externalEventId
        }, "Provider event received");

        return {
            providerEvent: { ...providerEvent },
            duplicate: false
        };
    }

    recordDuplicate(providerEvent) {
        this.eventStore.appendAuditRecord(this.audit("DUPLICATE_DETECTED", {
            providerEventId: providerEvent.providerEventId,
            details: {
                provider: providerEvent.provider,
                externalEventId: providerEvent.externalEventId
            }
        }));
        this.logger.info({
            event: "provider_event_duplicate_detected",
            providerEventId: providerEvent.providerEventId,
            provider: providerEvent.provider,
            externalEventId: providerEvent.externalEventId
        }, "Duplicate provider event detected");
        return {
            providerEvent: { ...providerEvent },
            duplicate: true
        };
    }

    audit(action, input) {
        return createContributionAuditRecord({ action, ...input }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });
    }
}
