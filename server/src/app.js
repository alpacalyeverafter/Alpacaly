import express from "express";
import cors from "cors";

import { createAdministratorSecurityServices } from "./administrator-security/index.js";
import { loadConfig } from "./config/index.js";
import { createContributionLedgerServices } from "./contribution-ledger/index.js";
import { createDeviceCommandServices } from "./device-commands/index.js";
import { RecoveryDiagnosticsService } from "./disaster-recovery/recovery-diagnostics-service.js";
import { EventEngine } from "./event-engine/event-engine.js";
import { createLogger } from "./logging/logger.js";
import { createErrorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestLogger } from "./middleware/request-logger.js";
import { authenticateAdministrator } from "./middleware/administrator-security.js";
import { createOperatorSafetyServices } from "./operator-safety/index.js";
import { createPaymentServices } from "./payments/index.js";
import { createAdministratorRouter } from "./routes/administrator.js";
import { createEventEngineRouter } from "./routes/event-engine.js";
import { createDevelopmentContributionsRouter } from "./routes/development-contributions.js";
import { createFeedRequestsRouter } from "./routes/feed-requests.js";
import { createHealthRouter } from "./routes/health.js";
import {
    createPaymentsRouter,
    createStripeWebhookRouter
} from "./routes/payments.js";
import { createResourceQueuesRouter } from "./routes/resource-queues.js";
import { createFeedCreditsRouter } from "./routes/feed-credits.js";

export function createApp(options = {}) {
    const config = options.config || loadConfig();
    const logger = options.logger || createLogger(config);
    const eventEngine = options.eventEngine || new EventEngine({ config, logger });
    const deviceCommandServices = options.deviceCommandServices
        || createDeviceCommandServices({
            eventEngine,
            config,
            logger,
            clock: eventEngine.clock,
            startWorker: false
        });
    const contributionLedgerServices = options.contributionLedgerServices
        || createContributionLedgerServices({
            eventEngine,
            config,
            logger,
            clock: eventEngine.clock,
            startOutboxWorker: true,
            outboxPollIntervalMs: config.outboxPollIntervalMs,
            outboxRetryDelayMs: config.outboxRetryDelayMs
        });
    const paymentServices = options.paymentServices || createPaymentServices({
        eventEngine,
        contributionLedgerServices,
        config,
        logger,
        clock: eventEngine.clock,
        adapter: options.paymentProviderAdapter || null,
        checkoutSessionCreator: options.checkoutSessionCreator || null,
        ...(options.paymentIdGenerator
            ? { idGenerator: options.paymentIdGenerator }
            : {})
    });
    const administratorSecurityServices = options.administratorSecurityServices
        || createAdministratorSecurityServices({
            eventEngine,
            deviceCommandServices,
            config,
            clock: eventEngine.clock
        });
    deviceCommandServices.controllerService
        ?.setAdministratorSecurityServices(administratorSecurityServices);
    const operatorSafetyServices = options.operatorSafetyServices
        || createOperatorSafetyServices({
            eventEngine,
            deviceCommandServices,
            administratorSecurityServices,
            config,
            clock: eventEngine.clock
        });
    const recoveryDiagnosticsService = options.recoveryDiagnosticsService
        || new RecoveryDiagnosticsService({
            recoverySafetyService: eventEngine.recoverySafetyService,
            config,
            clock: eventEngine.clock
        });
    if (
        !options.deviceCommandServices
        && eventEngine.recoverySafetyService.workersMayStart()
    ) {
        deviceCommandServices.worker.start();
    }
    const app = express();

    app.disable("x-powered-by");
    app.locals.config = config;
    app.locals.logger = logger;
    app.locals.eventEngine = eventEngine;
    app.locals.deviceCommandServices = deviceCommandServices;
    app.locals.contributionLedgerServices = contributionLedgerServices;
    app.locals.paymentServices = paymentServices;
    app.locals.feedCreditServices = paymentServices.feedCreditServices;
    app.locals.administratorSecurityServices = administratorSecurityServices;
    app.locals.operatorSafetyServices = operatorSafetyServices;
    app.locals.recoverySafetyService = eventEngine.recoverySafetyService;
    app.locals.recoveryDiagnosticsService = recoveryDiagnosticsService;

    app.use(cors({
        origin: config.corsOrigin,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["content-type", "x-request-id", "authorization"],
        exposedHeaders: ["x-request-id"]
    }));
    app.use(requestLogger(logger));
    app.use(
        "/api/payments/webhooks/stripe",
        express.raw({
            type: "application/json",
            limit: config.paymentWebhookBodyLimit
        }),
        createStripeWebhookRouter({
            paymentService: paymentServices.paymentService,
            sandboxDiagnosticsService: paymentServices.sandboxDiagnosticsService
        })
    );
    app.use(express.json({ limit: config.requestBodyLimit }));

    app.use("/health", createHealthRouter({
        config,
        eventStore: eventEngine.eventStore,
        claimStores: [
            eventEngine.lifecycleClaimStore,
            contributionLedgerServices.claimStore,
            deviceCommandServices.claimStore
        ].filter(Boolean),
        recoverySafetyService: eventEngine.recoverySafetyService
    }));
    app.use("/api/feed-requests", createFeedRequestsRouter({
        eventEngine,
        config,
        developmentWebsiteContributionService:
            contributionLedgerServices.developmentWebsiteContributionService
    }));
    app.use("/api/feeders", createResourceQueuesRouter({
        eventEngine,
        config,
        developmentWebsiteContributionService:
            contributionLedgerServices.developmentWebsiteContributionService
    }));
    app.use("/api/development", createDevelopmentContributionsRouter({
        config,
        eventEngine,
        developmentWebsiteContributionService:
            contributionLedgerServices.developmentWebsiteContributionService
    }));
    app.use("/api/payments", createPaymentsRouter({
        paymentService: paymentServices.paymentService
    }));
    app.use("/api/feed-credits", createFeedCreditsRouter({
        feedCreditService: paymentServices.feedCreditServices.service,
        paymentService: paymentServices.paymentService
    }));
    app.use("/api/admin", authenticateAdministrator(
        administratorSecurityServices.authenticationService
    ));
    app.use("/api/admin", createAdministratorRouter({
        eventEngine,
        config,
        administratorSecurityServices,
        deviceCommandServices,
        contributionLedgerServices,
        paymentServices,
        operatorSafetyServices,
        recoveryDiagnosticsService
    }));
    app.use("/api/event-engine", createEventEngineRouter({
        eventEngine,
        config,
        administratorSecurityServices
    }));

    app.use(notFoundHandler);
    app.use(createErrorHandler(logger));

    return app;
}
