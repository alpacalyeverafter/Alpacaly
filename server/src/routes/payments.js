import { Router } from "express";

export function createPaymentsRouter({ paymentService }) {
    const router = Router();

    router.post("/checkout-sessions", async (req, res, next) => {
        try {
            const result = await paymentService.createCheckoutSession(req.body);
            res.status(result.duplicate ? 200 : 201).json({
                sandbox: true,
                duplicate: result.duplicate,
                checkoutUrl: result.paymentRequest.checkoutUrl,
                paymentRequest: paymentService.getPaymentRequestView(
                    result.paymentRequest.paymentRequestId
                ),
                welfareNotice:
                    "Payment is a request to join the feeding queue, not a guaranteed dispense. Animal-welfare and operational controls always decide whether and when feeding can occur.",
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
                paymentRequest: paymentService.getPaymentRequestView(
                    req.params.paymentRequestId
                ),
                welfareNotice:
                    "A completed payment does not bypass welfare limits, feeding windows, emergency stops or operational holds.",
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
