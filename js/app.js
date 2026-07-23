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
        walletHistory: document.getElementById("wallet-history-list"),
        accountStatus: document.getElementById("supporter-account-status"),
        accountSignedOut: document.getElementById("supporter-account-signed-out"),
        accountSignedIn: document.getElementById("supporter-account-signed-in"),
        accountSignIn: document.getElementById("supporter-account-sign-in"),
        accountLogout: document.getElementById("supporter-account-logout"),
        accountEmail: document.getElementById("supporter-account-email"),
        accountWalletCount: document.getElementById("supporter-account-wallet-count"),
        accountMessage: document.getElementById("supporter-account-message"),
        linkWallet: document.getElementById("link-supporter-wallet"),
        exportAccount: document.getElementById("export-supporter-account"),
        deleteAccount: document.getElementById("delete-supporter-account"),
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
    let accountSession = null;
    let accountWalletId = null;
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

    function setAccountMessage(message, error = false) {
        elements.accountMessage.textContent = message || "";
        elements.accountMessage.classList.toggle("supporter-message-error", error);
    }

    function hasWalletAccess() {
        return Boolean(walletToken || accountWalletId);
    }

    function walletAccess() {
        return {
            walletToken: walletToken || null,
            walletId: walletToken ? null : accountWalletId
        };
    }

    function renderAccount() {
        const authenticated = accountSession?.authenticated === true;
        elements.accountSignedOut.hidden = authenticated;
        elements.accountSignedIn.hidden = !authenticated;
        elements.accountStatus.textContent = authenticated
            ? "Protected account"
            : accountSession?.accountsAvailable === false
                ? "Guest wallets available"
                : "Optional";
        elements.accountSignIn.hidden = accountSession?.accountsAvailable === false;
        elements.accountSignIn.href =
            `${apiClient.baseUrl}/api/supporter-accounts/login`;
        elements.accountLogout.href =
            `${apiClient.baseUrl}/api/supporter-accounts/logout`;
        if (!authenticated) {
            return;
        }
        elements.accountEmail.textContent = accountSession.account?.email
            || accountSession.account?.displayName
            || "Supporter";
        const walletCount = accountSession.wallets?.length || 0;
        elements.accountWalletCount.textContent = walletCount === 1
            ? "1 wallet is protected."
            : `${walletCount} wallets are protected.`;
        elements.linkWallet.hidden = !walletToken;
    }

    function historyLabel(entry) {
        const labels = {
            PURCHASE: "Feed Credits purchased",
            RESERVATION: "Feed Credit reserved",
            REDEMPTION: "Feed Credit used",
            RELEASE: "Feed Credit returned",
            REFUND_ADJUSTMENT: "Refund adjustment",
            ADMIN_CORRECTION: "Administrative correction"
        };
        return labels[entry.entryType] || formatState(entry.entryType);
    }

    function renderWalletHistory() {
        elements.walletHistory.replaceChildren();
        const entries = wallet?.ledgerEntries || [];
        if (entries.length === 0) {
            const item = document.createElement("li");
            item.textContent = "No wallet activity yet.";
            elements.walletHistory.append(item);
            return;
        }
        entries.slice(0, 20).forEach(entry => {
            const item = document.createElement("li");
            const label = document.createElement("strong");
            label.textContent = historyLabel(entry);
            const detail = document.createElement("span");
            detail.textContent = new Date(entry.createdAt).toLocaleString();
            item.append(label, detail);
            elements.walletHistory.append(item);
        });
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
        const hasWallet = Boolean(wallet && hasWalletAccess());
        elements.walletCreate.hidden = hasWallet;
        elements.walletDashboard.hidden = !hasWallet;
        if (!hasWallet) {
            stopCountdown();
            return;
        }

        const balance = wallet.balance || {};
        elements.walletName.textContent = wallet.supporterDisplayName;
        elements.forgetWallet.hidden = !walletToken;
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
        renderWalletHistory();
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
            renderAccount();
            setMessage("Private Feed Credit wallet created on this browser.");
            startWalletPolling();
        } catch (error) {
            setMessage(error.message || "The wallet could not be created.", true);
        } finally {
            setSubmitting(false);
        }
    }

    async function buyPack(packId) {
        if (!hasWalletAccess() || submitting) {
            return;
        }
        setSubmitting(true);
        setMessage("Opening Stripe Test Mode. Buying credits will not start a feed.");
        try {
            const result = await paymentGateway.createCheckoutSession({
                packId,
                clientRequestId: requestId("credit-purchase"),
                ...walletAccess()
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
        if (!hasWalletAccess() || submitting) {
            return;
        }
        setSubmitting(true);
        try {
            const response = await apiClient.reserveFeedCredit({
                clientRequestId: requestId("credit-feed"),
                ...walletAccess()
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
            !hasWalletAccess()
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
                true,
                accountWalletId
            );
            activeReservation = response.reservation;
        } catch (error) {
            if (error.statusCode === 401 && walletToken) {
                forgetWallet(false);
            } else if (error.statusCode === 401) {
                accountWalletId = null;
                wallet = null;
                setAccountMessage("Your account session has expired. Sign in again.", true);
                renderWallet();
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
                walletToken,
                accountWalletId
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
                walletToken,
                accountWalletId
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
        if (!hasWalletAccess()) {
            return;
        }
        try {
            const response = await apiClient.getFeedCreditWallet(
                walletToken,
                accountWalletId
            );
            wallet = response.wallet;
            renderWallet();
            if (activeReservation?.status === "YOUR_TURN") {
                void heartbeat();
            }
        } catch (error) {
            if (error.statusCode === 401 && walletToken) {
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
                walletToken,
                accountWalletId
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
        const protectedWallet = accountSession?.authenticated
            ? accountSession.wallets?.[0] || null
            : null;
        accountWalletId = protectedWallet?.walletId || null;
        wallet = protectedWallet;
        activeReservation = null;
        if (walletPollTimer) {
            window.clearInterval(walletPollTimer);
            walletPollTimer = null;
        }
        renderAccount();
        renderWallet();
        if (protectedWallet) {
            setMessage("Your protected account wallet is ready.");
            startWalletPolling();
        }
    }

    function startWalletPolling() {
        if (!hasWalletAccess() || walletPollTimer) {
            return;
        }
        void refreshWallet();
        walletPollTimer = window.setInterval(() => void refreshWallet(), 1500);
    }

    async function refreshAccountSession() {
        try {
            accountSession = await apiClient.getSupporterAccountSession();
            apiClient.setSupporterAccountSession(accountSession);
            if (accountSession.authenticated && !walletToken) {
                accountWalletId = accountSession.wallets?.[0]?.walletId || null;
                wallet = accountSession.wallets?.[0] || null;
            } else if (!accountSession.authenticated) {
                accountWalletId = null;
            }
            renderAccount();
            renderWallet();
        } catch (error) {
            accountSession = { authenticated: false, accountsAvailable: false };
            apiClient.setSupporterAccountSession(null);
            renderAccount();
            setAccountMessage(
                "Account protection is temporarily unavailable. Guest wallets still work.",
                true
            );
        }
    }

    async function linkCurrentWallet() {
        if (!walletToken || !accountSession?.authenticated || submitting) {
            return;
        }
        setSubmitting(true);
        try {
            const response = await apiClient.linkSupporterWallet(
                walletToken,
                requestId("wallet-link")
            );
            accountSession = response.session;
            apiClient.setSupporterAccountSession(accountSession);
            accountWalletId = response.walletId;
            window.localStorage.removeItem(WALLET_TOKEN_KEY);
            walletToken = null;
            wallet = accountSession.wallets.find(
                item => item.walletId === accountWalletId
            ) || null;
            setAccountMessage("This wallet is now protected by your account.");
            renderAccount();
            renderWallet();
            startWalletPolling();
        } catch (error) {
            setAccountMessage(error.message || "The wallet could not be protected.", true);
        } finally {
            setSubmitting(false);
        }
    }

    function downloadJson(filename, value) {
        const blob = new Blob([JSON.stringify(value, null, 2)], {
            type: "application/json"
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }

    async function exportAccount() {
        try {
            const response = await apiClient.exportSupporterAccount();
            downloadJson("alpacaly-supporter-data.json", response.export);
            setAccountMessage("Your account data download is ready.");
        } catch (error) {
            setAccountMessage(error.message || "Your data could not be downloaded.", true);
        }
    }

    async function deleteAccount() {
        if (!window.confirm(
            "Delete your account? Linked wallets will return to guest recovery and you must save the downloaded recovery file."
        )) {
            return;
        }
        try {
            const response = await apiClient.deleteSupporterAccount();
            if (response.guestWalletRecovery?.length) {
                downloadJson(
                    "alpacaly-wallet-recovery-private.json",
                    response.guestWalletRecovery
                );
                const first = response.guestWalletRecovery[0];
                window.localStorage.setItem(WALLET_TOKEN_KEY, first.recoveryToken);
            }
            window.location.assign(
                `${apiClient.baseUrl}/api/supporter-accounts/logout`
            );
        } catch (error) {
            setAccountMessage(error.message || "The account could not be deleted.", true);
        }
    }

    elements.walletCreate.addEventListener("submit", event => void createWallet(event));
    elements.packButtons.forEach(button => {
        button.addEventListener("click", () => void buyPack(button.dataset.packId));
    });
    elements.useCredit.addEventListener("click", () => void reserveCredit());
    elements.confirmFeed.addEventListener("click", () => void confirmFeed());
    elements.cancelReservation.addEventListener("click", () => void cancelReservation());
    elements.forgetWallet.addEventListener("click", () => forgetWallet(true));
    elements.linkWallet.addEventListener("click", () => void linkCurrentWallet());
    elements.exportAccount.addEventListener("click", () => void exportAccount());
    elements.deleteAccount.addEventListener("click", () => void deleteAccount());
    document.addEventListener("visibilitychange", () => {
        renderWallet();
        if (document.visibilityState === "visible") {
            void heartbeat();
            void refreshAccountSession();
            void refreshWallet();
        }
    });
    eventEngine.subscribe(renderEventEngine);

    presenceTimer = window.setInterval(() => void heartbeat(), 5000);
    void presenceTimer;
    renderAccount();
    renderWallet();
    void (async () => {
        await refreshAccountSession();
        startWalletPolling();
        startPaymentTracking();
    })();
})();
