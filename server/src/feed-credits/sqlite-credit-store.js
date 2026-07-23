function parseJson(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    return typeof value === "string" ? JSON.parse(value) : value;
}

function mapWallet(row) {
    return row ? { ...row } : null;
}

function mapPurchase(row) {
    return row ? {
        ...row,
        credits: Number(row.credits),
        amountMinor: Number(row.amountMinor),
        adjustedCredits: Number(row.adjustedCredits)
    } : null;
}

function mapReservation(row) {
    return row ? { ...row } : null;
}

function mapLedgerEntry(row) {
    return row ? {
        ...row,
        ledgerSequence: Number(row.ledgerSequence),
        availableDelta: Number(row.availableDelta),
        reservedDelta: Number(row.reservedDelta),
        spentDelta: Number(row.spentDelta),
        metadata: parseJson(row.metadataJson)
    } : null;
}

export class SqliteCreditStore {
    constructor({ eventStore }) {
        this.eventStore = eventStore;
        this.database = eventStore.database;
        this.statements = {
            insertWallet: this.database.prepare(`
                INSERT INTO CreditWallets (
                    walletId, recoveryTokenHash, supporterDisplayName, status,
                    createdAt, updatedAt, lastSeenAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `),
            selectWalletById: this.database.prepare(`
                SELECT * FROM CreditWallets WHERE walletId = ?
            `),
            selectWalletByToken: this.database.prepare(`
                SELECT * FROM CreditWallets WHERE recoveryTokenHash = ?
            `),
            touchWallet: this.database.prepare(`
                UPDATE CreditWallets SET lastSeenAt = ?, updatedAt = ?
                WHERE walletId = ? AND status = 'ACTIVE'
            `),
            insertPurchase: this.database.prepare(`
                INSERT INTO CreditPurchases (
                    purchaseId, walletId, paymentRequestId, packId, credits,
                    amountMinor, currency, status, creditedAt, adjustedCredits,
                    createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            selectPurchaseByPayment: this.database.prepare(`
                SELECT * FROM CreditPurchases WHERE paymentRequestId = ?
            `),
            selectPurchasesByWallet: this.database.prepare(`
                SELECT * FROM CreditPurchases WHERE walletId = ?
                ORDER BY createdAt DESC, purchaseId DESC LIMIT ?
            `),
            listPurchases: this.database.prepare(`
                SELECT * FROM CreditPurchases
                ORDER BY createdAt DESC, purchaseId DESC LIMIT ?
            `),
            creditPurchase: this.database.prepare(`
                UPDATE CreditPurchases
                SET status = 'CREDITED', creditedAt = ?, updatedAt = ?
                WHERE paymentRequestId = ? AND status = 'PENDING'
            `),
            verifyProviderEvent: this.database.prepare(`
                UPDATE ProviderEvents
                SET verificationStatus = 'VERIFIED', rejectionReason = NULL, updatedAt = ?
                WHERE providerEventId = ? AND verificationStatus = 'PENDING'
            `),
            updatePurchaseAdjustment: this.database.prepare(`
                UPDATE CreditPurchases
                SET status = ?, adjustedCredits = adjustedCredits + ?, updatedAt = ?
                WHERE paymentRequestId = ?
                  AND adjustedCredits + ? <= credits
            `),
            insertReservation: this.database.prepare(`
                INSERT INTO CreditReservations (
                    reservationId, walletId, clientRequestId, status,
                    contributionId, feedIntentId, eventId, expiresAt,
                    turnStartedAt, confirmationExpiresAt, confirmedAt,
                    redeemedAt, releasedAt, releaseReason, lastHeartbeatAt,
                    createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            selectReservationById: this.database.prepare(`
                SELECT * FROM CreditReservations WHERE reservationId = ?
            `),
            selectReservationByClient: this.database.prepare(`
                SELECT * FROM CreditReservations
                WHERE walletId = ? AND clientRequestId = ?
            `),
            selectActiveReservationByWallet: this.database.prepare(`
                SELECT * FROM CreditReservations
                WHERE walletId = ?
                  AND status IN ('WAITING', 'YOUR_TURN', 'CONFIRMED', 'OUTCOME_UNKNOWN')
                ORDER BY createdAt ASC LIMIT 1
            `),
            selectReservationByFeedIntent: this.database.prepare(`
                SELECT * FROM CreditReservations WHERE feedIntentId = ?
            `),
            selectReservationByEvent: this.database.prepare(`
                SELECT * FROM CreditReservations WHERE eventId = ?
            `),
            selectReservationsByWallet: this.database.prepare(`
                SELECT * FROM CreditReservations WHERE walletId = ?
                ORDER BY createdAt DESC, reservationId DESC LIMIT ?
            `),
            listReservations: this.database.prepare(`
                SELECT * FROM CreditReservations
                ORDER BY createdAt DESC, reservationId DESC LIMIT ?
            `),
            listActiveReservations: this.database.prepare(`
                SELECT * FROM CreditReservations
                WHERE status IN ('WAITING', 'YOUR_TURN', 'CONFIRMED')
                ORDER BY createdAt ASC, reservationId ASC
            `),
            linkReservationDomain: this.database.prepare(`
                UPDATE CreditReservations
                SET contributionId = ?, feedIntentId = ?, eventId = ?, updatedAt = ?
                WHERE reservationId = ?
                  AND status IN ('WAITING', 'YOUR_TURN')
            `),
            linkReservationEvent: this.database.prepare(`
                UPDATE CreditReservations SET eventId = ?, updatedAt = ?
                WHERE reservationId = ? AND eventId IS NULL
            `),
            markTurn: this.database.prepare(`
                UPDATE CreditReservations
                SET status = 'YOUR_TURN', turnStartedAt = ?,
                    confirmationExpiresAt = ?, updatedAt = ?
                WHERE reservationId = ? AND status = 'WAITING'
            `),
            heartbeat: this.database.prepare(`
                UPDATE CreditReservations
                SET lastHeartbeatAt = ?, updatedAt = ?
                WHERE reservationId = ? AND walletId = ?
                  AND status IN ('WAITING', 'YOUR_TURN', 'CONFIRMED')
            `),
            confirmReservation: this.database.prepare(`
                UPDATE CreditReservations
                SET status = 'CONFIRMED', confirmedAt = ?, updatedAt = ?
                WHERE reservationId = ? AND walletId = ?
                  AND status = 'YOUR_TURN'
                  AND confirmationExpiresAt >= ?
                  AND lastHeartbeatAt >= ?
            `),
            releaseReservation: this.database.prepare(`
                UPDATE CreditReservations
                SET status = 'RELEASED', releasedAt = ?, releaseReason = ?, updatedAt = ?
                WHERE reservationId = ?
                  AND status IN ('WAITING', 'YOUR_TURN', 'CONFIRMED')
            `),
            redeemReservation: this.database.prepare(`
                UPDATE CreditReservations
                SET status = 'REDEEMED', redeemedAt = ?, updatedAt = ?
                WHERE reservationId = ? AND status = 'CONFIRMED'
            `),
            markOutcomeUnknown: this.database.prepare(`
                UPDATE CreditReservations
                SET status = 'OUTCOME_UNKNOWN', releaseReason = ?, updatedAt = ?
                WHERE reservationId = ? AND status = 'CONFIRMED'
            `),
            insertLedger: this.database.prepare(`
                INSERT INTO CreditLedgerEntries (
                    ledgerEntryId, walletId, entryType, availableDelta,
                    reservedDelta, spentDelta, paymentRequestId, reservationId,
                    eventId, idempotencyKey, reason, metadataJson, createdAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (idempotencyKey) DO NOTHING
            `),
            selectLedgerByIdempotency: this.database.prepare(`
                SELECT * FROM CreditLedgerEntries WHERE idempotencyKey = ?
            `),
            selectLedgerByWallet: this.database.prepare(`
                SELECT * FROM CreditLedgerEntries WHERE walletId = ?
                ORDER BY ledgerSequence DESC LIMIT ?
            `),
            listLedger: this.database.prepare(`
                SELECT * FROM CreditLedgerEntries
                ORDER BY ledgerSequence DESC LIMIT ?
            `),
            selectBalance: this.database.prepare(`
                SELECT
                    COALESCE(SUM(availableDelta), 0) AS available,
                    COALESCE(SUM(reservedDelta), 0) AS reserved,
                    COALESCE(SUM(spentDelta), 0) AS spent
                FROM CreditLedgerEntries WHERE walletId = ?
            `),
            listWallets: this.database.prepare(`
                SELECT * FROM CreditWallets
                ORDER BY updatedAt DESC, walletId DESC LIMIT ?
            `)
        };
    }

    createWallet(wallet) {
        this.statements.insertWallet.run(
            wallet.walletId,
            wallet.recoveryTokenHash,
            wallet.supporterDisplayName,
            wallet.status,
            wallet.createdAt,
            wallet.updatedAt,
            wallet.lastSeenAt
        );
        return this.getWallet(wallet.walletId);
    }

    getWallet(walletId) {
        return mapWallet(this.statements.selectWalletById.get(walletId));
    }

    getWalletByTokenHash(recoveryTokenHash) {
        return mapWallet(this.statements.selectWalletByToken.get(recoveryTokenHash));
    }

    touchWallet(walletId, timestamp) {
        this.statements.touchWallet.run(timestamp, timestamp, walletId);
        return this.getWallet(walletId);
    }

    createPaymentPurchase(paymentRequest, purchase) {
        return this.eventStore.transaction(() => {
            this.eventStore.createPaymentRequest(paymentRequest);
            this.statements.insertPurchase.run(
                purchase.purchaseId,
                purchase.walletId,
                purchase.paymentRequestId,
                purchase.packId,
                purchase.credits,
                purchase.amountMinor,
                purchase.currency,
                purchase.status,
                purchase.creditedAt,
                purchase.adjustedCredits,
                purchase.createdAt,
                purchase.updatedAt
            );
            return mapPurchase(
                this.statements.selectPurchaseByPayment.get(purchase.paymentRequestId)
            );
        });
    }

    getPurchaseByPaymentRequest(paymentRequestId) {
        return mapPurchase(this.statements.selectPurchaseByPayment.get(paymentRequestId));
    }

    listPurchasesForWallet(walletId, limit = 100) {
        return this.statements.selectPurchasesByWallet
            .all(walletId, Math.min(500, Math.max(1, Number(limit) || 100)))
            .map(mapPurchase);
    }

    listPurchases(limit = 100) {
        return this.statements.listPurchases
            .all(Math.min(500, Math.max(1, Number(limit) || 100)))
            .map(mapPurchase);
    }

    applyPurchaseCredit(purchase, ledgerEntry, timestamp, providerEventId) {
        return this.eventStore.transaction(() => {
            const existing = this.getLedgerEntry(ledgerEntry.idempotencyKey);
            if (existing) {
                return { purchase: this.getPurchaseByPaymentRequest(
                    purchase.paymentRequestId
                ), ledgerEntry: existing, duplicate: true };
            }
            const updated = this.statements.creditPurchase.run(
                timestamp,
                timestamp,
                purchase.paymentRequestId
            );
            if (Number(updated.changes) !== 1) {
                const current = this.getPurchaseByPaymentRequest(
                    purchase.paymentRequestId
                );
                if (current?.status !== "CREDITED") {
                    throw new Error("The credit purchase could not be completed safely.");
                }
            }
            const eventUpdate = this.statements.verifyProviderEvent.run(
                timestamp,
                providerEventId
            );
            if (Number(eventUpdate.changes) !== 1) {
                const providerEvent = this.eventStore.getProviderEvent(providerEventId);
                if (providerEvent?.verificationStatus !== "VERIFIED") {
                    throw new Error(
                        "The Stripe ProviderEvent could not be verified for the credit purchase."
                    );
                }
            }
            this.insertLedger(ledgerEntry);
            return {
                purchase: this.getPurchaseByPaymentRequest(purchase.paymentRequestId),
                ledgerEntry: this.getLedgerEntry(ledgerEntry.idempotencyKey),
                duplicate: false
            };
        });
    }

    createReservation(reservation, ledgerEntry) {
        return this.eventStore.transaction(() => {
            const duplicate = this.statements.selectReservationByClient.get(
                reservation.walletId,
                reservation.clientRequestId
            );
            if (duplicate) {
                return { reservation: mapReservation(duplicate), duplicate: true };
            }
            const active = this.statements.selectActiveReservationByWallet.get(
                reservation.walletId
            );
            if (active) {
                const error = new Error("This wallet already has an active feed request.");
                error.code = "FEED_CREDIT_ACTIVE_RESERVATION_EXISTS";
                throw error;
            }
            const balance = this.getBalance(reservation.walletId);
            if (balance.available < 1) {
                const error = new Error("No available Feed Credit remains.");
                error.code = "FEED_CREDIT_BALANCE_INSUFFICIENT";
                throw error;
            }
            this.statements.insertReservation.run(
                reservation.reservationId,
                reservation.walletId,
                reservation.clientRequestId,
                reservation.status,
                reservation.contributionId,
                reservation.feedIntentId,
                reservation.eventId,
                reservation.expiresAt,
                reservation.turnStartedAt,
                reservation.confirmationExpiresAt,
                reservation.confirmedAt,
                reservation.redeemedAt,
                reservation.releasedAt,
                reservation.releaseReason,
                reservation.lastHeartbeatAt,
                reservation.createdAt,
                reservation.updatedAt
            );
            this.insertLedger(ledgerEntry);
            return {
                reservation: this.getReservation(reservation.reservationId),
                duplicate: false
            };
        });
    }

    linkReservationDomain(reservationId, {
        contributionId,
        feedIntentId,
        eventId = null,
        updatedAt
    }) {
        this.statements.linkReservationDomain.run(
            contributionId,
            feedIntentId,
            eventId,
            updatedAt,
            reservationId
        );
        return this.getReservation(reservationId);
    }

    linkReservationEvent(reservationId, eventId, updatedAt) {
        this.statements.linkReservationEvent.run(eventId, updatedAt, reservationId);
        return this.getReservation(reservationId);
    }

    getReservation(reservationId) {
        return mapReservation(this.statements.selectReservationById.get(reservationId));
    }

    getReservationByClient(walletId, clientRequestId) {
        return mapReservation(
            this.statements.selectReservationByClient.get(walletId, clientRequestId)
        );
    }

    getReservationByFeedIntent(feedIntentId) {
        return mapReservation(
            this.statements.selectReservationByFeedIntent.get(feedIntentId)
        );
    }

    getReservationByEvent(eventId) {
        return mapReservation(this.statements.selectReservationByEvent.get(eventId));
    }

    listReservationsForWallet(walletId, limit = 100) {
        return this.statements.selectReservationsByWallet
            .all(walletId, Math.min(500, Math.max(1, Number(limit) || 100)))
            .map(mapReservation);
    }

    listReservations(limit = 100) {
        return this.statements.listReservations
            .all(Math.min(500, Math.max(1, Number(limit) || 100)))
            .map(mapReservation);
    }

    listActiveReservations() {
        return this.statements.listActiveReservations.all().map(mapReservation);
    }

    markTurn(reservationId, { turnStartedAt, confirmationExpiresAt }) {
        this.statements.markTurn.run(
            turnStartedAt,
            confirmationExpiresAt,
            turnStartedAt,
            reservationId
        );
        return this.getReservation(reservationId);
    }

    heartbeat(reservationId, walletId, timestamp) {
        this.statements.heartbeat.run(timestamp, timestamp, reservationId, walletId);
        return this.getReservation(reservationId);
    }

    confirmReservation(reservationId, walletId, {
        confirmedAt,
        minimumHeartbeatAt
    }) {
        const result = this.statements.confirmReservation.run(
            confirmedAt,
            confirmedAt,
            reservationId,
            walletId,
            confirmedAt,
            minimumHeartbeatAt
        );
        return {
            reservation: this.getReservation(reservationId),
            changed: Number(result.changes) === 1
        };
    }

    releaseReservation(reservationId, ledgerEntry, reason, timestamp) {
        return this.eventStore.transaction(() => {
            const existing = this.getLedgerEntry(ledgerEntry.idempotencyKey);
            if (existing) {
                return {
                    reservation: this.getReservation(reservationId),
                    ledgerEntry: existing,
                    duplicate: true
                };
            }
            const result = this.statements.releaseReservation.run(
                timestamp,
                reason,
                timestamp,
                reservationId
            );
            if (Number(result.changes) !== 1) {
                return {
                    reservation: this.getReservation(reservationId),
                    ledgerEntry: null,
                    duplicate: true
                };
            }
            this.insertLedger(ledgerEntry);
            return {
                reservation: this.getReservation(reservationId),
                ledgerEntry: this.getLedgerEntry(ledgerEntry.idempotencyKey),
                duplicate: false
            };
        });
    }

    redeemReservation(reservationId, ledgerEntry, timestamp) {
        return this.eventStore.transaction(() => {
            const existing = this.getLedgerEntry(ledgerEntry.idempotencyKey);
            if (existing) {
                return {
                    reservation: this.getReservation(reservationId),
                    ledgerEntry: existing,
                    duplicate: true
                };
            }
            const result = this.statements.redeemReservation.run(
                timestamp,
                timestamp,
                reservationId
            );
            if (Number(result.changes) !== 1) {
                return {
                    reservation: this.getReservation(reservationId),
                    ledgerEntry: null,
                    duplicate: true
                };
            }
            this.insertLedger(ledgerEntry);
            return {
                reservation: this.getReservation(reservationId),
                ledgerEntry: this.getLedgerEntry(ledgerEntry.idempotencyKey),
                duplicate: false
            };
        });
    }

    markOutcomeUnknown(reservationId, reason, timestamp) {
        this.statements.markOutcomeUnknown.run(
            reason,
            timestamp,
            reservationId
        );
        return this.getReservation(reservationId);
    }

    applyPurchaseAdjustment(purchase, ledgerEntry, {
        adjustedCredits,
        status,
        updatedAt
    }) {
        return this.eventStore.transaction(() => {
            const existing = this.getLedgerEntry(ledgerEntry.idempotencyKey);
            if (existing) {
                return { purchase: this.getPurchaseByPaymentRequest(
                    purchase.paymentRequestId
                ), ledgerEntry: existing, duplicate: true };
            }
            const result = this.statements.updatePurchaseAdjustment.run(
                status,
                adjustedCredits,
                updatedAt,
                purchase.paymentRequestId,
                adjustedCredits
            );
            if (Number(result.changes) !== 1) {
                return { purchase: this.getPurchaseByPaymentRequest(
                    purchase.paymentRequestId
                ), ledgerEntry: null, duplicate: true };
            }
            this.insertLedger(ledgerEntry);
            return {
                purchase: this.getPurchaseByPaymentRequest(purchase.paymentRequestId),
                ledgerEntry: this.getLedgerEntry(ledgerEntry.idempotencyKey),
                duplicate: false
            };
        });
    }

    appendAdministrativeCorrection(ledgerEntry) {
        return this.eventStore.transaction(() => {
            const existing = this.getLedgerEntry(ledgerEntry.idempotencyKey);
            if (existing) {
                return { ledgerEntry: existing, duplicate: true };
            }
            const balance = this.getBalance(ledgerEntry.walletId);
            if (balance.available + ledgerEntry.availableDelta < 0) {
                const error = new Error(
                    "The correction would make the available balance negative."
                );
                error.code = "FEED_CREDIT_CORRECTION_INVALID";
                throw error;
            }
            this.insertLedger(ledgerEntry);
            return {
                ledgerEntry: this.getLedgerEntry(ledgerEntry.idempotencyKey),
                duplicate: false
            };
        });
    }

    getBalance(walletId) {
        const row = this.statements.selectBalance.get(walletId);
        return {
            available: Number(row?.available || 0),
            reserved: Number(row?.reserved || 0),
            spent: Number(row?.spent || 0)
        };
    }

    getLedgerEntry(idempotencyKey) {
        return mapLedgerEntry(
            this.statements.selectLedgerByIdempotency.get(idempotencyKey)
        );
    }

    listLedgerForWallet(walletId, limit = 100) {
        return this.statements.selectLedgerByWallet
            .all(walletId, Math.min(500, Math.max(1, Number(limit) || 100)))
            .map(mapLedgerEntry);
    }

    listLedger(limit = 100) {
        return this.statements.listLedger
            .all(Math.min(1000, Math.max(1, Number(limit) || 100)))
            .map(mapLedgerEntry);
    }

    listWallets(limit = 100) {
        return this.statements.listWallets
            .all(Math.min(500, Math.max(1, Number(limit) || 100)))
            .map(mapWallet);
    }

    insertLedger(entry) {
        this.statements.insertLedger.run(
            entry.ledgerEntryId,
            entry.walletId,
            entry.entryType,
            entry.availableDelta,
            entry.reservedDelta,
            entry.spentDelta,
            entry.paymentRequestId,
            entry.reservationId,
            entry.eventId,
            entry.idempotencyKey,
            entry.reason,
            JSON.stringify(entry.metadata ?? null),
            entry.createdAt
        );
    }
}
