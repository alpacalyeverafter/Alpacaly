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
    const supporterMessage = document.getElementById("supporter-message");

    const requiredElements = {
        feedsDisplay,
        countdownDisplay,
        systemStatus,
        supporterName,
        sponsorButton,
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
        const busyStatuses = new Set([
            "QUEUED",
            "PREPARING",
            "CALLING_HERD",
            "FEEDING"
        ]);

        const busy = busyStatuses.has(state.status);
        sponsorButton.disabled = busy || state.feedsRemaining <= 0;
        sponsorButton.textContent = busy
            ? "Feeding in progress..."
            : "Test Sponsorship";
    }

    function renderState(state) {
        feedsDisplay.textContent = state.feedsRemaining;
        systemStatus.textContent = state.status
            .replaceAll("_", " ")
            .toLowerCase()
            .replace(/\b\w/g, letter => letter.toUpperCase());
        supporterMessage.textContent = state.message;

        if (state.status === "COMPLETE" && previousStatus !== "COMPLETE") {
            countdownSeconds = CONFIG.countdownSeconds;
            supporterName.value = "";
            updateCountdownDisplay();
        }

        setButtonForState(state);
        previousStatus = state.status;
    }

    function submitDemoFeed() {
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

        const event = eventEngine.createDonationEvent({
            supporterName: name,
            source: "website-demo",
            amount: 0,
            message: "Version 1 test sponsorship"
        });

        const result = eventEngine.submitEvent(event);

        if (!result.accepted) {
            supporterMessage.textContent = result.message || "The feed event was not accepted.";
        }
    }

    sponsorButton.addEventListener("click", submitDemoFeed);
    eventEngine.subscribe(renderState);

    updateCountdownDisplay();
    window.setInterval(tickCountdown, 1000);

    window.eventEngine = eventEngine;
    window.paymentGateway = paymentGateway;

    // Useful for safe browser-console testing during development.
    window.alpacalyEventEngine = eventEngine;
})();
