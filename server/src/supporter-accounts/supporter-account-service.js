import {
    createHash,
    createHmac,
    randomBytes,
    timingSafeEqual
} from "node:crypto";

import { ApplicationError } from "../errors/application-error.js";
import {
    createSupporterAccount,
    createSupporterAccountEvent,
    createSupporterWalletLink
} from "../domain/supporter-accounts.js";

function text(value) {
    return typeof value === "string" ? value.trim() : "";
}

function tokenHash(value) {
    return createHash("sha256").update(value).digest("hex");
}

function validClientRequestId(value) {
    return /^[A-Za-z0-9_.:-]{8,120}$/.test(text(value));
}

function safeAccountView(account) {
    return account ? Object.freeze({
        accountId: account.accountId,
        providerName: account.providerName,
        email: account.emailNormalized,
        emailVerified: account.emailVerified,
        displayName: account.displayName,
        status: account.status,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt
    }) : null;
}

export class SupporterAccountService {
    constructor({
        provider,
        store,
        feedCreditService,
        config,
        clock = () => new Date(),
        idGenerator,
        tokenGenerator = () => randomBytes(32).toString("base64url")
    }) {
        this.provider = provider;
        this.store = store;
        this.feedCreditService = feedCreditService;
        this.config = config;
        this.clock = clock;
        this.idGenerator = idGenerator;
        this.tokenGenerator = tokenGenerator;
    }

    async authenticate(request) {
        const identity = await this.provider.getIdentity(request);
        if (!identity) {
            return null;
        }
        const accountDraft = createSupporterAccount(identity, {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        });
        const createdEvent = createSupporterAccountEvent({
            accountId: accountDraft.accountId,
            eventType: "ACCOUNT_CREATED",
            actorType: "SUPPORTER",
            actorReference: identity.externalIdentityId,
            requestId: request.requestId,
            metadata: { providerName: identity.providerName }
        }, {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        });
        const { account } = this.store.upsertIdentity(accountDraft, createdEvent);
        if (!account || account.status !== "ACTIVE") {
            throw new ApplicationError("Supporter account access is not active.", {
                code: `SUPPORTER_ACCOUNT_${account?.status || "UNAVAILABLE"}`,
                statusCode: 403
            });
        }
        const issuedAt = Date.parse(identity.issuedAt);
        const validAfter = Date.parse(account.sessionsValidAfter);
        if (
            Number.isFinite(issuedAt)
            && Number.isFinite(validAfter)
            && issuedAt < validAfter - 5000
        ) {
            throw new ApplicationError("This supporter session has been revoked.", {
                code: "SUPPORTER_SESSION_REVOKED",
                statusCode: 401
            });
        }
        const now = this.clock().toISOString();
        const sessionEvent = createSupporterAccountEvent({
            accountId: account.accountId,
            eventType: "SESSION_AUTHENTICATED",
            actorType: "SUPPORTER",
            actorReference: account.accountId,
            requestId: request.requestId,
            metadata: {
                authenticationStrength: identity.authenticationStrength
            }
        }, {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        });
        const session = this.store.recordSession({
            providerSessionId: identity.sessionId,
            accountId: account.accountId,
            authenticatedAt: identity.authenticatedAt,
            lastSeenAt: now
        }, sessionEvent);
        if (!session || session.revokedAt) {
            throw new ApplicationError("This supporter session has been revoked.", {
                code: "SUPPORTER_SESSION_REVOKED",
                statusCode: 401
            });
        }
        return Object.freeze({
            accountId: account.accountId,
            providerName: account.providerName,
            externalIdentityId: account.externalIdentityId,
            email: account.emailNormalized,
            emailVerified: account.emailVerified,
            displayName: account.displayName,
            status: account.status,
            sessionId: identity.sessionId,
            authenticatedAt: identity.authenticatedAt,
            issuedAt: identity.issuedAt,
            authenticationStrength: identity.authenticationStrength
        });
    }

    csrfToken(identity) {
        return createHmac("sha256", this.config.supporterCsrfSecret)
            .update(`supporter-csrf:${identity.accountId}:${identity.sessionId}`)
            .digest("base64url");
    }

