import { Router } from "express";

import {
    requireSupporter,
    verifySupporterCsrf
} from "../middleware/supporter-authentication.js";

function walletTokenFromRequest(req) {
    const authorization = req.get("authorization");
    if (typeof authorization !== "string") {
        return null;
    }
    const match = /^Wallet\s+([^\s]+)$/i.exec(authorization.trim());
    return match ? match[1] : null;
}

export function createSupporterAccountsRouter({ supporterAccountServices }) {
    const router = Router();
    const { provider, service } = supporterAccountServices;
    const csrf = verifySupporterCsrf(service);

    router.get("/login", async (req, res, next) => {
        try {
            await provider.login(req, res);
        } catch (error) {
            next(error);
        }
    });

    router.get("/logout", async (req, res, next) => {
        try {
            await provider.logout(req, res);
        } catch (error) {
            next(error);
        }
    });

    router.get("/session", (req, res, next) => {
        if (req.supporterAuthenticationError) {
            next(req.supporterAuthenticationError);
            return;
        }
        res.status(200).json({
            ...service.getSessionView(req.supporterIdentity),
            requestId: req.requestId
        });
    });

    router.post("/wallets/link", requireSupporter, csrf, (req, res, next) => {
        try {
            const result = service.linkWallet(
                req.supporterIdentity,
                walletTokenFromRequest(req),
                req.body,
                req.requestId
            );
            res.status(result.duplicate ? 200 : 201).json({
                linked: true,
                duplicate: result.duplicate,
                walletId: result.wallet.walletId,
                session: service.getSessionView(req.supporterIdentity),
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    router.post("/sessions/revoke-all", requireSupporter, csrf, (req, res, next) => {
        try {
            service.revokeAllSessions(req.supporterIdentity, req.requestId);
            res.status(200).json({
                revoked: true,
                logoutUrl: "/api/supporter-accounts/logout",
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    router.get("/export", requireSupporter, (req, res, next) => {
        try {
            res.status(200).json({
                export: service.exportAccount(req.supporterIdentity, req.requestId),
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    router.post("/delete", requireSupporter, csrf, (req, res, next) => {
        try {
            const result = service.deleteAccount(
                req.supporterIdentity,
                req.body?.confirmation,
                req.requestId
            );
            res.status(200).json({
                ...result,
                warning: result.guestWalletRecovery.length > 0
                    ? "Save each recovery token now. It cannot be shown again."
                    : null,
                requestId: req.requestId
            });
        } catch (error) {
            next(error);
        }
    });

    return router;
}
