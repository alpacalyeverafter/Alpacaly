// ============================================
// Alpacaly Ever After
// Feed Credit wallet and click-to-feed journey
// ============================================

(() => {
    "use strict";

    const eventEngine = window.alpacalyEventEngine;
    const apiClient = window.alpacalyApiClient;
    const paymentGateway = window.paymentGateway;
    const WALLET_TOKEN_KEY = "alpacaly_feed_credit_wallet_token_v1";

    const elements = {
        feedsDisplay: document.getElementById("feeds-remaining"),
        queuePosition: document.getElementById("queue-position"),
        estimatedWait: document.getElementById("estimated-wait"),
        systemStatus: document.getElementById("system-status"),
        eventId: document.getElementById("event-id"),
        paymentStatus: document.getElementById("payment-status"),
        walletCreate: document.getElementById("wallet-create"),
        supporterName: document.getElementById("supporter-name"),
        createWallet: document.getElementById("create-wallet"),
        walletDashboard: document.getElementById("wallet-dashboard"),
        walletName: document.getElementById("wallet-name"),
        creditsAvailable: document.getElementById("credits-available"),
        creditsReserved: document.getElementById("credits-reserved"),
        creditsSpent: document.getElementById("credits-spent"),
        packButtons: [...document.querySelectorAll("[data-pack-id]")],
        useCredit: document.getElementById("use-credit"),
        cancelReservation: document.getElementById("cancel-reservation"),
        yourTurn: document.getElementById("your-turn"),
        confirmFeed: document.getElementById("confirm-feed"),
        feedCountdown: document.getElementById("feed-countdown"),
        feedCountdownValue: document.getElementById("feed-countdown-value"),
        feedCountdownLabel: document.getElementById("feed-countdown-label"),
        forgetWallet: document.getElementById("forget-wallet"),
        message: document.getElementById("supporter-message")
    };

    if (!eventEngine || !apiClient || !paymentGateway) {
        console.error("[App] Feed service modules were not loaded.");
        return;
    }
    const missing = Object.entries(elements)
        .filter(([, element]) => !element || (Array.isArray(element) && element.length === 0))
        .map(([name]) => name);
    if (missing.length > 0) {
        console.error("[App] Missing required page elements:", missing);
        return;
    }

    let walletToken = window.localStorage.getItem(WALLET_TOKEN_KEY);
    let wallet = null;
    let activeReservation = null;
    let trackedPaymentRequest = null;
    let submitting = false;
    let walletPollTimer = null;
    let paymentPollTimer = null;
    let presenceTimer = null;
    let countdownTimer = null;

    function requestId(prefix) {
        return eventEngine.generateClientRequestId(prefix);
    }

    function formatState(value) {
        return String(value || "READY")
            .replaceAll("_", " ")
            .toLowerCase()
            .replace(/\b\w/g, letter => letter.toUpperCase());
    }

    function formatDuration(milliseconds) {
        const seconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
        return seconds < 60
            ? `${seconds}s`
            : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
    }

    function setMessage(message, error = false) {
        elements.message.textContent = message;
        elements.message.classList.toggle("supporter-message-error", error);
    }

    function setSubmitting(value) {
        submitting = value;
        elements.createWallet.disabled = value;
        elements.packButtons.forEach(button => {
            button.disabled = value;
        });
        renderWallet();
    }

    function stopCountdown() {
        if (countdownTimer) {
            window.clearInterval(countdownTimer);
            countdownTimer = null;
        }
        elements.feedCountdown.hidden = true;
    }

    function currentCountdown() {
        const eventId = activeReservation?.event?.eventId;
        const currentEvent = eventEngine.getState().currentEvent;
        if (
            !eventId
            || !currentEvent
            || currentEvent.eventId !== eventId
            || currentEvent.state !== "COUNTDOWN"
        ) {
            return null;
        }
        return currentEvent.countdown || null;
    }

    function updateCountdown() {
        const countdown = currentCountdown();
        const endsAt = Date.parse(countdown?.endsAt);
        if (!countdown || !Number.isFinite(endsAt)) {
            stopCountdown();
            return;
        }

        const remainingMs = Math.max(0, endsAt - Date.now());
        const remainingSeconds = Math.ceil(remainingMs / 1000);
        elements.feedCountdown.hidden = false;
        elements.feedCountdownValue.textContent = String(remainingSeconds);
        elements.feedCountdownLabel.textContent = remainingSeconds === 1
            ? "second"
            : remainingSeconds === 0
                ? "Countdown complete"
                : "seconds";

        if (remainingMs === 0 && countdownTimer) {
            window.clearInterval(countdownTimer);
            countdownTimer = null;
        }
    }

    function renderCountdown() {
        if (!currentCountdown()) {
            stopCountdown();
            return;
        }
        updateCountdown();
        if (!countdownTimer) {
            countdownTimer = window.setInterval(updateCountdown, 200);
        }
    }

    function currentActiveReservation(reservations = []) {
        return reservations.find(item => [
            "WAITING", "YOUR_TURN", "CONFIRMED", "OUTCOME_UNKNOWN"
        ].includes(item.status)) || null;
    }

    function renderWallet() {
        const hasWallet = Boolean(wallet && walletToken);
        elements.walletCreate.hidden = hasWallet;
        elements.walletDashboard.hidden = !hasWallet;
        if (!hasWallet) {
            stopCountdown();
            return;
        }

        const balance = wallet.balance || {};
        elements.walletName.textContent = wallet.supporterDisplayName;
        elements.creditsAvailable.textContent = String(balance.available || 0);
        elements.creditsReserved.textContent = String(balance.reserved || 0);
        elements.creditsSpent.textContent = String(balance.spent || 0);

        activeReservation = currentActiveReservation(wallet.reservations);
        const hasActive = Boolean(activeReservation);
        const canUse = Number(balance.available || 0) > 0 && !hasActive && !submitting;
        elements.useCredit.disabled = !canUse;
        elements.useCredit.textContent = hasActive
            ? formatState(activeReservation.status)
            : "Use 1 Feed Credit";
        elements.cancelReservation.hidden = !activeReservation
            || !["WAITING", "YOUR_TURN"].includes(activeReservation.status);
        const isYourTurn = activeReservation?.status === "YOUR_TURN";
        elements.yourTurn.hidden = !isYourTurn;
        elements.confirmFeed.disabled = !isYourTurn
            || document.visibilityState !== "visible"
            || submitting;

        if (activeReservation?.event) {
            const event = activeReservation.event;
            elements.queuePosition.textContent = event.queuePosition === null
                ? formatState(event.state)
                : String(event.queuePosition);
            elements.estimatedWait.textContent = event.queuePosition === null
                ? `Estimated wait: ${formatState(event.state)}`
                : `Estimated wait: ${formatDuration(event.estimatedWaitMs)}`;
            elements.eventId.textContent = `Event ID: ${event.eventId}`;
            elements.systemStatus.textContent = formatState(event.state);
        }
        if (activeReservation?.message) {
            setMessage(activeReservation.message,
                activeReservation.status === "OUTCOME_UNKNOWN");
        }
        renderCountdown();
    }

    function renderEventEngine(state) {
        elements.feedsDisplay.textContent = state.feedsRemaining ?? CONFIG.DEMO_MAX_FEEDS;
        renderCountdown();
        if (!activeReservation?.event) {
            elements.queuePosition.textContent = "—";
            elements.estimatedWait.textContent = "Estimated wait: —";
            elements.eventId.textContent = "Event ID: —";
            elements.systemStatus.textContent = formatState(state.status);
        }
        if (state.backendAvailable === false) {
            setMessage(state.message || "The feed service is unavailable.", true);
        }
    }

    async function createWallet(event) {
        event.preventDefault();
        if (submitting) {
            return;
        }
        const supporterName = elements.supporterName.value.trim();
        if (!supporterName) {
            setMessage("Enter a supporter name.", true);
            elements.supporterName.focus();
            return;
        }
        setSubmitting(true);
        try {
            const response = await apiClient.createFeedCreditWallet(supporterName);
            walletToken = response.recoveryToken;
            window.localStorage.setItem(WALLET_TOKEN_KEY, walletToken);
            wallet = response.wallet;
            elements.supporterName.value = "";
            setMessage("Private Feed Credit wallet created on this browser.");
            startWalletPolling();
        } catch (error) {
            setMessage(error.message || "The wallet could not be created.", true);
        } finally {
            setSubmitting(false);
        }
    }

    async function buyPack(packId) {
        if (!walletToken || submitting) {
            return;
        }
        setSubmitting(true);
        setMessage("Opening Stripe Test Mode. Buying credits will not start a feed.");
        try {
            const result = await paymentGateway.createCheckoutSession({
                packId,
                clientRequestId: requestId("credit-purchase"),
                walletToken
            });
            if (!result?.checkoutUrl) {
                throw new Error("The sandbox checkout URL was not returned.");
            }
            trackedPaymentRequest = result.paymentRequest;
            window.location.assign(result.checkoutUrl);
        } catch (error) {
            setMessage(error.message || "Test checkout could not be opened.", true);
            setSubmitting(false);
        }
    }

    async function reserveCredit() {
        if (!walletToken || submitting) {
            return;
        }
        setSubmitting(true);
        try {
            const response = await apiClient.reserveFeedCredit({
                clientRequestId: requestId("credit-feed"),
                walletToken
            });
            activeReservation = response.reservation;
            setMessage(response.reservation.message);
            await refreshWallet();
        } catch (error) {
            setMessage(error.message || "The Feed Credit could not be reserved.", true);
        } finally {
            setSubmitting(false);
        }
    }

    async function heartbeat() {
        if (
            !walletToken
            || !activeReservation
            || document.visibilityState !== "visible"
            || !["WAITING", "YOUR_TURN", "CONFIRMED"].includes(activeReservation.status)
        ) {
            return;
        }
        try {
            const response = await apiClient.heartbeatFeedCreditReservation(
                activeReservation.reservationId,
                walletToken,
                true
            );
            activeReservation = response.reservation;
        } catch (error) {
            if (error.statusCode === 401) {
                forgetWallet(false);
            }
        }
    }

    async function confirmFeed() {
        if (!activeReservation || submitting || document.visibilityState !== "visible") {
            return;
        }
        setSubmitting(true);
        try {
            await heartbeat();
            const response = await apiClient.confirmFeedCreditReservation(
                activeReservation.reservationId,
                walletToken
            );
            activeReservation = response.reservation;
            setMessage(
                "Confirmed. Stay here: the safety-controlled 10-second countdown is starting."
            );
            await refreshWallet();
        } catch (error) {
            setMessage(error.message || "The feed could not be confirmed.", true);
            await refreshWallet();
        } finally {
            setSubmitting(false);
        }
    }

    async function cancelReservation() {
        if (!activeReservation || submitting) {
            return;
        }
        setSubmitting(true);
        try {
            const response = await apiClient.cancelFeedCreditReservation(
                activeReservation.reservationId,
                walletToken
            );
            setMessage(response.reservation.message);
            activeReservation = null;
            await refreshWallet();
        } catch (error) {
            setMessage(error.message || "The request could not be cancelled.", true);
        } finally {
            setSubmitting(false);
        }
    }

    async function refreshWallet() {
        if (!walletToken) {
            return;
        }
        try {
            const response = await apiClient.getFeedCreditWallet(walletToken);
            wallet = response.wallet;
            renderWallet();
            if (activeReservation?.status === "YOUR_TURN") {
                void heartbeat();
            }
        } catch (error) {
            if (error.statusCode === 401) {
                forgetWallet(false);
                setMessage(
                    "This wallet session is no longer valid on this browser. Create a new test wallet.",
                    true
                );
                return;
            }
            setMessage(error.message || "Wallet status is temporarily unavailable.", true);
        }
    }

    async function refreshPayment() {
        if (!trackedPaymentRequest?.paymentRequestId) {
            return;
        }
        try {
            const response = await paymentGateway.getPaymentRequest(
                trackedPaymentRequest.paymentRequestId,
                walletToken
            );
            trackedPaymentRequest = response.paymentRequest;
            elements.paymentStatus.textContent = formatState(
                trackedPaymentRequest.status
            );
            if (trackedPaymentRequest.status === "COMPLETED") {
                setMessage(
                    "Feed Credits added. No countdown has started—use a credit when you are ready."
                );
                await refreshWallet();
                window.clearInterval(paymentPollTimer);
                paymentPollTimer = null;
            } else if (["FAILED", "EXPIRED", "REFUNDED", "DISPUTED"].includes(
                trackedPaymentRequest.status
            )) {
                setMessage(trackedPaymentRequest.feeding?.message || "Payment status updated.");
                await refreshWallet();
                window.clearInterval(paymentPollTimer);
                paymentPollTimer = null;
            }
        } catch (error) {
            setMessage(error.message || "Payment status is temporarily unavailable.", true);
        }
    }

    function startPaymentTracking() {
        const parameters = new URLSearchParams(window.location.search);
        const paymentRequestId = parameters.get("payment_request_id");
        if (!paymentRequestId) {
            return;
        }
        trackedPaymentRequest = { paymentRequestId, status: "PENDING" };
        if (parameters.get("checkout") === "cancelled") {
            setMessage("Test checkout was cancelled. No credits were added and no feed started.");
        } else {
            setMessage("Checking the verified test payment. No feed can start from checkout.");
        }
        void refreshPayment();
        paymentPollTimer = window.setInterval(() => void refreshPayment(), 2000);
    }

    function forgetWallet(confirm = true) {
        if (confirm && !window.confirm(
            "Forget this wallet on this browser? Its private recovery token will be removed."
        )) {
            return;
        }
        window.localStorage.removeItem(WALLET_TOKEN_KEY);
        walletToken = null;
        wallet = null;
        activeReservation = null;
        if (walletPollTimer) {
            window.clearInterval(walletPollTimer);
            walletPollTimer = null;
        }
        renderWallet();
    }

    function startWalletPolling() {
        if (!walletToken || walletPollTimer) {
            return;
        }
        void refreshWallet();
        walletPollTimer = window.setInterval(() => void refreshWallet(), 1500);
    }

    elements.walletCreate.addEventListener("submit", event => void createWallet(event));
    elements.packButtons.forEach(button => {
        button.addEventListener("click", () => void buyPack(button.dataset.packId));
    });
    elements.useCredit.addEventListener("click", () => void reserveCredit());
    elements.confirmFeed.addEventListener("click", () => void confirmFeed());
    elements.cancelReservation.addEventListener("click", () => void cancelReservation());
    elements.forgetWallet.addEventListener("click", () => forgetWallet(true));
    document.addEventListener("visibilitychange", () => {
        renderWallet();
        if (document.visibilityState === "visible") {
            void heartbeat();
            void refreshWallet();
        }
    });
    eventEngine.subscribe(renderEventEngine);

    presenceTimer = window.setInterval(() => void heartbeat(), 5000);
    void presenceTimer;
    renderWallet();
    startWalletPolling();
    startPaymentTracking();
})();