    verifyCsrf(identity, candidate) {
        const expected = Buffer.from(this.csrfToken(identity));
        const received = Buffer.from(text(candidate));
        if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
            throw new ApplicationError("The supporter session check failed.", {
                code: "SUPPORTER_CSRF_REJECTED",
                statusCode: 403
            });
        }
    }

    requireVerified(identity) {
        if (!identity?.emailVerified) {
            throw new ApplicationError(
                "Verify your email address before protecting a wallet.",
                { code: "SUPPORTER_EMAIL_VERIFICATION_REQUIRED", statusCode: 403 }
            );
        }
        const age = this.clock().getTime() - Date.parse(identity.authenticatedAt);
        if (!Number.isFinite(age) || age > this.config.supporterRecentAuthenticationSeconds * 1000) {
            throw new ApplicationError("Sign in again before changing wallet ownership.", {
                code: "SUPPORTER_RECENT_AUTHENTICATION_REQUIRED",
                statusCode: 403
            });
        }
    }

    getSessionView(identity) {
        if (!identity) {
            return {
                authenticated: false,
                provider: this.provider.providerName,
                accountsAvailable: this.provider.providerName !== "unconfigured"
            };
        }
        const links = this.store.listWalletLinks(identity.accountId);
        const wallets = links.map(link => ({
            ...this.feedCreditService.getWalletView(this.store.getWallet(link.walletId)),
            linkedAt: link.linkedAt
        }));
        const balance = wallets.reduce((total, wallet) => ({
            available: total.available + Number(wallet.balance?.available || 0),
            reserved: total.reserved + Number(wallet.balance?.reserved || 0),
            spent: total.spent + Number(wallet.balance?.spent || 0)
        }), { available: 0, reserved: 0, spent: 0 });
        return {
            authenticated: true,
            provider: this.provider.providerName,
            account: safeAccountView(this.store.getAccount(identity.accountId)),
            wallets,
            balance,
            csrfToken: this.csrfToken(identity)
        };
    }

    linkWallet(identity, recoveryToken, input, requestId) {
        this.requireVerified(identity);
        const token = text(recoveryToken);
        if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
            throw new ApplicationError("The wallet could not be linked.", {
                code: "SUPPORTER_WALLET_PROOF_INVALID",
                statusCode: 401
            });
        }
        const clientRequestId = text(input?.clientRequestId);
        if (!validClientRequestId(clientRequestId)) {
            throw new ApplicationError("The wallet-linking reference is invalid.", {
                code: "SUPPORTER_WALLET_LINK_INVALID",
                statusCode: 400
            });
        }
        const priorRequest = this.store.getWalletLinkByClientRequest(
            identity.accountId,
            clientRequestId
        );
        if (priorRequest) {
            return {
                link: priorRequest,
                wallet: this.store.getWallet(priorRequest.walletId),
                duplicate: true
            };
        }
        const hashedToken = tokenHash(token);
        const wallet = this.store.getWalletByTokenHash(hashedToken);
        if (!wallet) {
            throw new ApplicationError("The wallet could not be linked.", {
                code: "SUPPORTER_WALLET_PROOF_INVALID",
                statusCode: 401
            });
        }
        const link = createSupporterWalletLink({
            accountId: identity.accountId,
            walletId: wallet.walletId,
            clientRequestId
        }, {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        });
        const event = createSupporterAccountEvent({
            accountId: identity.accountId,
            walletId: wallet.walletId,
            eventType: "WALLET_LINKED",
            actorType: "SUPPORTER",
            actorReference: identity.accountId,
            requestId,
            metadata: { clientRequestId }
        }, {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        });
        try {
            return this.store.linkWallet({
                accountId: identity.accountId,
                clientRequestId,
                tokenHash: hashedToken,
                replacementHash: tokenHash(this.tokenGenerator()),
                link,
                event
            });
        } catch (error) {
            if ([
                "SUPPORTER_WALLET_PROOF_INVALID",
                "SUPPORTER_WALLET_ALREADY_LINKED"
            ].includes(error?.code)) {
                throw new ApplicationError("The wallet could not be linked.", {
                    code: error.code,
                    statusCode: 409
                });
            }
            throw error;
        }
    }

    requireWalletAccess(identity, walletId) {
        const normalizedWalletId = text(walletId);
        if (!normalizedWalletId || !this.store.getWalletLink(
            identity.accountId,
            normalizedWalletId
        )) {
            throw new ApplicationError("The Feed Credit wallet could not be accessed.", {
                code: "SUPPORTER_WALLET_ACCESS_DENIED",
                statusCode: 403
            });
        }
        return Object.freeze({
            trustedAccountWallet: true,
            walletId: normalizedWalletId,
            accountId: identity.accountId
        });
    }

    revokeAllSessions(identity, requestId) {
        const timestamp = this.clock().toISOString();
        const event = createSupporterAccountEvent({
            accountId: identity.accountId,
            eventType: "SESSIONS_REVOKED",
            actorType: "SUPPORTER",
            actorReference: identity.accountId,
            requestId,
            reason: "SUPPORTER_REQUESTED_GLOBAL_LOGOUT"
        }, {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        });
        this.store.revokeAllSessions(identity.accountId, timestamp, event);
    }

    exportAccount(identity, requestId) {
        const account = this.store.getAccount(identity.accountId);
        const links = this.store.listWalletLinks(identity.accountId);
        const exported = {
            generatedAt: this.clock().toISOString(),
            account: safeAccountView(account),
            wallets: links.map(link => this.feedCreditService.getWalletView(
                this.store.getWallet(link.walletId)
            )),
            accountEvents: this.store.listEventsForAccount(identity.accountId, 500)
        };
        this.store.recordEvent(createSupporterAccountEvent({
            accountId: identity.accountId,
            eventType: "DATA_EXPORTED",
            actorType: "SUPPORTER",
            actorReference: identity.accountId,
            requestId
        }, {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        }));
        return exported;
    }

    deleteAccount(identity, confirmation, requestId) {
        this.requireVerified(identity);
        if (text(confirmation) !== "DELETE MY ACCOUNT") {
            throw new ApplicationError("Account deletion confirmation is required.", {
                code: "SUPPORTER_ACCOUNT_DELETION_NOT_CONFIRMED",
                statusCode: 400
            });
        }
        const links = this.store.listWalletLinks(identity.accountId);
        const credentials = links.map(link => {
            const recoveryToken = this.tokenGenerator();
            return {
                linkId: link.linkId,
                walletId: link.walletId,
                recoveryToken,
                tokenHash: tokenHash(recoveryToken)
            };
        });
        const timestamp = this.clock().toISOString();
        const event = createSupporterAccountEvent({
            accountId: identity.accountId,
            eventType: "ACCOUNT_DELETED",
            actorType: "SUPPORTER",
            actorReference: identity.accountId,
            requestId,
            reason: "SUPPORTER_REQUESTED_DELETION",
            metadata: { walletsReturnedToGuest: credentials.length }
        }, {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        });
        const result = this.store.deleteAccount(
            identity.accountId,
            credentials,
            timestamp,
            event
        );
        return {
            deleted: result.deleted,
            guestWalletRecovery: credentials.map(item => ({
                walletId: item.walletId,
                recoveryToken: item.recoveryToken
            }))
        };
    }

    getAdministratorView(limit) {
        return this.store.getAdministratorView(limit);
    }

    setAccountStatus(accountId, status, administratorReference, reason, requestId) {
        if (!["ACTIVE", "SUSPENDED"].includes(status)) {
            throw new ApplicationError("Choose a valid supporter account status.", {
                code: "SUPPORTER_ACCOUNT_STATUS_INVALID",
                statusCode: 400
            });
        }
        if (!text(reason)) {
            throw new ApplicationError("A reason is required.", {
                code: "SUPPORTER_ACCOUNT_REASON_REQUIRED",
                statusCode: 400
            });
        }
        const current = this.store.getAccount(accountId);
        if (!current || current.status === "DELETED") {
            throw new ApplicationError("Supporter account was not found.", {
                code: "SUPPORTER_ACCOUNT_NOT_FOUND",
                statusCode: 404
            });
        }
        const event = createSupporterAccountEvent({
            accountId,
            eventType: status === "ACTIVE" ? "ACCOUNT_RESTORED" : "ACCOUNT_SUSPENDED",
            actorType: "ADMINISTRATOR",
            actorReference: administratorReference,
            requestId,
            reason: text(reason)
        }, {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        });
        return this.store.setAccountStatus(
            accountId,
            status,
            this.clock().toISOString(),
            event
        );
    }

    revokeAccountSessions(accountId, administratorReference, reason, requestId) {
        if (!text(reason)) {
            throw new ApplicationError("A reason is required.", {
                code: "SUPPORTER_ACCOUNT_REASON_REQUIRED",
                statusCode: 400
            });
        }
        const current = this.store.getAccount(accountId);
        if (!current || current.status === "DELETED") {
            throw new ApplicationError("Supporter account was not found.", {
                code: "SUPPORTER_ACCOUNT_NOT_FOUND",
                statusCode: 404
            });
        }
        const timestamp = this.clock().toISOString();
        const event = createSupporterAccountEvent({
            accountId,
            eventType: "SESSIONS_REVOKED",
            actorType: "ADMINISTRATOR",
            actorReference: administratorReference,
            requestId,
            reason: text(reason)
        }, {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        });
        return this.store.revokeAccountSessions(
            accountId,
            timestamp,
            event
        );
    }
}
