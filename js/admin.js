// ============================================
// Alpacaly Ever After
// Server-backed admin dashboard
// ============================================

(() => {
    "use strict";

    const eventEngine = window.alpacalyEventEngine;
    const apiClient = window.alpacalyApiClient;
    const PAYMENT_STORAGE_KEY = "alpacaly-payment-gateway";
    const stateElements = {
        totalFeedsToday: document.getElementById("total-feeds-today"),
        feedsRemaining: document.getElementById("feeds-remaining"),
        queueSize: document.getElementById("queue-size"),
        totalPayments: document.getElementById("total-payments"),
        revenueToday: document.getElementById("revenue-today"),
        serverStatus: document.getElementById("server-status")
    };
    const historyList = document.getElementById("feed-history-list");
    const feedingNowElement = document.getElementById("feeding-now");
    const waitingQueueList = document.getElementById("waiting-queue-list");

    if (!eventEngine || !apiClient) {
        console.error("[Admin] Feed service modules were not loaded.");
        return;
    }

    let queueRefreshInFlight = false;
    let queueRefreshPending = false;
    let activeEventId = null;
    let administratorAuthenticated = false;

    function formatCurrency(value) {
        return `£${Number(value || 0).toFixed(2)}`;
    }

    function formatDuration(milliseconds) {
        const totalSeconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
        if (totalSeconds === 0) {
            return "Now";
        }

        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }

    function createStatusItem(title, detail) {
        const item = document.createElement("li");
        item.className = "status-card";

        const heading = document.createElement("strong");
        heading.textContent = title;
        const description = document.createElement("span");
        description.textContent = detail;

        item.append(heading, description);
        return item;
    }

    function readSimulatedPayments() {
        if (!window.localStorage) {
            return [];
        }

        try {
            const storedPayments = window.localStorage.getItem(PAYMENT_STORAGE_KEY);
            if (!storedPayments) {
                return [];
            }

            const parsed = JSON.parse(storedPayments);
            if (parsed && typeof parsed === "object" && Array.isArray(parsed.payments)) {
                return parsed.payments;
            }

            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.warn("[Admin] Unable to read simulated payments.", error);
            return [];
        }
    }

    function renderPayments() {
        const payments = readSimulatedPayments();
        const today = new Date().toLocaleDateString("en-CA");
        const todaysPayments = payments.filter(payment => {
            if (!payment || payment.status !== "SUCCEEDED") {
                return false;
            }

            const paymentDate = new Date(payment.createdAt || payment.timestamp || Date.now());
            return !Number.isNaN(paymentDate.getTime())
                && paymentDate.toLocaleDateString("en-CA") === today;
        });
        const revenue = todaysPayments.reduce(
            (total, payment) => total + Number(payment.amount || 0),
            0
        );

        stateElements.totalPayments.textContent = String(todaysPayments.length);
        stateElements.revenueToday.textContent = formatCurrency(revenue);
    }

    function renderFeedingNow(state) {
        feedingNowElement.replaceChildren();

        const heading = document.createElement("strong");
        const detail = document.createElement("span");

        if (state.backendAvailable === false) {
            heading.textContent = "Feed service unavailable";
            detail.textContent = state.message || "Live feed data cannot be loaded right now.";
        } else if (state.currentEvent) {
            heading.textContent = state.currentEvent.supporterName || "Anonymous supporter";
            detail.textContent = [
                state.currentEvent.eventId,
                state.currentEvent.state || state.currentEvent.status || state.status,
                state.currentEvent.queuePosition
                    ? `Queue position ${state.currentEvent.queuePosition}`
                    : null,
                `Estimated wait ${formatDuration(state.currentEvent.estimatedWaitMs)}`
            ].filter(Boolean).join(" • ");
        } else {
            heading.textContent = "🦙 The alpacas are waiting for their next feed.";
            detail.textContent = "No active feed at the moment.";
        }

        feedingNowElement.append(heading, detail);
    }

    function renderWaitingQueue(feedRequests, unavailableMessage = null) {
        waitingQueueList.replaceChildren();

        if (unavailableMessage) {
            waitingQueueList.append(createStatusItem(
                "Queue temporarily unavailable",
                unavailableMessage
            ));
            return;
        }

        const waitingFeedRequests = feedRequests.filter(
            feedRequest => feedRequest.eventId !== activeEventId
        );

        if (waitingFeedRequests.length === 0) {
            waitingQueueList.append(createStatusItem(
                "🦙 The alpacas are waiting for their next feed.",
                "No supporters are currently waiting."
            ));
            return;
        }

        waitingFeedRequests.forEach(feedRequest => {
            const item = createStatusItem(
                feedRequest.supporterName || "Anonymous supporter",
                [
                    feedRequest.eventId,
                    feedRequest.status || "QUEUED",
                    feedRequest.queuePosition
                        ? `Queue position ${feedRequest.queuePosition}`
                        : null,
                    `Estimated wait ${formatDuration(feedRequest.estimatedWaitMs)}`
                ].filter(Boolean).join(" • ")
            );
            item.style.marginBottom = "12px";
            waitingQueueList.append(item);
        });
    }

    function renderHistory(archivedFeedRequests) {
        historyList.replaceChildren();

        if (archivedFeedRequests.length === 0) {
            historyList.append(createStatusItem(
                "No archived feed history yet",
                "Completed lifecycle events will appear here."
            ));
            return;
        }

        archivedFeedRequests.forEach(feedRequest => {
            const state = feedRequest.state || feedRequest.status || "ARCHIVED";
            const timelineLength = Array.isArray(feedRequest.timeline)
                ? feedRequest.timeline.length
                : 0;
            const item = createStatusItem(
                feedRequest.supporterName || "Anonymous supporter",
                `${feedRequest.eventId} • ${state} • ${timelineLength} timestamped states`
            );
            item.style.marginBottom = "12px";
            historyList.append(item);
        });
    }

    async function refreshQueue() {
        if (!administratorAuthenticated) {
            renderWaitingQueue([], "Administrator authentication is required.");
            return;
        }
        if (queueRefreshInFlight) {
            queueRefreshPending = true;
            return;
        }

        queueRefreshInFlight = true;
        let result;
        try {
            const response = await apiClient.listAdministratorFeedRequests(
                CONFIG.defaultBarnId,
                CONFIG.defaultFeederId
            );
            result = {
                success: true,
                feedRequests: response.feedRequests || [],
                archivedFeedRequests: response.archivedFeedRequests || [],
                queueStatistics: response.queueStatistics || null
            };
        } catch (error) {
            result = {
                success: false,
                message: error.message || "Administrator access is unavailable."
            };
        }
        queueRefreshInFlight = false;

        if (!result.success) {
            renderWaitingQueue([], result.message || "Please try again shortly.");
            return;
        }

        renderWaitingQueue(result.feedRequests);
        renderHistory(result.archivedFeedRequests);
        if (result.queueStatistics?.activeEvent) {
            renderFeedingNow({
                backendAvailable: true,
                currentEvent: result.queueStatistics.activeEvent,
                status: result.queueStatistics.activeEvent.state
            });
        }

        if (queueRefreshPending) {
            queueRefreshPending = false;
            void refreshQueue();
        }
    }

    function renderState(state) {
        stateElements.totalFeedsToday.textContent = String(state.completedFeeds || 0);
        stateElements.feedsRemaining.textContent = String(
            state.feedsRemaining ?? CONFIG.DEMO_MAX_FEEDS
        );
        stateElements.queueSize.textContent = String(state.queueSize || 0);
        stateElements.serverStatus.textContent = state.backendAvailable === false
            ? "Offline"
            : state.backendAvailable === true ? "Online" : "Connecting";
        activeEventId = state.currentEvent ? state.currentEvent.eventId : null;
        renderFeedingNow(state);

        if (state.backendAvailable === false) {
            renderWaitingQueue([], state.message || "Please try again shortly.");
        } else if (state.backendAvailable === true) {
            void refreshQueue();
        }
    }

    async function initializeAdministrator() {
        try {
            await apiClient.getAdministratorSession();
            administratorAuthenticated = true;
            eventEngine.subscribe(renderState);
            renderState(eventEngine.getState());
        } catch (error) {
            administratorAuthenticated = false;
            stateElements.serverStatus.textContent = "Authentication required";
            renderFeedingNow({
                backendAvailable: false,
                message: "Administrator authentication is required."
            });
            renderWaitingQueue([], "Administrator authentication is required.");
        }
    }

    renderPayments();
    renderHistory([]);
    window.setInterval(renderPayments, 1000);
    void initializeAdministrator();
})();
