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

        createCheckoutSession({ packId, clientRequestId, walletToken }) {
            return this.apiClient.createFeedCreditCheckout({
                packId,
                clientRequestId,
                walletToken
            });
        }

        getPaymentRequest(paymentRequestId, walletToken) {
            return this.apiClient.getPaymentRequest(paymentRequestId, walletToken);
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
