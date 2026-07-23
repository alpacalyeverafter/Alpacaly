import { FeedCreditService } from "./feed-credit-service.js";
import { SqliteCreditStore } from "./sqlite-credit-store.js";

export function createFeedCreditServices({
    eventEngine,
    contributionLedgerServices,
    config,
    logger,
    clock = eventEngine.clock,
    idGenerator,
    tokenGenerator,
    startReconciler = true
}) {
    const store = new SqliteCreditStore({ eventStore: eventEngine.eventStore });
    const service = new FeedCreditService({
        eventEngine,
        contributionLedgerServices,
        store,
        config,
        logger,
        clock,
        startReconciler,
        ...(idGenerator ? { idGenerator } : {}),
        ...(tokenGenerator ? { tokenGenerator } : {})
    });
    return { store, service };
}
