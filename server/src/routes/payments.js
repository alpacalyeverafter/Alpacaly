import { Router } from "express";
import { walletCredentialFromRequest } from "./feed-credits.js";

export function createPaymentsRouter({ paymentService, supporterAccountService = null }) {
    const router = Router();

    router.post("/checkout-sessions", async (req, res, next) => {
        try {
            const result = await paymentService.createCheckoutSession(req.body, {
                walletToken: walletCredentialFromRequest(
                    req,
                    supporterAccountService
                )
            });
            res.status(result.duplicate ? 200 : 201).json({
                sandbox: true,
                duplicate: result.duplicate,
                checkoutUrl: result.paymentRequest.checkoutUrl,
                paymentRequest: paymentService.getPaymentRequestView(
                    result.paymentRequest.paymentRequestId
                ),
                welfareNotice:
                    "Payment only adds Feed Credits. It never starts a countdown or feed.",
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    router.get("/requests/:paymentRequestId", (req, res, next) => {
        try {
            res.status(200).json({
                sandbox: true,
                paymentRequest: paymentService.getOwnedPaymentRequestView(
                    req.params.paymentRequestId,
                    walletCredentialFromRequest(
                        req,
                        supporterAccountService,
                        { mutation: false }
                    )
                ),
                welfareNotice:
                    "A completed payment only adds Feed Credits and does not create a feed request.",
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    return router;
}

export function createStripeWebhookRouter({ paymentService, sandboxDiagnosticsService }) {
    const router = Router();

    router.post("/", (req, res, next) => {
        try {
            const result = paymentService.handleStripeWebhook(
                req.body,
                req.get("stripe-signature")
            );
            sandboxDiagnosticsService?.recordWebhookResult(result);
            res.status(200).json({
                received: true,
                duplicate: Boolean(result.duplicate),
                handled: Boolean(result.handled),
                accepted: Boolean(result.accepted),
                requestId: req.requestId
            });
        } catch (error) {
            sandboxDiagnosticsService?.recordWebhookRejection(error);
            next(error);
        }
    });

    return router;
}
