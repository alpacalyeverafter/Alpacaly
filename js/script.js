alert("javascript is connected"); 
let feedsRemaining = typeof CONFIG !== "undefined" && CONFIG.DEMO_MAX_FEEDS
    ? CONFIG.DEMO_MAX_FEEDS
    : 100;
let countdownSeconds = 10;
let sequenceRunning = false;

const feedsDisplay = document.getElementById("feeds-remaining");
const countdownDisplay = document.getElementById("countdown");
const systemStatus = document.getElementById("system-status");
const supporterName = document.getElementById("supporter-name");
const sponsorButton = document.getElementById("test-sponsor");
const supporterMessage = document.getElementById("supporter-message");

function updateCountdown() {
    const minutes = Math.floor(countdownSeconds / 60);
    const seconds = countdownSeconds % 60;

    countdownDisplay.textContent =
        `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

    if (countdownSeconds > 0) {
        countdownSeconds--;
    } else {
        countdownDisplay.textContent = "Available";
    }
}

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function runDemoFeed() {
    const name = supporterName.value.trim();

    if (sequenceRunning) {
        return;
    }

    if (name === "") {
        supporterMessage.textContent = "Please enter a supporter name.";
        return;
    }

    if (feedsRemaining <= 0) {
        supporterMessage.textContent =
            "Today's scheduled feeds are complete.";
        return;
    }

    if (countdownSeconds > 0) {
        supporterMessage.textContent =
            "The next scheduled feed is not available yet.";
        return;
    }

    sequenceRunning = true;
    sponsorButton.disabled = true;
    sponsorButton.textContent = "Feeding in progress...";
    systemStatus.textContent = "Preparing";

    supporterMessage.textContent =
        `Thank you, ${name}. Your demo sponsorship has been received.`;

    await wait(2000);

    systemStatus.textContent = "Calling Herd";
    supporterMessage.textContent =
        "Bell ringing. The animals are being alerted.";

    await wait(3000);

    systemStatus.textContent = "Feeding";
    supporterMessage.textContent =
        "A measured demo feed is being released.";

    await wait(2000);

    feedsRemaining--;
    feedsDisplay.textContent = feedsRemaining;

    systemStatus.textContent = "Complete";
    supporterMessage.textContent =
        `Feed complete. Thank you, ${name}.`;

    countdownSeconds = 10;

    await wait(2000);

    systemStatus.textContent = "Ready";
    supporterName.value = "";
    sponsorButton.disabled = false;
    sponsorButton.textContent = "Test Sponsorship";
    sequenceRunning = false;
}

sponsorButton.addEventListener("click", runDemoFeed);

setInterval(updateCountdown, 1000);
updateCountdown();