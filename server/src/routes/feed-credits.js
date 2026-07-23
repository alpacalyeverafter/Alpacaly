import { Router } from "express";

import { ApplicationError } from "../errors/application-error.js";

export function walletTokenFromRequest(req) {
    const authorization = String(req.get("authorization") || "").trim();
    const match = /^Wallet\s+([A-Za-z0-9_-]{40,100})$/.exec(authorization);
    if (!match) {
        throw new ApplicationError("A Feed Credit wallet session is required.", {
            code: "FEED_CREDIT_WALLET_UNAUTHORIZED",
            statusCode: 401
        });
    }
    return match[1];
}

export function walletCredentialFromRequest(req, supporterAccountService, {
    mutation = req.method !== "GET"
} = {}) {
    const authorization = String(req.get("authorization") || "").trim();
    if (authorization) {
        return walletTokenFromRequest(req);
    }
    if (!req.supporterIdentity || !supporterAccountService) {
        if (req.supporterAuthenticationError) {
            throw req.supporterAuthenticationError;
        }
        throw new ApplicationError("A Feed Credit wallet session is required.", {
            code: "FEED_CREDIT_WALLET_UNAUTHORIZED",
            statusCode: 401
        });
    }
    if (mutation) {
        supporterAccountService.verifyCsrf(
            req.supporterIdentity,
            req.get("x-alpacaly-csrf")
        );
    }
    return supporterAccountService.requireWalletAccess(
        req.supporterIdentity,
        req.get("x-wallet-id")
    );
}

export function createFeedCreditsRouter({
    feedCreditService,
    paymentService,
    supporterAccountService = null
}) {
    const router = Router();

    router.get("/packs", (req, res) => {
        res.status(200).json({
            packs: feedCreditService.getPacks(),
            notice:
                "Feed Credits provide the right to request a feed. Welfare and operational controls decide whether and when a dispense can occur.",
            requestId: req.requestId
        });
    });

    router.post("/wallets", (req, res, next) => {
        try {
            const result = feedCreditService.createWallet(req.body);
            res.status(201).json({
                ...result,
                recoveryNotice:
                    "This browser stores a private recovery token. Anyone with that token can access this Feed Credit wallet.",
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    router.get("/wallet", (req, res, next) => {
        try {
            res.status(200).json({
                wallet: feedCreditService.getWallet(walletCredentialFromRequest(
                    req,
                    supporterAccountService
                )),
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

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
                notice:
                    "Checkout only buys Feed Credits. It never starts a countdown or feed.",
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    router.post("/reservations", (req, res, next) => {
        try {
            const result = feedCreditService.createReservation(
                walletCredentialFromRequest(req, supporterAccountService),
                req.body
            );
            res.status(result.duplicate ? 200 : 202).json({
                ...result,
                notice:
                    "One Feed Credit is reserved. The countdown cannot start until it is your turn, this page is active and you confirm.",
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    router.post("/reservations/:reservationId/presence", (req, res, next) => {
        try {
            res.status(200).json({
                reservation: feedCreditService.heartbeat(
                    walletCredentialFromRequest(req, supporterAccountService),
                    req.params.reservationId,
                    req.body
                ),
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    router.post("/reservations/:reservationId/confirm", (req, res, next) => {
        try {
            res.status(202).json({
                ...feedCreditService.confirm(
                    walletCredentialFromRequest(req, supporterAccountService),
                    req.params.reservationId
                ),
                notice:
                    "Confirmation accepted. The existing 10-second safety-controlled countdown may now start.",
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    router.post("/reservations/:reservationId/cancel", (req, res, next) => {
        try {
            res.status(200).json({
                reservation: feedCreditService.cancel(
                    walletCredentialFromRequest(req, supporterAccountService),
                    req.params.reservationId
                ),
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    return router;
}
