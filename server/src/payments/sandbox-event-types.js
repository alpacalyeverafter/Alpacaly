export const STRIPE_SANDBOX_EVENT_TYPES = Object.freeze([
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "checkout.session.expired",
    "payment_intent.payment_failed",
    "charge.refunded",
    "charge.dispute.created"
]);

export const STRIPE_SANDBOX_EVENT_TYPE_SET = new Set(STRIPE_SANDBOX_EVENT_TYPES);
