// ============================================
// Alpacaly Ever After
// Website to Event Engine connection
// ============================================

(() => {
    "use strict";

    const eventEngine = window.alpacalyEventEngine;
    const paymentGateway = window.paymentGateway;

    const feedsDisplay = document.getElementById("feeds-remaining");
    const queuePositionDisplay = document.getElementById("queue-position");
    const estimatedWaitDisplay = document.getElementById("estimated-wait");
    const systemStatus = document.getElementById("system-status");
    const eventIdDisplay = document.getElementById("event-id");
    const paymentStatusDisplay = document.getElementById("payment-status");
    const supporterName = document.getElementById("supporter-name");
    const sponsorButton = document.getElementById("test-sponsor");
    const resetDemoButton = document.getElementById("reset-demo");
    const supporterMessage = document.getElementById("supporter-message");

    const requiredElements = {
        feedsDisplay,
        queuePositionDisplay,
        estimatedWaitDisplay,
        systemStatus,
        eventIdDisplay,
        paymentStatusDisplay,
        supporterName,
        sponsorButton,
        resetDemoButton,
        supporterMessage
    };

    if (!eventEngine || !paymentGateway) {
        console.error("[App] Feed service modules were not loaded.");
        return;
    }

    const missing = Object.entries(requiredElements)
        .filter(([, element]) => !element)
        .map(([name]) => name);

    if (missing.length > 0) {
        console.error("[App] Missing required page elements:", missing);
        return;
    }

    let previousStatus = null;
    let previousBackendAvailable = null;
    let isSubmitting = false;
    let confirmationTimeoutId = null;
    let trackedPaymentRequest = null;
    let paymentPollTimerId = null;

    function formatDuration(milliseconds) {
        const totalSeconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
        if (totalSeconds === 0) {
            return "Now";
        }

        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }

    function setButtonForState(state) {
        sponsorButton.disabled = isSubmitting
            || state.feedsRemaining <= 0
            || state.backendAvailable === false;
        sponsorButton.textContent = "Sponsor a £5 Test Feed";
    }

    function clearSupporterConfirmation() {
        if (confirmationTimeoutId) {
            window.clearTimeout(confirmationTimeoutId);
            confirmationTimeoutId = null;
        }

        supporterMessage.textContent = "";
    }

    function showTemporaryMessage(message) {
        clearSupporterConfirmation();
        supporterMessage.textContent = message;
        confirmationTimeoutId = window.setTimeout(() => {
            confirmationTimeoutId = null;
            supporterMessage.textContent = "";
        }, 5000);
    }

    function showSupporterConfirmation(paymentRequest) {
        const event = paymentRequest.event;
        showTemporaryMessage(
            event
                ? `Sandbox payment confirmed. Event ${event.eventId} is in queue position ${event.queuePosition ?? "—"}.`
                : paymentRequest.feeding?.message
                    || "Sandbox payment status updated."
        );
    }

    function renderPaymentRequest(paymentRequest) {
        trackedPaymentRequest = paymentRequest;
        paymentStatusDisplay.textContent = formatState(paymentRequest.status);
        const event = paymentRequest.event;
        if (event) {
            queuePositionDisplay.textContent = event.queuePosition === null
                ? formatState(event.state)
                : String(event.queuePosition);
            estimatedWaitDisplay.textContent = event.queuePosition === null
                ? `Estimated wait: ${formatState(event.state)}`
                : `Estimated wait: ${formatDuration(event.estimatedWaitMs)}`;
            eventIdDisplay.textContent = `Event ID: ${event.eventId}`;
            systemStatus.textContent = formatState(event.state);
        } else {
            queuePositionDisplay.textContent = "—";
            estimatedWaitDisplay.textContent = "Estimated wait: —";
            eventIdDisplay.textContent = paymentRequest.status === "COMPLETED"
                ? "Event ID: pending Event Engine acceptance"
                : "Event ID: —";
            systemStatus.textContent = formatState(
                paymentRequest.feeding?.status || paymentRequest.status
            );
        }
    }

    function renderTrackedEvent(trackedEvent, fallbackStatus) {
        if (!trackedEvent) {
            queuePositionDisplay.textContent = "—";
            estimatedWaitDisplay.textContent = "Estimated wait: —";
            eventIdDisplay.textContent = "Event ID: —";
            systemStatus.textContent = formatState(fallbackStatus);
            return;
        }

        queuePositionDisplay.textContent = trackedEvent.queuePosition === null
            ? "Complete"
            : String(trackedEvent.queuePosition);
        estimatedWaitDisplay.textContent = trackedEvent.queuePosition === null
            ? "Estimated wait: Complete"
            : `Estimated wait: ${formatDuration(trackedEvent.estimatedWaitMs)}`;
        eventIdDisplay.textContent = `Event ID: ${trackedEvent.eventId}`;
        systemStatus.textContent = formatState(trackedEvent.state || trackedEvent.status);
    }

    function formatState(state) {
        return String(state || "READY")
            .replaceAll("_", " ")
            .toLowerCase()
            .replace(/\b\w/g, letter => letter.toUpperCase());
    }

    function renderState(state) {
        feedsDisplay.textContent = state.feedsRemaining ?? CONFIG.DEMO_MAX_FEEDS;
        if (trackedPaymentRequest) {
            renderPaymentRequest(trackedPaymentRequest);
        } else {
            paymentStatusDisplay.textContent = "Sandbox ready";
            renderTrackedEvent(state.trackedEvent, state.status);
        }

        const trackedStatus = state.trackedEvent
            ? state.trackedEvent.state || state.trackedEvent.status
            : state.status;
        if (trackedStatus === "COMPLETE" && previousStatus !== "COMPLETE") {
            supporterName.value = "";
        }

        if (state.backendAvailable === false && !isSubmitting) {
            clearSupporterConfirmation();
            supporterMessage.textContent = state.message
                || "The feed service is unavailable. Please try again shortly.";
        } else if (
            state.backendAvailable === true
            && previousBackendAvailable === false
            && !isSubmitting
        ) {
            showTemporaryMessage("Feed service reconnected.");
        }

        setButtonForState(state);
        previousStatus = trackedStatus;
        previousBackendAvailable = state.backendAvailable;
    }

    function releaseSubmission() {
        isSubmitting = false;
        setButtonForState(eventEngine.getState());
        supporterName.focus();
    }

    async function submitDemoFeed() {
        if (isSubmitting) {
            return;
        }

        const name = supporterName.value.trim();

        if (!name) {
            supporterMessage.textContent = "Please enter a supporter name.";
            supporterName.focus();
            return;
        }

        isSubmitting = true;
        sponsorButton.disabled = true;
        sponsorButton.textContent = "Opening test checkout...";

        try {
            const result = await paymentGateway.createCheckoutSession({
                supporterName: name,
                clientRequestId: eventEngine.generateClientRequestId("stripe-test")
            });
            if (!result?.checkoutUrl) {
                throw new Error("The sandbox checkout URL was not returned.");
            }
            supporterName.value = "";
            trackedPaymentRequest = result.paymentRequest;
            renderPaymentRequest(result.paymentRequest);
            supporterMessage.textContent =
                "Opening Stripe Test Mode. No live payment details should be used.";
            releaseSubmission();
            window.location.assign(result.checkoutUrl);
        } catch (error) {
            supporterMessage.textContent = error.message
                || "The sandbox checkout could not be opened.";
            releaseSubmission();
        }
    }

    async function refreshTrackedPayment() {
        if (!trackedPaymentRequest?.paymentRequestId) {
            return;
        }
        try {
            const response = await paymentGateway.getPaymentRequest(
                trackedPaymentRequest.paymentRequestId
            );
            const priorStatus = trackedPaymentRequest.status;
            renderPaymentRequest(response.paymentRequest);
            if (response.paymentRequest.status !== priorStatus) {
                showSupporterConfirmation(response.paymentRequest);
            } else if (response.paymentRequest.feeding?.message) {
                supporterMessage.textContent = response.paymentRequest.feeding.message;
            }
        } catch (error) {
            supporterMessage.textContent = error.message
                || "Payment status is temporarily unavailable.";
        }
    }

    function startPaymentTracking() {
        const parameters = new URLSearchParams(window.location.search);
        const paymentRequestId = parameters.get("payment_request_id");
        if (!paymentRequestId) {
            return;
        }
        trackedPaymentRequest = {
            paymentRequestId,
            status: "PENDING",
            event: null,
            feeding: { status: "PAYMENT_PENDING" }
        };
        if (parameters.get("checkout") === "cancelled") {
            supporterMessage.textContent =
                "Test checkout was cancelled. No feed request is created unless payment is verified.";
        } else {
            supporterMessage.textContent = "Checking the verified sandbox payment status...";
        }
        void refreshTrackedPayment();
        paymentPollTimerId = window.setInterval(
            () => void refreshTrackedPayment(),
            2000
        );
    }

    async function resetDemo() {
        if (isSubmitting || typeof eventEngine.resetDemo !== "function") {
            return;
        }

        isSubmitting = true;
        resetDemoButton.disabled = true;
        supporterMessage.textContent = "Resetting demo queue...";

        const result = await eventEngine.resetDemo();
        if (result.success) {
            trackedPaymentRequest = null;
            if (paymentPollTimerId) {
                window.clearInterval(paymentPollTimerId);
                paymentPollTimerId = null;
            }
            supporterMessage.textContent = "Demo queue reset. Ready for the next supporter.";
        } else {
            supporterMessage.textContent = result.message
                || "The demo queue could not be reset.";
        }

        isSubmitting = false;
        resetDemoButton.disabled = false;
        setButtonForState(eventEngine.getState());
    }

    sponsorButton.addEventListener("click", submitDemoFeed);
    resetDemoButton.addEventListener("click", resetDemo);
    eventEngine.subscribe(renderState);
    startPaymentTracking();

})();
