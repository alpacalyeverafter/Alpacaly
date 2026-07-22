const SAFE_CODE_PATTERN = /^[A-Z0-9_]{1,80}$/;
const SAFE_EVENT_TYPE_PATTERN = /^[a-z0-9_.]{1,100}$/;

function safeCode(value, fallback) {
    return SAFE_CODE_PATTERN.test(String(value || "")) ? String(value) : fallback;
}

function safeEventType(value) {
    return SAFE_EVENT_TYPE_PATTERN.test(String(value || "")) ? String(value) : null;
}

export class SandboxDiagnosticsService {
    constructor({ config, paymentAdapter, clock = () => new Date() }) {
        this.config = config;
        this.paymentAdapter = paymentAdapter;
        this.clock = clock;
        this.lastReceivedAt = null;
        this.latestEvent = null;
    }

    recordWebhookResult(result = {}) {
        const receivedAt = this.clock().toISOString();
        this.lastReceivedAt = receivedAt;
        const rejected = result.handled === false || Boolean(result.reason);
        this.latestEvent = Object.freeze({
            status: rejected ? "REJECTED" : "ACCEPTED",
            eventType: safeEventType(result.eventType),
            duplicate: Boolean(result.duplicate),
            reasonCode: rejected
                ? safeCode(result.reason, "PAYMENT_EVENT_NOT_HANDLED")
                : null,
            receivedAt
        });
    }

    recordWebhookRejection(error) {
        const receivedAt = this.clock().toISOString();
        this.lastReceivedAt = receivedAt;
        this.latestEvent = Object.freeze({
            status: "REJECTED",
            eventType: null,
            duplicate: false,
            reasonCode: safeCode(error?.code, "PAYMENT_WEBHOOK_REJECTED"),
            receivedAt
        });
    }

    getDiagnostics() {
        const sandboxEnabled = Boolean(
            this.config.paymentSandboxEnabled
            && this.config.nodeEnv !== "production"
        );
        const adapterConfigured = Boolean(this.paymentAdapter?.isConfigured?.());
        let webhookStatus = "DISABLED";
        if (sandboxEnabled) {
            webhookStatus = adapterConfigured
                ? (this.latestEvent?.status === "REJECTED"
                    ? "ATTENTION"
                    : (this.latestEvent ? "RECEIVING" : "READY"))
                : "NOT_CONFIGURED";
        }

        return {
            sandboxMode: sandboxEnabled ? "ENABLED" : "DISABLED",
            apiStatus: "AVAILABLE",
            stripeAdapterStatus: adapterConfigured ? "CONFIGURED" : "NOT_CONFIGURED",
            webhook: {
                status: webhookStatus,
                lastReceivedAt: this.lastReceivedAt
            },
            latestEvent: this.latestEvent
        };
    }
}
