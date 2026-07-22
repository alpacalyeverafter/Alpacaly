import { createPaymentRequest, PAYMENT_STATUSES } from "../domain/payments.js";
import { ApplicationError } from "../errors/application-error.js";

const COMPLETION_EVENTS = new Set([
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded"
]);

function normalizedText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function transitionStatus(currentStatus, requestedStatus) {
    if (currentStatus === requestedStatus) {
        return currentStatus;
    }
    if (["REFUNDED", "DISPUTED"].includes(currentStatus)) {
        return currentStatus === "REFUNDED" && requestedStatus === "DISPUTED"
            ? "DISPUTED"
            : currentStatus;
    }
    if (currentStatus === "COMPLETED") {
        return ["REFUNDED", "DISPUTED"].includes(requestedStatus)
            ? requestedStatus
            : currentStatus;
    }
    if (["FAILED", "EXPIRED"].includes(currentStatus)) {
        return requestedStatus === "COMPLETED" ? "COMPLETED" : currentStatus;
    }
    return requestedStatus;
}

export class PaymentService {
    constructor({
        eventEngine,
        eventStore = eventEngine.eventStore,
        contributionLedgerServices,
        adapter,
        config,
        logger,
        clock = () => new Date(),
        idGenerator
    }) {
        this.eventEngine = eventEngine;
        this.eventStore = eventStore;
        this.ledger = contributionLedgerServices;
        this.adapter = adapter;
        this.config = config;
        this.logger = logger;
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    async createCheckoutSession(payload) {
        this.requireSandboxEnabled();
        const input = this.validateDonationRequest(payload);
        const existing = this.eventStore.getPaymentRequestByClientRequest(
            this.adapter.provider,
            input.clientRequestId
        );
        if (existing) {
            return { paymentRequest: existing, duplicate: true };
        }

        const paymentRequest = createPaymentRequest({
            provider: this.adapter.provider,
            mode: this.adapter.mode,
            ...input
        }, {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        });

        try {
            this.eventStore.createPaymentRequest(paymentRequest);
        } catch (error) {
            const concurrent = this.eventStore.getPaymentRequestByClientRequest(
                this.adapter.provider,
                input.clientRequestId
            );
            if (concurrent) {
                return { paymentRequest: concurrent, duplicate: true };
            }
            throw error;
        }

        const publicBaseUrl = this.config.paymentPublicBaseUrl.replace(/\/+$/, "");
        const query = `payment_request_id=${encodeURIComponent(
            paymentRequest.paymentRequestId
        )}`;

        try {
            const checkout = await this.adapter.createCheckoutSession({
                paymentRequestId: paymentRequest.paymentRequestId,
                amountMinor: paymentRequest.amountMinor,
                currency: paymentRequest.currency,
                successUrl: `${publicBaseUrl}/index.html?${query}&checkout=success`,
                cancelUrl: `${publicBaseUrl}/index.html?${query}&checkout=cancelled`
            });
            const updated = this.eventStore.attachPaymentCheckoutSession(
                paymentRequest.paymentRequestId,
                {
                    ...checkout,
                    updatedAt: this.clock().toISOString()
                }
            );
            this.logger.info({
                event: "sandbox_checkout_created",
                paymentRequestId: updated.paymentRequestId,
                provider: updated.provider,
                amountMinor: updated.amountMinor,
                currency: updated.currency
            }, "Sandbox Checkout Session created");
            return { paymentRequest: updated, duplicate: false };
        } catch (error) {
            this.eventStore.updatePaymentRequestState(paymentRequest.paymentRequestId, {
                status: "FAILED",
                providerStatus: "checkout_creation_failed",
                failureCode: error.code || "PAYMENT_PROVIDER_UNAVAILABLE",
                updatedAt: this.clock().toISOString()
            });
            throw error;
        }
    }

    handleStripeWebhook(rawBody, signature) {
        this.requireSandboxEnabled();
        const event = this.adapter.verifyWebhook(rawBody, signature);
        if (
            !normalizedText(event?.id)
            || !normalizedText(event?.type)
            || !event?.data
            || typeof event.data.object !== "object"
        ) {
            throw new ApplicationError("The Stripe webhook payload is malformed.", {
                code: "PAYMENT_WEBHOOK_PAYLOAD_INVALID",
                statusCode: 400
            });
        }
        const object = event?.data?.object || {};
        const ingestion = this.ledger.providerEventIngestionService.ingest({
            provider: "STRIPE",
            externalEventId: normalizedText(event.id),
            receivedAt: this.clock().toISOString(),
            rawMetadata: this.sanitizeProviderMetadata(event, object)
        });

        if (COMPLETION_EVENTS.has(event.type)) {
            return this.handleCompletionEvent(event, object, ingestion);
        }

        if (event.type === "checkout.session.expired") {
            return this.handleStatusEvent(event, object, ingestion, {
                status: "EXPIRED",
                providerStatus: "expired",
                failureCode: "CHECKOUT_SESSION_EXPIRED"
            });
        }
        if (
            event.type === "checkout.session.async_payment_failed"
            || event.type === "payment_intent.payment_failed"
        ) {
            return this.handleStatusEvent(event, object, ingestion, {
                status: "FAILED",
                providerStatus: "payment_failed",
                failureCode: "PAYMENT_FAILED"
            });
        }
        if (event.type === "charge.refunded") {
            const request = this.findPaymentRequest(event, object);
            const fullyRefunded = object.refunded === true
                || Number(object.amount_refunded) >= Number(request?.amountMinor || Infinity);
            return this.handleStatusEvent(event, object, ingestion, {
                status: fullyRefunded ? "REFUNDED" : request?.status || "PENDING",
                providerStatus: fullyRefunded ? "refunded" : "partially_refunded",
                failureCode: fullyRefunded ? "PAYMENT_REFUNDED" : null
            });
        }
        if (event.type === "charge.dispute.created") {
            return this.handleStatusEvent(event, object, ingestion, {
                status: "DISPUTED",
                providerStatus: "disputed",
                failureCode: "PAYMENT_DISPUTED"
            });
        }

        this.rejectProviderEvent(
            ingestion.providerEvent,
            "UNHANDLED_PAYMENT_EVENT"
        );
        return {
            received: true,
            duplicate: ingestion.duplicate,
            handled: false,
            eventType: event.type
        };
    }

    handleCompletionEvent(event, object, ingestion) {
        const paymentRequestId = normalizedText(
            object.metadata?.alpacaly_payment_request_id
        );
        const paymentRequest = paymentRequestId
            ? this.eventStore.getPaymentRequest(paymentRequestId)
            : null;
        const mismatch = this.validateCompletedSession(paymentRequest, object);
        if (mismatch) {
            this.rejectProviderEvent(ingestion.providerEvent, mismatch);
            if (paymentRequest) {
                this.updatePayment(paymentRequest, {
                    status: "FAILED",
                    providerStatus: "verification_failed",
                    failureCode: mismatch,
                    providerEventId: ingestion.providerEvent.providerEventId,
                    paymentIntentId: normalizedText(object.payment_intent) || null
                });
            }
            return {
                received: true,
                handled: true,
                duplicate: ingestion.duplicate,
                accepted: false,
                reason: mismatch,
                paymentRequest: paymentRequest
                    ? this.getPaymentRequestView(paymentRequest.paymentRequestId)
                    : null
            };
        }

        const verification = this.ledger.contributionVerificationService.verify(
            ingestion.providerEvent.providerEventId,
            {
                verified: true,
                eligible: true,
                amountMinor: paymentRequest.amountMinor,
                currency: paymentRequest.currency,
                supporterDisplayName: paymentRequest.supporterDisplayName,
                feedQuantity: 1,
                metadata: {
                    paymentRequestId: paymentRequest.paymentRequestId,
                    checkoutSessionId: paymentRequest.checkoutSessionId,
                    paymentMode: "TEST"
                },
                feederId: this.eventEngine.getDefaultFeederId(),
                message: "Sandbox website feed sponsorship request"
            }
        );
        if (!verification.accepted || !verification.contribution || !verification.feedIntent) {
            return {
                received: true,
                handled: true,
                accepted: false,
                duplicate: ingestion.duplicate,
                reason: "CONTRIBUTION_REJECTED",
                paymentRequest: this.getPaymentRequestView(
                    paymentRequest.paymentRequestId
                )
            };
        }

        const now = this.clock().toISOString();
        let updated = this.updatePayment(paymentRequest, {
            status: "COMPLETED",
            providerStatus: normalizedText(object.payment_status) || "paid",
            failureCode: null,
            paymentIntentId: normalizedText(object.payment_intent) || null,
            providerEventId: ingestion.providerEvent.providerEventId,
            contributionId: verification.contribution.contributionId,
            feedIntentId: verification.feedIntent.feedIntentId,
            completedAt: now
        });

        try {
            const feedResult = this.ledger.outboxWorker.processFeedIntent(
                verification.feedIntent.feedIntentId
            );
            if (feedResult?.feedRequest) {
                updated = this.updatePayment(updated, {
                    status: updated.status,
                    providerStatus: updated.providerStatus,
                    failureCode: updated.failureCode,
                    eventId: feedResult.feedRequest.eventId
                });
            }
        } catch (error) {
            this.logger.warn({
                event: "paid_feed_request_delayed",
                paymentRequestId: paymentRequest.paymentRequestId,
                contributionId: verification.contribution.contributionId,
                feedIntentId: verification.feedIntent.feedIntentId,
                reason: error.code || "EVENT_ENGINE_REJECTED"
            }, "Payment completed but the feed request remains safely delayed");
        }

        return {
            received: true,
            handled: true,
            accepted: true,
            duplicate: ingestion.duplicate,
            paymentRequest: this.getPaymentRequestView(updated.paymentRequestId)
        };
    }

    handleStatusEvent(event, object, ingestion, nextState) {
        const paymentRequest = this.findPaymentRequest(event, object);
        this.rejectProviderEvent(
            ingestion.providerEvent,
            `PAYMENT_STATUS_${nextState.providerStatus.toUpperCase()}`
        );
        if (!paymentRequest) {
            return {
                received: true,
                handled: true,
                duplicate: ingestion.duplicate,
                accepted: false,
                reason: "PAYMENT_REQUEST_NOT_FOUND"
            };
        }

        const updated = this.updatePayment(paymentRequest, {
            ...nextState,
            providerEventId: ingestion.providerEvent.providerEventId,
            paymentIntentId: this.paymentIntentIdFrom(event, object)
        });
        return {
            received: true,
            handled: true,
            duplicate: ingestion.duplicate,
            accepted: false,
            paymentRequest: this.getPaymentRequestView(updated.paymentRequestId)
        };
    }

    rejectProviderEvent(providerEvent, reason) {
        if (providerEvent.verificationStatus !== "PENDING") {
            return;
        }
        this.ledger.contributionVerificationService.verify(
            providerEvent.providerEventId,
            { verified: false, rejectionReason: reason }
        );
    }

    updatePayment(paymentRequest, changes) {
        const status = transitionStatus(paymentRequest.status, changes.status);
        const transitionAccepted = status === changes.status
            || paymentRequest.status === changes.status;
        return this.eventStore.updatePaymentRequestState(
            paymentRequest.paymentRequestId,
            {
                status,
                providerStatus: transitionAccepted
                    ? changes.providerStatus || paymentRequest.providerStatus
                    : paymentRequest.providerStatus,
                failureCode: !transitionAccepted || changes.failureCode === undefined
                    ? paymentRequest.failureCode
                    : changes.failureCode,
                paymentIntentId: changes.paymentIntentId,
                providerEventId: changes.providerEventId,
                contributionId: changes.contributionId,
                feedIntentId: changes.feedIntentId,
                eventId: changes.eventId,
                completedAt: changes.completedAt,
                updatedAt: this.clock().toISOString()
            }
        );
    }

    getPaymentRequestView(paymentRequestId, { administrator = false } = {}) {
        const payment = this.eventStore.getPaymentRequest(paymentRequestId);
        if (!payment) {
            throw new ApplicationError("Payment request not found.", {
                code: "PAYMENT_REQUEST_NOT_FOUND",
                statusCode: 404
            });
        }
        const contribution = payment.contributionId
            ? this.eventStore.getContribution(payment.contributionId)
            : null;
        const feedIntent = payment.feedIntentId
            ? this.eventStore.getFeedIntent(payment.feedIntentId)
            : null;
        const eventId = payment.eventId
            || (feedIntent
                ? this.eventStore.getEventIdByFeedIntent(feedIntent.feedIntentId)
                : null);
        const feedRequest = eventId ? this.eventEngine.getFeedRequest(eventId) : null;
        const feeding = this.describeFeeding(payment, contribution, feedIntent, feedRequest);

        return {
            paymentRequestId: payment.paymentRequestId,
            provider: payment.provider,
            mode: payment.mode,
            status: payment.status,
            providerStatus: payment.providerStatus,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            createdAt: payment.createdAt,
            updatedAt: payment.updatedAt,
            completedAt: payment.completedAt,
            contribution: contribution ? {
                contributionId: contribution.contributionId,
                eligibilityStatus: contribution.eligibilityStatus
            } : null,
            feedIntent: feedIntent ? {
                feedIntentId: feedIntent.feedIntentId,
                status: feedIntent.status,
                failureReason: administrator ? feedIntent.failureReason : undefined
            } : null,
            event: feedRequest ? {
                eventId: feedRequest.eventId,
                state: feedRequest.state,
                queuePosition: feedRequest.queuePosition,
                estimatedWaitMs: feedRequest.estimatedWaitMs
            } : eventId ? { eventId, state: "UNKNOWN", queuePosition: null, estimatedWaitMs: 0 } : null,
            feeding,
            ...(administrator ? {
                supporterDisplayName: payment.supporterDisplayName,
                clientRequestId: payment.clientRequestId,
                checkoutSessionId: payment.checkoutSessionId,
                paymentIntentId: payment.paymentIntentId,
                failureCode: payment.failureCode,
                providerEventId: payment.lastProviderEventId
            } : {})
        };
    }

    listPaymentRequestViews({ limit = 100 } = {}) {
        return this.eventStore.listPaymentRequests({ limit }).map(payment => (
            this.getPaymentRequestView(payment.paymentRequestId, { administrator: true })
        ));
    }

    describeFeeding(payment, contribution, feedIntent, feedRequest) {
        if (payment.status === "PENDING") {
            return {
                status: "PAYMENT_PENDING",
                message: "Waiting for verified sandbox payment confirmation."
            };
        }
        if (["FAILED", "EXPIRED"].includes(payment.status)) {
            return {
                status: "PAYMENT_NOT_COMPLETED",
                message: "No feed request was created from this payment attempt."
            };
        }
        if (!contribution || !feedIntent) {
            return {
                status: "BLOCKED",
                message: "Payment was recorded, but no eligible feed request was created."
            };
        }
        if (!feedRequest) {
            return {
                status: feedIntent.status === "FAILED" ? "DELAYED" : "PROCESSING",
                message: feedIntent.status === "FAILED"
                    ? "Payment was received, but feeding is safely delayed by welfare or operational controls."
                    : "Payment was received and the Event Engine is preparing the feed request."
            };
        }
        if (feedRequest.safetyState === "CANCELLED_FOR_WELFARE") {
            return {
                status: "CANCELLED_FOR_WELFARE",
                message:
                    "Payment was received, but this feed was cancelled by an animal-welfare control. No replacement dispense is started automatically."
            };
        }
        if (payment.status === "REFUNDED") {
            return {
                status: "REFUNDED",
                message: "This payment was refunded. Any feed action remains governed separately by safety controls."
            };
        }
        if (payment.status === "DISPUTED") {
            return {
                status: "DISPUTED",
                message: "This payment is disputed. The Event Engine and safety controls remain authoritative."
            };
        }
        return {
            status: feedRequest.state,
            message: ["COMPLETE", "ARCHIVED"].includes(feedRequest.state)
                ? "The simulated feed lifecycle completed."
                : "The feed request is subject to welfare, timing and operational approval."
        };
    }

    validateDonationRequest(payload) {
        const supporterDisplayName = normalizedText(payload?.supporterName);
        if (!supporterDisplayName || supporterDisplayName.length > 80) {
            throw new ApplicationError("Enter a supporter name of 80 characters or fewer.", {
                code: "PAYMENT_REQUEST_INVALID",
                statusCode: 400
            });
        }
        const clientRequestId = normalizedText(payload?.clientRequestId);
        if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(clientRequestId)) {
            throw new ApplicationError("The payment request reference is invalid.", {
                code: "PAYMENT_REQUEST_INVALID",
                statusCode: 400
            });
        }
        const amountMinor = Number(payload?.amountMinor);
        const currency = normalizedText(payload?.currency).toUpperCase();
        if (
            amountMinor !== this.config.paymentDonationAmountMinor
            || currency !== this.config.paymentDonationCurrency
        ) {
            throw new ApplicationError("The sandbox donation amount or currency is invalid.", {
                code: "PAYMENT_AMOUNT_MISMATCH",
                statusCode: 400
            });
        }
        return {
            supporterDisplayName,
            clientRequestId,
            amountMinor,
            currency
        };
    }

