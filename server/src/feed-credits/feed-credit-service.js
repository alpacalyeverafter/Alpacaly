import { createHash, randomUUID } from "node:crypto";

import {
    FEED_CREDIT_PACKS,
    createCreditLedgerEntry,
    createCreditPurchase,
    createCreditReservation,
    createCreditWallet,
    createWalletRecoveryToken,
    getFeedCreditPack
} from "../domain/feed-credits.js";
import { ApplicationError } from "../errors/application-error.js";

const ACTIVE_RESERVATION_STATUSES = new Set([
    "WAITING",
    "YOUR_TURN",
    "CONFIRMED"
]);

function normalizedText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function tokenHash(token) {
    return createHash("sha256").update(token).digest("hex");
}

function finiteDate(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

export class FeedCreditService {
    constructor({
        eventEngine,
        contributionLedgerServices,
        store,
        config,
        logger,
        clock = () => new Date(),
        idGenerator = randomUUID,
        tokenGenerator = createWalletRecoveryToken,
        startReconciler = true
    }) {
        this.eventEngine = eventEngine;
        this.ledger = contributionLedgerServices;
        this.store = store;
        this.config = config;
        this.logger = logger;
        this.clock = clock;
        this.idGenerator = idGenerator;
        this.tokenGenerator = tokenGenerator;
        this.reconciliationTimer = null;
        this.reconciling = false;
        this.eventEngine.setLifecycleGateService(this);
        if (startReconciler) {
            this.startReconciler();
        }
    }

    getPacks() {
        return FEED_CREDIT_PACKS.map(pack => ({
            ...pack,
            currency: "GBP",
            label: `${pack.credits} Feed Credit${pack.credits === 1 ? "" : "s"}`
        }));
    }

    createWallet(payload) {
        const supporterDisplayName = normalizedText(payload?.supporterName);
        if (!supporterDisplayName || supporterDisplayName.length > 80) {
            throw new ApplicationError(
                "Enter a supporter name of 80 characters or fewer.",
                { code: "FEED_CREDIT_WALLET_INVALID", statusCode: 400 }
            );
        }
        const recoveryToken = this.tokenGenerator();
        const { wallet } = createCreditWallet({
            supporterDisplayName,
            recoveryTokenHash: tokenHash(recoveryToken)
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator,
            tokenGenerator: () => recoveryToken
        });
        const persisted = this.store.createWallet(wallet);
        this.logger.info({
            event: "feed_credit_wallet_created",
            walletId: persisted.walletId
        }, "Feed Credit wallet created");
        return {
            wallet: this.getWalletView(persisted),
            recoveryToken
        };
    }

    authenticateWallet(recoveryToken, { touch = true } = {}) {
        const token = normalizedText(recoveryToken);
        if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
            throw new ApplicationError("The Feed Credit wallet could not be recovered.", {
                code: "FEED_CREDIT_WALLET_UNAUTHORIZED",
                statusCode: 401
            });
        }
        const wallet = this.store.getWalletByTokenHash(tokenHash(token));
        if (!wallet || wallet.status !== "ACTIVE") {
            throw new ApplicationError("The Feed Credit wallet could not be recovered.", {
                code: "FEED_CREDIT_WALLET_UNAUTHORIZED",
                statusCode: 401
            });
        }
        return touch
            ? this.store.touchWallet(wallet.walletId, this.clock().toISOString())
            : wallet;
    }

    getWallet(recoveryToken) {
        this.reconcile();
        return this.getWalletView(this.authenticateWallet(recoveryToken));
    }

    preparePurchase(recoveryToken, payload) {
        const wallet = this.authenticateWallet(recoveryToken);
        const pack = getFeedCreditPack(payload?.packId);
        if (!pack) {
            throw new ApplicationError("Choose a valid Feed Credit pack.", {
                code: "FEED_CREDIT_PACK_INVALID",
                statusCode: 400
            });
        }
        const clientRequestId = normalizedText(payload?.clientRequestId);
        if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(clientRequestId)) {
            throw new ApplicationError("The purchase reference is invalid.", {
                code: "PAYMENT_REQUEST_INVALID",
                statusCode: 400
            });
        }
        return { wallet, pack, clientRequestId };
    }

    createPurchaseForPayment(paymentRequest, wallet, pack) {
        const purchase = createCreditPurchase({
            walletId: wallet.walletId,
            paymentRequestId: paymentRequest.paymentRequestId,
            packId: pack.packId
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });
        return this.store.createPaymentPurchase(paymentRequest, purchase);
    }

    applyVerifiedPurchase(paymentRequest, providerEventId) {
        const purchase = this.requirePurchase(paymentRequest.paymentRequestId);
        const entry = createCreditLedgerEntry({
            walletId: purchase.walletId,
            entryType: "PURCHASE",
            availableDelta: purchase.credits,
            paymentRequestId: purchase.paymentRequestId,
            idempotencyKey: `purchase:${purchase.paymentRequestId}`,
            reason: "VERIFIED_STRIPE_TEST_PURCHASE",
            metadata: {
                providerEventId,
                packId: purchase.packId,
                credits: purchase.credits
            }
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });
        const result = this.store.applyPurchaseCredit(
            purchase,
            entry,
            this.clock().toISOString(),
            providerEventId
        );
        this.logger.info({
            event: "feed_credits_purchased",
            walletId: purchase.walletId,
            paymentRequestId: purchase.paymentRequestId,
            credits: purchase.credits,
            duplicate: result.duplicate
        }, "Verified Stripe Test purchase credited to wallet");
        return result;
    }

    createReservation(recoveryToken, payload) {
        this.reconcile();
        const wallet = this.authenticateWallet(recoveryToken);
        const clientRequestId = normalizedText(payload?.clientRequestId);
        if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(clientRequestId)) {
            throw new ApplicationError("The feed request reference is invalid.", {
                code: "FEED_CREDIT_RESERVATION_INVALID",
                statusCode: 400
            });
        }
        const existing = this.store.getReservationByClient(
            wallet.walletId,
            clientRequestId
        );
        if (existing) {
            return { reservation: this.getReservationView(existing), duplicate: true };
        }
        const reservation = createCreditReservation({
            walletId: wallet.walletId,
            clientRequestId
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator,
            lifetimeMs: this.config.feedCreditReservationLifetimeMs
        });
        const entry = createCreditLedgerEntry({
            walletId: wallet.walletId,
            entryType: "RESERVATION",
            availableDelta: -1,
            reservedDelta: 1,
            reservationId: reservation.reservationId,
            idempotencyKey: `reservation:${reservation.reservationId}`,
            reason: "SUPPORTER_REQUESTED_FEED"
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });

        let created;
        try {
            created = this.store.createReservation(reservation, entry);
        } catch (error) {
            if ([
                "FEED_CREDIT_BALANCE_INSUFFICIENT",
                "FEED_CREDIT_ACTIVE_RESERVATION_EXISTS"
            ].includes(error?.code)) {
                throw new ApplicationError(
                    error.code === "FEED_CREDIT_BALANCE_INSUFFICIENT"
                        ? "You need an available Feed Credit."
                        : "This wallet already has an active feed request.", {
                    code: error.code,
                    statusCode: 409
                });
            }
            throw error;
        }
        if (created.duplicate) {
            return {
                reservation: this.getReservationView(created.reservation),
                duplicate: true
            };
        }

        try {
            const ingestion = this.ledger.providerEventIngestionService.ingest({
                provider: "WEBSITE",
                externalEventId: `feed_credit:${reservation.reservationId}`,
                receivedAt: this.clock().toISOString(),
                rawMetadata: {
                    feedCredit: true,
                    reservationId: reservation.reservationId,
                    walletId: wallet.walletId,
                    message: "Feed Credit request"
                }
            });
            const verification = this.ledger.contributionVerificationService.verify(
                ingestion.providerEvent.providerEventId,
                {
                    verified: true,
                    eligible: true,
                    amountMinor: 0,
                    currency: "GBP",
                    supporterDisplayName: wallet.supporterDisplayName,
                    feedQuantity: 1,
                    metadata: {
                        feedCredit: true,
                        reservationId: reservation.reservationId,
                        walletId: wallet.walletId
                    },
                    feederId: this.eventEngine.getDefaultFeederId(),
                    message: "Feed Credit request"
                }
            );
            this.store.linkReservationDomain(reservation.reservationId, {
                contributionId: verification.contribution.contributionId,
                feedIntentId: verification.feedIntent.feedIntentId,
                updatedAt: this.clock().toISOString()
            });
            const feedResult = this.ledger.outboxWorker.processFeedIntent(
                verification.feedIntent.feedIntentId
            );
            if (feedResult?.feedRequest) {
                this.store.linkReservationEvent(
                    reservation.reservationId,
                    feedResult.feedRequest.eventId,
                    this.clock().toISOString()
                );
            }
        } catch (error) {
            this.releaseReservation(reservation.reservationId, {
                reason: error.code || "FEED_REQUEST_NOT_ACCEPTED",
                cancelEvent: true
            });
            throw error;
        }

        const persisted = this.store.getReservation(reservation.reservationId);
        return { reservation: this.getReservationView(persisted), duplicate: false };
    }

    heartbeat(recoveryToken, reservationId, { active = true } = {}) {
        const wallet = this.authenticateWallet(recoveryToken);
        const reservation = this.requireOwnedReservation(wallet, reservationId);
        if (!active || !ACTIVE_RESERVATION_STATUSES.has(reservation.status)) {
            return this.getReservationView(reservation);
        }
        const updated = this.store.heartbeat(
            reservation.reservationId,
            wallet.walletId,
            this.clock().toISOString()
        );
        return this.getReservationView(updated);
    }

    confirm(recoveryToken, reservationId) {
        this.reconcile();
        const wallet = this.authenticateWallet(recoveryToken);
        const reservation = this.requireOwnedReservation(wallet, reservationId);
        if (reservation.status === "CONFIRMED") {
            return { reservation: this.getReservationView(reservation), duplicate: true };
        }
        if (reservation.status !== "YOUR_TURN") {
            throw new ApplicationError("This feed is not ready for confirmation.", {
                code: "FEED_CREDIT_NOT_YOUR_TURN",
                statusCode: 409
            });
        }
        const now = this.clock();
        const minimumHeartbeatAt = new Date(
            now.getTime() - this.config.feedCreditPresenceTtlMs
        ).toISOString();
        const result = this.store.confirmReservation(
            reservation.reservationId,
            wallet.walletId,
            {
                confirmedAt: now.toISOString(),
                minimumHeartbeatAt
            }
        );
        if (!result.changed) {
            throw new ApplicationError(
                "Keep this page active and confirm before your turn expires.",
                {
                    code: "FEED_CREDIT_CONFIRMATION_EXPIRED",
                    statusCode: 409
                }
            );
        }
        const feedRequest = this.getFeedRequestForReservation(result.reservation);
        if (!feedRequest || feedRequest.queuePosition !== 1) {
            this.releaseReservation(reservation.reservationId, {
                reason: "FEED_CREDIT_QUEUE_CHANGED",
                cancelEvent: true
            });
            throw new ApplicationError("The feed queue changed before confirmation.", {
                code: "FEED_CREDIT_QUEUE_CHANGED",
                statusCode: 409
            });
        }
        if (this.eventEngine.getSnapshot().availability?.available === false) {
            this.releaseReservation(reservation.reservationId, {
                reason: "FEEDER_UNAVAILABLE_BEFORE_COUNTDOWN",
                cancelEvent: true
            });
            throw new ApplicationError(
                "Feeding is temporarily unavailable. Your Feed Credit was returned.",
                { code: "FEEDER_UNAVAILABLE", statusCode: 409 }
            );
        }
        this.eventEngine.resumeLifecycle(feedRequest.eventId);
        return {
            reservation: this.getReservationView(result.reservation),
            duplicate: false
        };
    }

    cancel(recoveryToken, reservationId) {
        const wallet = this.authenticateWallet(recoveryToken);
        const reservation = this.requireOwnedReservation(wallet, reservationId);
        if (!["WAITING", "YOUR_TURN"].includes(reservation.status)) {
            throw new ApplicationError(
                "This feed can no longer be cancelled automatically.",
                { code: "FEED_CREDIT_CANCEL_NOT_ALLOWED", statusCode: 409 }
            );
        }
        return this.getReservationView(this.releaseReservation(reservationId, {
            reason: "SUPPORTER_CANCELLED",
            cancelEvent: true
        }).reservation);
    }

    evaluateLifecycleGate(feedRequest) {
        const reservation = this.store.getReservationByFeedIntent(
            feedRequest.feedIntentId
        );
        if (!reservation) {
            return { required: false, allowed: true };
        }
        if (!reservation.eventId) {
            this.store.linkReservationEvent(
                reservation.reservationId,
                feedRequest.eventId,
                this.clock().toISOString()
            );
        }
        const current = this.store.getReservation(reservation.reservationId);
        if (current.status === "CONFIRMED") {
            return { required: true, allowed: true, reservationId: current.reservationId };
        }
        if (["RELEASED", "OUTCOME_UNKNOWN"].includes(current.status)) {
            return {
                required: true,
                allowed: false,
                cancel: current.status === "RELEASED",
                reason: current.releaseReason || current.status,
                reservationId: current.reservationId
            };
        }
        if (current.status === "REDEEMED") {
            return { required: true, allowed: true, reservationId: current.reservationId };
        }
        const now = this.clock();
        if (
            current.status === "WAITING"
            && finiteDate(current.expiresAt) <= now.getTime()
        ) {
            const released = this.releaseReservation(current.reservationId, {
                reason: "QUEUE_RESERVATION_EXPIRED",
                cancelEvent: false
            }).reservation;
            return {
                required: true,
                allowed: false,
                cancel: true,
                reason: released.releaseReason,
                reservationId: released.reservationId
            };
        }
        let waiting = current;
        if (current.status === "WAITING") {
            waiting = this.store.markTurn(current.reservationId, {
                turnStartedAt: now.toISOString(),
                confirmationExpiresAt: new Date(
                    now.getTime() + this.config.feedCreditConfirmationTimeoutMs
                ).toISOString()
            });
        }
        if (
            waiting.status === "YOUR_TURN"
            && finiteDate(waiting.confirmationExpiresAt) <= now.getTime()
        ) {
            const released = this.releaseReservation(waiting.reservationId, {
                reason: "SUPPORTER_CONFIRMATION_TIMEOUT",
                cancelEvent: false
            }).reservation;
            return {
                required: true,
                allowed: false,
                cancel: true,
                reason: released.releaseReason,
                reservationId: released.reservationId
            };
        }
        return {
            required: true,
            allowed: false,
            awaitingConfirmation: true,
            reservationId: waiting.reservationId,
            confirmationExpiresAt: waiting.confirmationExpiresAt
        };
    }

    onLifecycleTransition(feedRequest, state) {
        if (state !== "COMPLETE") {
            return;
        }
        const reservation = this.store.getReservationByFeedIntent(
            feedRequest.feedIntentId
        );
        if (!reservation || reservation.status !== "CONFIRMED") {
            return;
        }
        const entry = createCreditLedgerEntry({
            walletId: reservation.walletId,
            entryType: "REDEMPTION",
            reservedDelta: -1,
            spentDelta: 1,
            reservationId: reservation.reservationId,
            eventId: feedRequest.eventId,
            idempotencyKey: `redemption:${reservation.reservationId}`,
            reason: "SIMULATED_FEED_SAFELY_CONFIRMED"
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });
        this.store.redeemReservation(
            reservation.reservationId,
            entry,
            this.clock().toISOString()
        );
    }

    onLifecycleFailure(feedRequest, error) {
        if (error?.code !== "DEVICE_COMMAND_OUTCOME_UNKNOWN") {
            return;
        }
        const reservation = this.store.getReservationByFeedIntent(
            feedRequest.feedIntentId
        );
        if (reservation?.status === "CONFIRMED") {
            this.store.markOutcomeUnknown(
                reservation.reservationId,
                "DEVICE_COMMAND_OUTCOME_UNKNOWN",
                this.clock().toISOString()
            );
        }
    }

    onLifecycleCancellation(feedRequest, reason) {
        const reservation = this.store.getReservationByFeedIntent(
            feedRequest.feedIntentId
        );
        if (!reservation || !ACTIVE_RESERVATION_STATUSES.has(reservation.status)) {
            return;
        }
        if (["BELL", "DISPENSING", "COMPLETE", "ARCHIVED"].includes(
            feedRequest.state
        )) {
            this.store.markOutcomeUnknown(
                reservation.reservationId,
                "CREDIT_RELEASE_BLOCKED_AFTER_DISPATCH",
                this.clock().toISOString()
            );
            return;
        }
        this.releaseReservation(reservation.reservationId, {
            reason: reason || "FEED_CANCELLED_BEFORE_DISPENSE",
            cancelEvent: false
        });
    }

    releaseReservation(reservationId, { reason, cancelEvent = true } = {}) {
        const reservation = this.store.getReservation(reservationId);
        if (!reservation) {
            throw new ApplicationError("Feed Credit reservation not found.", {
                code: "FEED_CREDIT_RESERVATION_NOT_FOUND",
                statusCode: 404
            });
        }
        if (["RELEASED", "REDEEMED", "OUTCOME_UNKNOWN"].includes(
            reservation.status
        )) {
            return { reservation, duplicate: true };
        }
        const feedRequest = this.getFeedRequestForReservation(reservation);
        if (cancelEvent && feedRequest) {
            const cancelled = this.eventEngine.cancelBeforeDispense(
                feedRequest.eventId,
                reason || "FEED_CREDIT_RELEASED"
            );
            if (!cancelled) {
                return {
                    reservation: this.store.markOutcomeUnknown(
                        reservation.reservationId,
                        "CREDIT_RELEASE_BLOCKED_AFTER_DISPATCH",
                        this.clock().toISOString()
                    ),
                    duplicate: false
                };
            }
        }
        const entry = createCreditLedgerEntry({
            walletId: reservation.walletId,
            entryType: "RELEASE",
            availableDelta: 1,
            reservedDelta: -1,
            reservationId: reservation.reservationId,
            eventId: reservation.eventId,
            idempotencyKey: `release:${reservation.reservationId}`,
            reason: reason || "FEED_DID_NOT_OCCUR"
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });
        return this.store.releaseReservation(
            reservation.reservationId,
            entry,
            reason || "FEED_DID_NOT_OCCUR",
            this.clock().toISOString()
        );
    }

    applyPaymentAdjustment(paymentRequest, eventType) {
        const purchase = this.store.getPurchaseByPaymentRequest(
            paymentRequest.paymentRequestId
        );
        if (!purchase || purchase.status === "PENDING") {
            return null;
        }
        this.store.listActiveReservations()
            .filter(reservation => reservation.walletId === purchase.walletId)
            .filter(reservation => ["WAITING", "YOUR_TURN"].includes(
                reservation.status
            ))
            .forEach(reservation => {
                this.releaseReservation(reservation.reservationId, {
                    reason: eventType === "DISPUTED"
                        ? "PAYMENT_DISPUTED"
                        : "PAYMENT_REFUNDED",
                    cancelEvent: true
                });
            });
        const remainingAdjustment = Math.max(
            0,
            purchase.credits - purchase.adjustedCredits
        );
        const balance = this.store.getBalance(purchase.walletId);
        const appliedCredits = Math.min(balance.available, remainingAdjustment);
        const entry = createCreditLedgerEntry({
            walletId: purchase.walletId,
            entryType: "REFUND_ADJUSTMENT",
            availableDelta: -appliedCredits,
            paymentRequestId: purchase.paymentRequestId,
            idempotencyKey: `payment-adjustment:${eventType}:${purchase.paymentRequestId}`,
            reason: eventType === "DISPUTED" ? "PAYMENT_DISPUTED" : "PAYMENT_REFUNDED",
            metadata: {
                requestedCredits: remainingAdjustment,
                appliedCredits,
                unrecoupedCredits: remainingAdjustment - appliedCredits,
                physicalActionsReversed: false
            }
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });
        return this.store.applyPurchaseAdjustment(purchase, entry, {
            adjustedCredits: remainingAdjustment,
            status: eventType === "DISPUTED" ? "DISPUTED" : "REFUNDED",
            updatedAt: this.clock().toISOString()
        });
    }

    applyAdministrativeCorrection(walletId, input, administratorReference) {
        const wallet = this.store.getWallet(walletId);
        if (!wallet) {
            throw new ApplicationError("Feed Credit wallet not found.", {
                code: "FEED_CREDIT_WALLET_NOT_FOUND",
                statusCode: 404
            });
        }
        const creditDelta = Number(input?.creditDelta);
        const reason = normalizedText(input?.reason);
        const clientRequestId = normalizedText(input?.clientRequestId);
        if (
            !Number.isSafeInteger(creditDelta)
            || creditDelta === 0
            || Math.abs(creditDelta) > 100
            || reason.length < 8
            || reason.length > 500
            || !/^[A-Za-z0-9_.:-]{8,120}$/.test(clientRequestId)
        ) {
            throw new ApplicationError("The Feed Credit correction is invalid.", {
                code: "FEED_CREDIT_CORRECTION_INVALID",
                statusCode: 400
            });
        }
        const entry = createCreditLedgerEntry({
            walletId,
            entryType: "ADMIN_CORRECTION",
            availableDelta: creditDelta,
            idempotencyKey: `admin-correction:${clientRequestId}`,
            reason,
            metadata: { administratorReference }
        }, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });
        try {
            return this.store.appendAdministrativeCorrection(entry);
        } catch (error) {
            if (error?.code === "FEED_CREDIT_CORRECTION_INVALID") {
                throw new ApplicationError(error.message, {
                    code: error.code,
                    statusCode: 409
                });
            }
            throw error;
        }
    }

    getAdministratorView({ limit = 100 } = {}) {
        return {
            wallets: this.store.listWallets(limit).map(wallet => ({
                ...this.getWalletView(wallet, { includeLedger: false }),
                recoveryToken: undefined
            })),
            purchases: this.store.listPurchases(limit),
            reservations: this.store.listReservations(limit).map(
                reservation => this.getReservationView(reservation)
            ),
            ledgerEntries: this.store.listLedger(limit)
        };
    }

    reconcile() {
        if (this.reconciling || this.eventEngine.eventStore.closed) {
            return [];
        }
        this.reconciling = true;
        const actions = [];
        try {
            const now = this.clock().getTime();
            this.store.listActiveReservations().forEach(reservation => {
                let current = reservation;
                if (!current.eventId && current.feedIntentId) {
                    const eventId = this.eventEngine.eventStore.getEventIdByFeedIntent(
                        current.feedIntentId
                    );
                    if (eventId) {
                        current = this.store.linkReservationEvent(
                            current.reservationId,
                            eventId,
                            this.clock().toISOString()
                        );
                    }
                }
                const feedRequest = this.getFeedRequestForReservation(current);
                if (current.status === "CONFIRMED" && feedRequest) {
                    if (["COMPLETE", "ARCHIVED"].includes(feedRequest.lifecycleState)) {
                        this.onLifecycleTransition(feedRequest, "COMPLETE");
                        actions.push({ reservationId: current.reservationId, action: "REDEEMED" });
                        return;
                    }
                    if (
                        feedRequest.safetyState
                        && !["BELL", "DISPENSING", "COMPLETE", "ARCHIVED"].includes(
                            feedRequest.lifecycleState
                        )
                    ) {
                        this.releaseReservation(current.reservationId, {
                            reason: feedRequest.safetyState,
                            cancelEvent: false
                        });
                        actions.push({ reservationId: current.reservationId, action: "RELEASED" });
                    }
                    return;
                }
                const expired = current.status === "YOUR_TURN"
                    ? finiteDate(current.confirmationExpiresAt) <= now
                    : finiteDate(current.expiresAt) <= now;
                if (expired) {
                    this.releaseReservation(current.reservationId, {
                        reason: current.status === "YOUR_TURN"
                            ? "SUPPORTER_CONFIRMATION_TIMEOUT"
                            : "QUEUE_RESERVATION_EXPIRED",
                        cancelEvent: true
                    });
                    actions.push({ reservationId: current.reservationId, action: "RELEASED" });
                }
            });
        } finally {
            this.reconciling = false;
        }
        return actions;
    }

    startReconciler() {
        if (this.reconciliationTimer) {
            return;
        }
        this.reconciliationTimer = setInterval(() => {
            try {
                this.reconcile();
            } catch (error) {
                this.logger.error({
                    event: "feed_credit_reconciliation_failed",
                    err: error
                }, "Feed Credit reconciliation failed safely");
            }
        }, this.config.feedCreditReconciliationIntervalMs);
        this.reconciliationTimer.unref?.();
    }

    stop() {
        if (this.reconciliationTimer) {
            clearInterval(this.reconciliationTimer);
            this.reconciliationTimer = null;
        }
    }

    getWalletView(wallet, { includeLedger = true } = {}) {
        const balance = this.store.getBalance(wallet.walletId);
        return {
            walletId: wallet.walletId,
            supporterDisplayName: wallet.supporterDisplayName,
            status: wallet.status,
            balance,
            purchases: this.store.listPurchasesForWallet(wallet.walletId),
            reservations: this.store.listReservationsForWallet(wallet.walletId)
                .map(reservation => this.getReservationView(reservation)),
            ledgerEntries: includeLedger
                ? this.store.listLedgerForWallet(wallet.walletId)
                : undefined,
            lastSeenAt: wallet.lastSeenAt,
            updatedAt: wallet.updatedAt
        };
    }

    getReservationView(reservation) {
        const feedRequest = this.getFeedRequestForReservation(reservation);
        return {
            reservationId: reservation.reservationId,
            status: reservation.status,
            expiresAt: reservation.expiresAt,
            confirmationExpiresAt: reservation.confirmationExpiresAt,
            createdAt: reservation.createdAt,
            updatedAt: reservation.updatedAt,
            releaseReason: reservation.releaseReason,
            event: feedRequest ? {
                eventId: feedRequest.eventId,
                state: reservation.status === "YOUR_TURN"
                    ? "AWAITING_SUPPORTER_CONFIRMATION"
                    : feedRequest.state,
                lifecycleState: feedRequest.state,
                safetyState: feedRequest.safetyState || null,
                queuePosition: feedRequest.queuePosition,
                estimatedWaitMs: feedRequest.estimatedWaitMs
            } : null,
            message: this.reservationMessage(reservation, feedRequest)
        };
    }

    reservationMessage(reservation, feedRequest) {
        switch (reservation.status) {
            case "WAITING":
                return feedRequest?.queuePosition
                    ? `You are number ${feedRequest.queuePosition} in the feed queue.`
                    : "Your Feed Credit is reserved while the Event Engine prepares the request.";
            case "YOUR_TURN":
                return "It is your turn. Keep this page active and confirm to start the 10-second countdown.";
            case "CONFIRMED":
                return "Your feed is confirmed. The existing safety-controlled lifecycle is running.";
            case "REDEEMED":
                return "The simulated feed was safely confirmed and one Feed Credit was spent.";
            case "RELEASED":
                return "No feed occurred and the reserved Feed Credit was returned.";
            case "OUTCOME_UNKNOWN":
                return "The feed outcome is uncertain. The credit remains reserved for operator review and is not automatically reissued.";
            default:
                return "Feed Credit status is available.";
        }
    }

    getFeedRequestForReservation(reservation) {
        const eventId = reservation?.eventId || (
            reservation?.feedIntentId
                ? this.eventEngine.eventStore.getEventIdByFeedIntent(
                    reservation.feedIntentId
                )
                : null
        );
        return eventId ? this.eventEngine.getFeedRequest(eventId) : null;
    }

    requirePurchase(paymentRequestId) {
        const purchase = this.store.getPurchaseByPaymentRequest(paymentRequestId);
        if (!purchase) {
            throw new ApplicationError("Feed Credit purchase not found.", {
                code: "FEED_CREDIT_PURCHASE_NOT_FOUND",
                statusCode: 404
            });
        }
        return purchase;
    }

    requireOwnedReservation(wallet, reservationId) {
        const reservation = this.store.getReservation(normalizedText(reservationId));
        if (!reservation || reservation.walletId !== wallet.walletId) {
            throw new ApplicationError("Feed Credit reservation not found.", {
                code: "FEED_CREDIT_RESERVATION_NOT_FOUND",
                statusCode: 404
            });
        }
        return reservation;
    }
}
