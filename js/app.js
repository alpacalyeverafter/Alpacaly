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
        sponsorButton.textContent = "Test Sponsorship";
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

    function showSupporterConfirmation(name, event) {
        showTemporaryMessage(
            `Thank you, ${name}. Event ${event.eventId} is in queue position ${event.queuePosition}.`
        );
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
        renderTrackedEvent(state.trackedEvent, state.status);

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
        sponsorButton.textContent = "Submitting...";

        const event = eventEngine.createDonationEvent({
            supporterName: name,
            source: "website-demo",
            amount: 0,
            message: "Version 1 test sponsorship"
        });

        const result = await eventEngine.submitEvent(event);

        if (!result.accepted) {
            isSubmitting = false;
            sponsorButton.disabled = false;
            sponsorButton.textContent = "Test Sponsorship";
            supporterMessage.textContent = result.message || "The feed event was not accepted.";
            supporterName.focus();
            return;
        }

        const paymentResult = await paymentGateway.processPayment({
            supporterName: name,
            amount: 5,
            eventId: result.event.id
        });

        if (!paymentResult || !paymentResult.success) {
            supporterMessage.textContent = paymentResult && paymentResult.error
                ? paymentResult.error
                : "The payment could not be completed.";
            releaseSubmission();
            return;
        }

        supporterName.value = "";
        showSupporterConfirmation(name, result.event);
        releaseSubmission();
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

})();