    validateCompletedSession(paymentRequest, object) {
        if (!paymentRequest) {
            return "PAYMENT_METADATA_INVALID";
        }
        if (
            object.id !== paymentRequest.checkoutSessionId
            || object.client_reference_id !== paymentRequest.paymentRequestId
        ) {
            return "PAYMENT_REFERENCE_MISMATCH";
        }
        if (
            Number(object.amount_total) !== paymentRequest.amountMinor
            || normalizedText(object.currency).toUpperCase() !== paymentRequest.currency
        ) {
            return "PAYMENT_AMOUNT_MISMATCH";
        }
        if (object.mode !== "payment" || object.payment_status !== "paid") {
            return "PAYMENT_NOT_PAID";
        }
        return null;
    }

    findPaymentRequest(event, object) {
        const paymentRequestId = normalizedText(
            object.metadata?.alpacaly_payment_request_id
        );
        if (paymentRequestId) {
            const byId = this.eventStore.getPaymentRequest(paymentRequestId);
            if (byId) {
                return byId;
            }
        }
        if (String(object.id || "").startsWith("cs_")) {
            const bySession = this.eventStore.getPaymentRequestByCheckoutSession(
                "STRIPE",
                object.id
            );
            if (bySession) {
                return bySession;
            }
        }
        const paymentIntentId = this.paymentIntentIdFrom(event, object);
        return paymentIntentId
            ? this.eventStore.getPaymentRequestByPaymentIntent(
                "STRIPE",
                paymentIntentId
            )
            : null;
    }

