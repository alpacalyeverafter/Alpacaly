// ==========================================
// Alpacaly Ever After
// Server-backed sandbox payment boundary
// ==========================================

(function exposePaymentGateway(global) {
    "use strict";

    class PaymentGateway {
        constructor(apiClient) {
            if (!apiClient) {
                throw new Error("PaymentGateway requires the server API client.");
            }
            this.apiClient = apiClient;
        }

        createCheckoutSession({ supporterName, clientRequestId }) {
            return this.apiClient.createSandboxCheckoutSession({
                supporterName,
                clientRequestId,
                amountMinor: 500,
                currency: "GBP"
            });
        }

        getPaymentRequest(paymentRequestId) {
            return this.apiClient.getPaymentRequest(paymentRequestId);
        }
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { PaymentGateway };
    }

    if (global) {
        global.PaymentGateway = PaymentGateway;
        if (global.document && global.alpacalyApiClient) {
            global.paymentGateway = new PaymentGateway(global.alpacalyApiClient);
        }
    }
})(typeof window !== "undefined" ? window : globalThis);
