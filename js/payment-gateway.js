// ==========================================
// Alpacaly Ever After
// Payment Gateway
// ==========================================

class PaymentGateway {
    constructor(config = {}) {
        this.config = config || {};
        this.config.simulationMode = this.config.simulationMode !== undefined
            ? this.config.simulationMode
            : true;
        this.payments = this.loadPayments();
    }

    loadPayments() {
        if (typeof window === "undefined" || !window.localStorage) {
            return [];
        }

        try {
            const raw = window.localStorage.getItem("alpacaly-payment-gateway");
            if (!raw) {
                return [];
            }

            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && Array.isArray(parsed.payments)) {
                return parsed.payments;
            }

            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.warn("[PaymentGateway] Unable to read payments from localStorage.", error);
            return [];
        }
    }

    persistPayments() {
        if (typeof window === "undefined" || !window.localStorage) {
            return;
        }

        try {
            window.localStorage.setItem("alpacaly-payment-gateway", JSON.stringify({
                payments: this.payments
            }));
        } catch (error) {
            console.warn("[PaymentGateway] Unable to persist payments to localStorage.", error);
        }
    }

    delay(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    cleanSupporterName(name) {
        const cleaned = String(name || "").trim();
        return cleaned || "Anonymous supporter";
    }

    generatePaymentId() {
        const randomPart = Math.random().toString(36).slice(2, 10);
        return `pay-${Date.now()}-${randomPart}`;
    }

    async processPayment({ supporterName = "", amount = 0, eventId = null } = {}) {
        const normalizedAmount = Number(amount);

        if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
            return {
                success: false,
                paymentId: null,
                supporterName: this.cleanSupporterName(supporterName),
                amount: normalizedAmount,
                timestamp: new Date().toISOString(),
                error: "Amount must be greater than zero."
            };
        }

        const paymentId = this.generatePaymentId();

        if (this.config.simulationMode) {
            await this.delay(2000);
        }

        const paymentResult = {
            paymentId,
            eventId: eventId || null,
            supporterName: this.cleanSupporterName(supporterName),
            amount: normalizedAmount,
            currency: "GBP",
            status: "SUCCEEDED",
            createdAt: new Date().toISOString()
        };

        const existingPayment = this.payments.find(entry => entry.paymentId === paymentId);
        if (!existingPayment) {
            this.payments.push(paymentResult);
            this.persistPayments();
        }

        return {
            success: true,
            ...paymentResult
        };
    }
}

const paymentGateway = new PaymentGateway(CONFIG);
