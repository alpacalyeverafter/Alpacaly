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

        createCheckoutSession({ packId, clientRequestId, walletToken, walletId }) {
            return this.apiClient.createFeedCreditCheckout({
                packId,
                clientRequestId,
                walletToken,
                walletId
            });
        }

        getPaymentRequest(paymentRequestId, walletToken, walletId = null) {
            return this.apiClient.getPaymentRequest(
                paymentRequestId,
                walletToken,
                walletId
            );
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
