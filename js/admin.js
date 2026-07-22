// ============================================
// Alpacaly Ever After
// Server-backed admin dashboard
// ============================================

(() => {
    "use strict";

    const eventEngine = window.alpacalyEventEngine;
    const apiClient = window.alpacalyApiClient;
    const stateElements = {
        totalFeedsToday: document.getElementById("total-feeds-today"),
        feedsRemaining: document.getElementById("feeds-remaining"),
        queueSize: document.getElementById("queue-size"),
        totalPayments: document.getElementById("total-payments"),
        revenueToday: document.getElementById("revenue-today"),
        serverStatus: document.getElementById("server-status")
    };
    const historyList = document.getElementById("feed-history-list");
    const paymentActivityList = document.getElementById("payment-activity-list");
    const feedingNowElement = document.getElementById("feeding-now");
    const waitingQueueList = document.getElementById("waiting-queue-list");
    const emergencyStopList = document.getElementById("emergency-stop-list");
    const approvalRequestList = document.getElementById("approval-request-list");
    const resolutionCaseList = document.getElementById("resolution-case-list");
    const safetyActionStatus = document.getElementById("safety-action-status");
    const emergencyStopReason = document.getElementById("emergency-stop-reason");
    const activateEmergencyStopButton = document.getElementById(
        "activate-emergency-stop"
    );

    if (!eventEngine || !apiClient) {
        console.error("[Admin] Feed service modules were not loaded.");
        return;
    }

    let queueRefreshInFlight = false;
    let queueRefreshPending = false;
    let activeEventId = null;
    let administratorAuthenticated = false;
    let paymentRefreshInFlight = false;

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

    function createActionButton(label, action) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button";
        button.textContent = label;
        button.style.marginTop = "10px";
        button.style.marginRight = "8px";
        button.addEventListener("click", () => void action());
        return button;
    }

    function setSafetyStatus(message, isError = false) {
        safetyActionStatus.textContent = message;
        safetyActionStatus.style.color = isError ? "#9b1c1c" : "inherit";
    }

    function requiredAuthority(approvalRequest) {
        const represented = (approvalRequest.decisions || [])
            .filter(decision => decision.decision === "APPROVE")
            .map(decision => decision.authorityRepresented);
        const needed = [...(approvalRequest.requiredAuthorities || [])];
        represented.forEach(authority => {
            const index = needed.indexOf(authority);
            if (index >= 0) {
                needed.splice(index, 1);
            }
        });
        return needed[0] || approvalRequest.requiredAuthorities?.[0] || "WELFARE";
    }

    async function performSafetyAction(action, successMessage) {
        try {
            await action();
            setSafetyStatus(successMessage);
            await refreshSafety();
            await eventEngine.refreshStatus();
        } catch (error) {
            setSafetyStatus(error.message || "The safety action was rejected.", true);
        }
    }

    function renderEmergencyStops(stops) {
        emergencyStopList.replaceChildren();
        if (stops.length === 0) {
            emergencyStopList.append(createStatusItem(
                "No active emergency stops",
                "All emergency-stop controls are clear."
            ));
            return;
        }
        stops.forEach(stop => {
            const item = createStatusItem(
                `${stop.level} emergency stop`,
                `${stop.emergencyStopId} • Active since ${new Date(stop.activatedAt).toLocaleString()}`
            );
            item.style.marginBottom = "12px";
            item.append(createActionButton("Request clearance", async () => {
                const reason = window.prompt("Reason for requesting clearance:");
                if (!reason || !window.confirm(
                    "Request dual approval to clear this emergency stop?"
                )) {
                    return;
                }
                await performSafetyAction(
                    () => apiClient.requestEmergencyStopClear(
                        stop.emergencyStopId,
                        reason
                    ),
                    "Clearance request created. Two distinct authorised people must approve it."
                );
            }));
            emergencyStopList.append(item);
        });
    }

    function renderApprovalRequests(requests) {
        approvalRequestList.replaceChildren();
        const visible = requests.filter(request => [
            "PENDING", "PARTIALLY_APPROVED", "APPROVED"
        ].includes(request.status));
        if (visible.length === 0) {
            approvalRequestList.append(createStatusItem(
                "No pending safety approvals",
                "Critical actions awaiting a second person will appear here."
            ));
            return;
        }
        visible.forEach(approval => {
            const item = createStatusItem(
                approval.actionType.replaceAll("_", " "),
                `${approval.status} • expires ${new Date(approval.expiresAt).toLocaleString()} • ${approval.decisions.length}/2 decisions`
            );
            item.style.marginBottom = "12px";
            item.append(
                createActionButton("Approve", async () => {
                    const reason = window.prompt("Reason for approval:");
                    if (!reason || !window.confirm(
                        "Confirm this critical safety approval?"
                    )) {
                        return;
                    }
                    await performSafetyAction(
                        () => apiClient.decideApproval(
                            approval.approvalRequestId,
                            "APPROVE",
                            reason,
                            requiredAuthority(approval)
                        ),
                        "Approval recorded."
                    );
                }),
                createActionButton("Reject", async () => {
                    const reason = window.prompt("Reason for rejection:");
                    if (!reason || !window.confirm("Reject this critical action?")) {
                        return;
                    }
                    await performSafetyAction(
                        () => apiClient.decideApproval(
                            approval.approvalRequestId,
                            "REJECT",
                            reason,
                            requiredAuthority(approval)
                        ),
                        "Critical action rejected."
                    );
                })
            );
            approvalRequestList.append(item);
        });
    }

    function renderResolutionCases(cases) {
        resolutionCaseList.replaceChildren();
        if (cases.length === 0) {
            resolutionCaseList.append(createStatusItem(
                "No uncertain outcomes",
                "Uncertain physical dispense outcomes will be blocked here for review."
            ));
            return;
        }
        cases.forEach(resolutionCase => {
            const item = createStatusItem(
                `${resolutionCase.status} • ${resolutionCase.caseType.replaceAll("_", " ")}`,
                `${resolutionCase.resolutionCaseId} • Event ${resolutionCase.eventId} • ${resolutionCase.finalResolution || "Awaiting resolution"}`
            );
            item.style.marginBottom = "12px";
            if (resolutionCase.status === "OPEN") {
                [
                    "CONFIRMED_DISPENSED",
                    "CONFIRMED_NOT_DISPENSED",
                    "CANCELLED_FOR_WELFARE",
                    "MANUAL_REVIEW_REQUIRED"
                ].forEach(resolution => {
                    item.append(createActionButton(
                        resolution.replaceAll("_", " "),
                        async () => {
                            const reason = window.prompt(
                                `Reason for ${resolution.replaceAll("_", " ").toLowerCase()}:`
                            );
                            if (!reason || !window.confirm(
                                "Confirm this uncertain-outcome request?"
                            )) {
                                return;
                            }
                            await performSafetyAction(
                                () => apiClient.requestOutcomeResolution(
                                    resolutionCase.resolutionCaseId,
                                    resolution,
                                    reason,
                                    null
                                ),
                                resolution === "MANUAL_REVIEW_REQUIRED"
                                    ? "Case remains blocked for manual review."
                                    : "Resolution request created for dual approval."
                            );
                        }
                    ));
                });
            } else if (
                resolutionCase.finalResolution === "CONFIRMED_NOT_DISPENSED"
                && !resolutionCase.replacementCommandId
            ) {
                item.append(createActionButton("Request replacement command", async () => {
                    const reason = window.prompt("Reason for replacement command:");
                    if (!reason || !window.confirm(
                        "Request a separately approved replacement dispense command?"
                    )) {
                        return;
                    }
                    await performSafetyAction(
                        () => apiClient.requestReplacementCommand(
                            resolutionCase.resolutionCaseId,
                            reason
                        ),
                        "Replacement request created for dual approval."
                    );
                }));
            }
            resolutionCaseList.append(item);
        });
    }

    async function refreshSafety() {
        if (!administratorAuthenticated) {
            return;
        }
        try {
            const [stops, approvals, cases] = await Promise.all([
                apiClient.listEmergencyStops(CONFIG.defaultBarnId),
                apiClient.listApprovalRequests(CONFIG.defaultBarnId),
                apiClient.listResolutionCases(CONFIG.defaultBarnId)
            ]);
            renderEmergencyStops(stops.emergencyStops || []);
            renderApprovalRequests(approvals.approvalRequests || []);
            renderResolutionCases(cases.resolutionCases || []);
        } catch (error) {
            setSafetyStatus(
                error.message || "Safety controls are temporarily unavailable.",
                true
            );
        }
    }

    function renderPaymentActivity(payments, unavailableMessage = null) {
        paymentActivityList.replaceChildren();
        if (unavailableMessage) {
            paymentActivityList.append(createStatusItem(
                "Sandbox payments unavailable",
                unavailableMessage
            ));
            return;
        }
        if (payments.length === 0) {
            paymentActivityList.append(createStatusItem(
                "No sandbox payments yet",
                "Stripe Test Mode activity will appear here."
            ));
            return;
        }
        payments.forEach(payment => {
            const links = [
                `Payment ${payment.paymentRequestId}`,
                payment.contribution?.contributionId
                    ? `Contribution ${payment.contribution.contributionId}`
                    : "No Contribution",
                payment.feedIntent?.feedIntentId
                    ? `FeedIntent ${payment.feedIntent.feedIntentId} (${payment.feedIntent.status})`
                    : "No FeedIntent",
                payment.event?.eventId
                    ? `Event ${payment.event.eventId} (${payment.event.state})`
                    : "No Event",
                payment.failureCode ? `Failure ${payment.failureCode}` : null
            ].filter(Boolean).join(" • ");
            const item = createStatusItem(
                `${payment.supporterDisplayName || "Anonymous supporter"} • ${formatCurrency(
                    Number(payment.amountMinor || 0) / 100
                )} • ${payment.status}`,
                links
            );
            item.style.marginBottom = "12px";
            paymentActivityList.append(item);
        });
    }

    async function renderPayments() {
        if (!administratorAuthenticated || paymentRefreshInFlight) {
            return;
        }
        paymentRefreshInFlight = true;
        let payments;
        try {
            const response = await apiClient.listAdministratorPayments(100);
            payments = response.paymentRequests || [];
        } catch (error) {
            renderPaymentActivity([], error.message || "Please try again shortly.");
            paymentRefreshInFlight = false;
            return;
        }
        paymentRefreshInFlight = false;
        const today = new Date().toLocaleDateString("en-CA");
        const todaysPayments = payments.filter(payment => {
            if (!payment || !payment.completedAt) {
                return false;
            }

            const paymentDate = new Date(payment.completedAt);
            return !Number.isNaN(paymentDate.getTime())
                && paymentDate.toLocaleDateString("en-CA") === today;
        });
        const revenue = todaysPayments.reduce(
            (total, payment) => payment.status === "COMPLETED"
                ? total + (Number(payment.amountMinor || 0) / 100)
                : total,
            0
        );

        stateElements.totalPayments.textContent = String(todaysPayments.length);
        stateElements.revenueToday.textContent = formatCurrency(revenue);
        renderPaymentActivity(payments);
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
            void refreshSafety();
        }
    }

    async function initializeAdministrator() {
        try {
            await apiClient.getAdministratorSession();
            administratorAuthenticated = true;
            eventEngine.subscribe(renderState);
            renderState(eventEngine.getState());
            await renderPayments();
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

    renderPaymentActivity([]);
    renderHistory([]);
    renderEmergencyStops([]);
    renderApprovalRequests([]);
    renderResolutionCases([]);
    activateEmergencyStopButton?.addEventListener("click", () => {
        const reason = emergencyStopReason.value.trim();
        if (!reason) {
            setSafetyStatus("Enter a reason before activating an emergency stop.", true);
            return;
        }
        if (!window.confirm(
            "Activate the emergency stop now? Physical execution will be blocked immediately."
        )) {
            return;
        }
        void performSafetyAction(
            () => apiClient.activateEmergencyStop({
                level: "FEEDER",
                barnId: CONFIG.defaultBarnId,
                feederId: CONFIG.defaultFeederId,
                reason
            }),
            "Emergency stop activated."
        );
    });
    window.setInterval(() => void renderPayments(), 5000);
    void initializeAdministrator();
})();
