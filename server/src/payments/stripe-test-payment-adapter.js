import Stripe from "stripe";

import { ApplicationError } from "../errors/application-error.js";

export class StripeTestPaymentAdapter {
    constructor({
        secretKey,
        webhookSecret,
        webhookToleranceSeconds = 300,
        apiTimeoutMs = 10_000,
        checkoutSessionCreator = null
    } = {}) {
        this.provider = "STRIPE";
        this.mode = "TEST";
        this.secretKey = secretKey || null;
        this.webhookSecret = webhookSecret || null;
        this.webhookToleranceSeconds = webhookToleranceSeconds;
        this.stripe = this.secretKey
            ? new Stripe(this.secretKey, {
                maxNetworkRetries: 2,
                timeout: apiTimeoutMs
            })
            : null;
        this.checkoutSessionCreator = checkoutSessionCreator
            || (this.stripe
                ? (parameters, options) => this.stripe.checkout.sessions.create(
                    parameters,
                    options
                )
                : null);
    }

    isConfigured() {
        return Boolean(
            this.secretKey?.startsWith("sk_test_")
            && this.webhookSecret?.startsWith("whsec_")
            && this.checkoutSessionCreator
            && this.stripe
        );
    }

    assertConfigured() {
        if (this.secretKey && !this.secretKey.startsWith("sk_test_")) {
            throw new ApplicationError(
                "Only a Stripe test-mode secret key is accepted by this build.",
                { code: "LIVE_PAYMENT_KEY_REJECTED", statusCode: 503 }
            );
        }
        if (!this.isConfigured()) {
            throw new ApplicationError(
                "Stripe sandbox payments are not configured on this server.",
                { code: "PAYMENT_SANDBOX_NOT_CONFIGURED", statusCode: 503 }
            );
        }
    }

    async createCheckoutSession({
        paymentRequestId,
        amountMinor,
        currency,
        successUrl,
        cancelUrl
    }) {
        this.assertConfigured();
        let session;
        try {
            session = await this.checkoutSessionCreator({
                mode: "payment",
                submit_type: "donate",
                client_reference_id: paymentRequestId,
                success_url: successUrl,
                cancel_url: cancelUrl,
                line_items: [{
                    quantity: 1,
                    price_data: {
                        currency: currency.toLowerCase(),
                        unit_amount: amountMinor,
                        product_data: {
                            name: "Alpacaly measured feed sponsorship request",
                            description: "Subject to animal-welfare and operational approval."
                        }
                    }
                }],
                metadata: {
                    alpacaly_payment_request_id: paymentRequestId
                },
                payment_intent_data: {
                    metadata: {
                        alpacaly_payment_request_id: paymentRequestId
                    }
                }
            }, {
                idempotencyKey: `alpacaly-checkout-${paymentRequestId}`
            });
        } catch {
            throw new ApplicationError(
                "Stripe test checkout could not be created. Please try again.",
                { code: "PAYMENT_PROVIDER_UNAVAILABLE", statusCode: 502 }
            );
        }

        if (
            session?.livemode !== false
            || !String(session?.id || "").startsWith("cs_test_")
            || typeof session?.url !== "string"
            || !session.url.startsWith("https://")
        ) {
            throw new ApplicationError(
                "The payment provider did not return a valid test-mode checkout.",
                { code: "INVALID_SANDBOX_CHECKOUT", statusCode: 502 }
            );
        }

        return {
            checkoutSessionId: session.id,
            checkoutUrl: session.url,
            providerStatus: session.status || "open"
        };
    }

    verifyWebhook(rawBody, signature) {
        this.assertConfigured();
        if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
            throw new ApplicationError("The Stripe webhook body is invalid.", {
                code: "PAYMENT_WEBHOOK_BODY_INVALID",
                statusCode: 400
            });
        }
        if (typeof signature !== "string" || !signature.trim()) {
            throw new ApplicationError("The Stripe webhook signature is missing.", {
                code: "PAYMENT_WEBHOOK_SIGNATURE_INVALID",
                statusCode: 400
            });
        }

        let event;
        try {
            event = this.stripe.webhooks.constructEvent(
                rawBody,
                signature,
                this.webhookSecret,
                this.webhookToleranceSeconds
            );
        } catch (error) {
            const stale = /timestamp|tolerance/i.test(String(error?.message || ""));
            throw new ApplicationError(
                stale
                    ? "The Stripe webhook delivery is outside the allowed time window."
                    : "The Stripe webhook signature is invalid.",
                {
                    code: stale
                        ? "PAYMENT_WEBHOOK_STALE"
                        : "PAYMENT_WEBHOOK_SIGNATURE_INVALID",
                    statusCode: 400
                }
            );
        }

        if (event?.livemode !== false) {
            throw new ApplicationError("Live Stripe events are rejected by this build.", {
                code: "LIVE_PAYMENT_EVENT_REJECTED",
                statusCode: 400
            });
        }
        return event;
    }
}
