import { PaymentService } from "./payment-service.js";
import { SandboxDiagnosticsService } from "./sandbox-diagnostics-service.js";
import { StripeTestPaymentAdapter } from "./stripe-test-payment-adapter.js";
import { createFeedCreditServices } from "../feed-credits/index.js";

export function createPaymentServices({
    eventEngine,
    contributionLedgerServices,
    config,
    logger,
    clock = eventEngine.clock,
    adapter = null,
    checkoutSessionCreator = null,
    idGenerator
}) {
    const feedCreditServices = createFeedCreditServices({
        eventEngine,
        contributionLedgerServices,
        config,
        logger,
        clock,
        ...(idGenerator ? { idGenerator } : {})
    });
    const paymentAdapter = adapter || new StripeTestPaymentAdapter({
        secretKey: config.stripeTestSecretKey,
        webhookSecret: config.stripeTestWebhookSecret,
        webhookToleranceSeconds: config.paymentWebhookToleranceSeconds,
        apiTimeoutMs: config.paymentProviderTimeoutMs,
        checkoutSessionCreator
    });
    const paymentService = new PaymentService({
        eventEngine,
        contributionLedgerServices,
        feedCreditService: feedCreditServices.service,
        adapter: paymentAdapter,
        config,
        logger,
        clock,
        ...(idGenerator ? { idGenerator } : {})
    });
    const sandboxDiagnosticsService = new SandboxDiagnosticsService({
        config,
        paymentAdapter,
        clock
    });
    return {
        paymentAdapter,
        paymentService,
        sandboxDiagnosticsService,
        feedCreditServices
    };
}