    paymentIntentIdFrom(event, object) {
        if (event.type.startsWith("payment_intent.")) {
            return normalizedText(object.id) || null;
        }
        return normalizedText(object.payment_intent) || null;
    }

    sanitizeProviderMetadata(event, object) {
        return {
            mode: "TEST",
            eventType: normalizedText(event.type),
            providerCreatedAt: Number(event.created) || null,
            objectId: normalizedText(object.id) || null,
            paymentRequestId: normalizedText(
                object.metadata?.alpacaly_payment_request_id
            ) || null,
            paymentIntentId: this.paymentIntentIdFrom(event, object),
            amountMinor: Number(object.amount_total ?? object.amount ?? 0) || null,
            currency: normalizedText(object.currency).toUpperCase() || null,
            providerStatus: normalizedText(
                object.payment_status || object.status
            ) || null
        };
    }

    requireSandboxEnabled() {
        if (!this.config.paymentSandboxEnabled || this.config.nodeEnv === "production") {
            throw new ApplicationError("Sandbox payments are disabled.", {
                code: "PAYMENT_SANDBOX_DISABLED",
                statusCode: 403
            });
        }
        this.adapter.assertConfigured();
    }
}

export function assertPaymentStatus(status) {
    if (!PAYMENT_STATUSES.includes(status)) {
        throw new Error(`Unsupported payment status: ${status}`);
    }
    return status;
}
