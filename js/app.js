// ============================================
// Alpacaly Ever After
// Website to Event Engine connection
// ============================================

(() => {
    "use strict";

    const feedsDisplay = document.getElementById("feeds-remaining");
    const countdownDisplay = document.getElementById("countdown");
    const systemStatus = document.getElementById("system-status");
    const supporterName = document.getElementById("supporter-name");
    const sponsorButton = document.getElementById("test-sponsor");
    const resetDemoButton = document.getElementById("reset-demo");
    const supporterMessage = document.getElementById("supporter-message");

    const requiredElements = {
        feedsDisplay,
        countdownDisplay,
        systemStatus,
        supporterName,
        sponsorButton,
        resetDemoButton,
        supporterMessage
    };

    const missing = Object.entries(requiredElements)
        .filter(([, element]) => !element)
        .map(([name]) => name);

    if (missing.length > 0) {
        console.error("[App] Missing required page elements:", missing);
        return;
    }

    let countdownSeconds = CONFIG.countdownSeconds;
    let previousStatus = null;
    let isSubmitting = false;
    let confirmationTimeoutId = null;

    function formatCountdown(totalSeconds) {
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    function updateCountdownDisplay() {
        countdownDisplay.textContent = countdownSeconds > 0
            ? formatCountdown(countdownSeconds)
            : "Available";
    }

    function tickCountdown() {
        if (countdownSeconds > 0) {
            countdownSeconds -= 1;
            updateCountdownDisplay();
        }
    }

    function setButtonForState(state) {
        sponsorButton.disabled = isSubmitting || state.feedsRemaining <= 0;
        sponsorButton.textContent = "Test Sponsorship";
    }

    function clearSupporterConfirmation() {
        if (confirmationTimeoutId) {
            window.clearTimeout(confirmationTimeoutId);
            confirmationTimeoutId = null;
        }

        supporterMessage.textContent = "";
    }

    function showSupporterConfirmation(name) {
        clearSupporterConfirmation();
        supporterMessage.textContent = `Thank you, ${name}. Your feed has joined the queue.`;
        confirmationTimeoutId = window.setTimeout(() => {
            confirmationTimeoutId = null;
            supporterMessage.textContent = "";
        }, 5000);
    }

    function renderState(state) {
        feedsDisplay.textContent = state.feedsRemaining ?? CONFIG.DEMO_MAX_FEEDS;
        systemStatus.textContent = state.status
            .replaceAll("_", " ")
            .toLowerCase()
            .replace(/\b\w/g, letter => letter.toUpperCase());

        if (state.status === "COMPLETE" && previousStatus !== "COMPLETE") {
            countdownSeconds = CONFIG.countdownSeconds;
            supporterName.value = "";
            updateCountdownDisplay();
        }

        setButtonForState(state);
        previousStatus = state.status;
    }

    function releaseSubmission() {
        isSubmitting = false;
        sponsorButton.disabled = false;
        sponsorButton.textContent = "Test Sponsorship";
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

        if (countdownSeconds > 0) {
            supporterMessage.textContent = "The next scheduled feed is not available yet.";
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

        const result = eventEngine.submitEvent(event);

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
            eventId: event.id
        });

        if (!paymentResult || !paymentResult.success) {
            supporterMessage.textContent = paymentResult && paymentResult.error
                ? paymentResult.error
                : "The payment could not be completed.";
            releaseSubmission();
            return;
        }

        supporterName.value = "";
        showSupporterConfirmation(name);
        releaseSubmission();
    }

    function resetDemo() {
        if (typeof eventEngine.resetDemo === "function") {
            eventEngine.resetDemo();
        }
    }

    sponsorButton.addEventListener("click", submitDemoFeed);
    resetDemoButton.addEventListener("click", resetDemo);
    eventEngine.subscribe(renderState);

    updateCountdownDisplay();
    window.setInterval(tickCountdown, 1000);

    window.eventEngine = eventEngine;
    window.paymentGateway = paymentGateway;

    // Useful for safe browser-console testing during development.
    window.alpacalyEventEngine = eventEngine;
})();
