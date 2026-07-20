import { ContributionVerificationService } from "./contribution-verification-service.js";
import { DevelopmentWebsiteContributionService } from "./development-website-contribution-service.js";
import { FeedEligibilityService } from "./feed-eligibility-service.js";
import { FeedIntentOutboxWorker } from "./feed-intent-outbox-worker.js";
import { FeedIntentService } from "./feed-intent-service.js";
import { FeedRequestService } from "./feed-request-service.js";
import { ProviderEventIngestionService } from "./provider-event-ingestion-service.js";
import { createDistributedClaimStore } from "../worker-coordination/distributed-claim-store.js";
import { createWorkerIdentity } from "../worker-coordination/worker-identity.js";

export function createContributionLedgerServices({
    eventEngine,
    eventStore = eventEngine.eventStore,
    config = eventEngine.config || {},
    logger,
    clock = () => new Date(),
    idGenerator,
    startOutboxWorker = false,
    outboxPollIntervalMs,
    outboxRetryDelayMs
}) {
    const claimStore = createDistributedClaimStore({ eventStore, config, clock });
    const workerIdentity = createWorkerIdentity({
        config,
        serviceType: "feed-intent-outbox",
        clock
    });
    const common = {
        eventStore,
        logger,
        clock,
        ...(idGenerator ? { idGenerator } : {})
    };
    const providerEventIngestionService = new ProviderEventIngestionService(common);
    const feedEligibilityService = new FeedEligibilityService({ eventStore });
    const feedIntentService = new FeedIntentService({
        ...common,
        feedEligibilityService,
        defaultFeederId: eventEngine.getDefaultFeederId()
    });
    const contributionVerificationService = new ContributionVerificationService({
        ...common,
        feedIntentService
    });
    const feedRequestService = new FeedRequestService({
        ...common,
        eventEngine,
        feedEligibilityService
    });
    const outboxWorker = new FeedIntentOutboxWorker({
        ...common,
        eventEngine,
        feedIntentService,
        feedRequestService,
        claimStore,
        workerIdentity,
        heartbeatIntervalMs: config.workerHeartbeatIntervalMs,
        maximumAttempts: config.workerMaximumAttempts,
        ...(outboxPollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: outboxPollIntervalMs }),
        ...(outboxRetryDelayMs === undefined
            ? {}
            : { retryDelayMs: outboxRetryDelayMs })
    });
    const developmentWebsiteContributionService = new DevelopmentWebsiteContributionService({
        providerEventIngestionService,
        contributionVerificationService,
        outboxWorker,
        clock,
        ...(idGenerator ? { idGenerator } : {})
    });

    if (startOutboxWorker) {
        outboxWorker.start();
    }

    return {
        providerEventIngestionService,
        contributionVerificationService,
        feedEligibilityService,
        feedIntentService,
        feedRequestService,
        outboxWorker,
        claimStore,
        workerIdentity,
        developmentWebsiteContributionService
    };
}
