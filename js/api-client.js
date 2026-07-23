// ============================================
// Alpacaly Ever After
// Reusable backend API client
// ============================================

(function exposeApiClient(global) {
    "use strict";

    class ApiClientError extends Error {
        constructor(message, {
            code = "API_ERROR",
            statusCode = null,
            details = null,
            cause = null
        } = {}) {
            super(message);
            this.name = "ApiClientError";
            this.code = code;
            this.statusCode = statusCode;
            this.details = details;
            this.cause = cause;
        }
    }

    class AlpacalyApiClient {
        constructor({
            baseUrl = "",
            timeoutMs = 5000,
            developmentAdministratorIdentity = null,
            developmentSupporterIdentity = null,
            fetchImpl = global.fetch ? global.fetch.bind(global) : null,
            eventSourceFactory = global.EventSource
                ? url => new global.EventSource(url)
                : null
        } = {}) {
            this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
            this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000;
            this.developmentAdministratorIdentity =
                developmentAdministratorIdentity
                    ? String(developmentAdministratorIdentity)
                    : null;
            this.developmentSupporterIdentity = developmentSupporterIdentity
                ? String(developmentSupporterIdentity)
                : null;
            this.supporterCsrfToken = null;
            this.supporterWalletId = null;
            this.fetchImpl = fetchImpl;
            this.eventSourceFactory = eventSourceFactory;
        }

        health() {
            return this.request("/health");
        }

        getEventEngineStatus() {
            return this.request("/api/event-engine/status");
        }

        listFeedRequests() {
            return this.request("/api/feed-requests");
        }

        createFeedRequest(feedRequest) {
            return this.request("/api/development/website-contributions", {
                method: "POST",
                body: feedRequest
            });
        }

        createSandboxCheckoutSession(paymentRequest) {
            return this.request("/api/payments/checkout-sessions", {
                method: "POST",
                body: paymentRequest,
                walletToken: paymentRequest.walletToken
            });
        }

        listFeedCreditPacks() {
            return this.request("/api/feed-credits/packs");
        }

        createFeedCreditWallet(supporterName) {
            return this.request("/api/feed-credits/wallets", {
                method: "POST",
                body: { supporterName }
            });
        }

        getFeedCreditWallet(walletToken = null, walletId = null) {
            return this.request("/api/feed-credits/wallet", {
                walletToken,
                walletId,
                supporter: Boolean(walletId)
            });
        }

        createFeedCreditCheckout({ packId, clientRequestId, walletToken, walletId }) {
            return this.request("/api/feed-credits/checkout-sessions", {
                method: "POST",
                body: { packId, clientRequestId },
                walletToken,
                walletId,
                supporter: Boolean(walletId)
            });
        }

        reserveFeedCredit({ clientRequestId, walletToken, walletId }) {
            return this.request("/api/feed-credits/reservations", {
                method: "POST",
                body: { clientRequestId },
                walletToken,
                walletId,
                supporter: Boolean(walletId)
            });
        }

        heartbeatFeedCreditReservation(
            reservationId,
            walletToken,
            active = true,
            walletId = null
        ) {
            return this.request(
                `/api/feed-credits/reservations/${encodeURIComponent(reservationId)}/presence`,
                {
                    method: "POST",
                    body: { active },
                    walletToken,
                    walletId,
                    supporter: Boolean(walletId)
                }
            );
        }

        confirmFeedCreditReservation(reservationId, walletToken, walletId = null) {
            return this.request(
                `/api/feed-credits/reservations/${encodeURIComponent(reservationId)}/confirm`,
                {
                    method: "POST",
                    body: {},
                    walletToken,
                    walletId,
                    supporter: Boolean(walletId)
                }
            );
        }

        cancelFeedCreditReservation(reservationId, walletToken, walletId = null) {
            return this.request(
                `/api/feed-credits/reservations/${encodeURIComponent(reservationId)}/cancel`,
                {
                    method: "POST",
                    body: {},
                    walletToken,
                    walletId,
                    supporter: Boolean(walletId)
                }
            );
        }

        getPaymentRequest(paymentRequestId, walletToken = null, walletId = null) {
            return this.request(
                `/api/payments/requests/${encodeURIComponent(paymentRequestId)}`,
                { walletToken, walletId, supporter: Boolean(walletId) }
            );
        }

        getSupporterAccountSession() {
            return this.request("/api/supporter-accounts/session", {
                supporter: true
            });
        }

        setSupporterAccountSession(session) {
            this.supporterCsrfToken = session?.csrfToken || null;
            this.supporterWalletId = session?.wallets?.[0]?.walletId || null;
        }

        linkSupporterWallet(walletToken, clientRequestId) {
            return this.request("/api/supporter-accounts/wallets/link", {
                method: "POST",
                body: { clientRequestId },
                walletToken,
                supporter: true,
                csrfToken: this.supporterCsrfToken
            });
        }

        revokeSupporterSessions() {
            return this.request("/api/supporter-accounts/sessions/revoke-all", {
                method: "POST",
                body: {},
                supporter: true,
                csrfToken: this.supporterCsrfToken
            });
        }

        exportSupporterAccount() {
            return this.request("/api/supporter-accounts/export", {
                supporter: true
            });
        }

        deleteSupporterAccount() {
            return this.request("/api/supporter-accounts/delete", {
                method: "POST",
                body: { confirmation: "DELETE MY ACCOUNT" },
                supporter: true,
                csrfToken: this.supporterCsrfToken
            });
        }

        getFeedRequest(feedRequestId) {
            return this.request(`/api/feed-requests/${encodeURIComponent(feedRequestId)}`);
        }

        resetEventEngine() {
            return this.request("/api/event-engine/reset", {
                method: "POST",
                body: { reason: "LOCAL_DEVELOPMENT_RESET" },
                administrator: true
            });
        }

        getAdministratorSession() {
            return this.request("/api/admin/session", { administrator: true });
        }

        setDevelopmentAdministratorIdentity(identity) {
            this.developmentAdministratorIdentity = identity
                ? String(identity)
                : null;
        }

        listAdministratorFeedRequests(barnId, feederId) {
            return this.request(
                `/api/admin/barns/${encodeURIComponent(barnId)}`
                + `/feeders/${encodeURIComponent(feederId)}/feed-requests`,
                { administrator: true }
            );
        }

        listAdministratorPayments(limit = 100) {
            return this.request(
                `/api/admin/payments?limit=${encodeURIComponent(limit)}`,
                { administrator: true }
            );
        }

        getAdministratorFeedCredits(limit = 100) {
            return this.request(
                `/api/admin/feed-credits?limit=${encodeURIComponent(limit)}`,
                { administrator: true }
            );
        }

        correctFeedCreditWallet(walletId, correction) {
            return this.request(
                `/api/admin/feed-credits/wallets/${encodeURIComponent(walletId)}/corrections`,
                { method: "POST", body: correction, administrator: true }
            );
        }

        getAdministratorSupporterAccounts(limit = 100) {
            return this.request(
                `/api/admin/supporter-accounts?limit=${encodeURIComponent(limit)}`,
                { administrator: true }
            );
        }

        setSupporterAccountStatus(accountId, status, reason) {
            return this.request(
                `/api/admin/supporter-accounts/${encodeURIComponent(accountId)}/status`,
                {
                    method: "POST",
                    body: { status, reason },
                    administrator: true
                }
            );
        }

        revokeSupporterAccountSessions(accountId, reason) {
            return this.request(
                `/api/admin/supporter-accounts/${encodeURIComponent(accountId)}`
                + "/sessions/revoke",
                {
                    method: "POST",
                    body: { reason },
                    administrator: true
                }
            );
        }

        getSandboxDiagnostics() {
            return this.request("/api/admin/diagnostics/sandbox", {
                administrator: true
            });
        }

        listEmergencyStops(barnId) {
            return this.request(
                `/api/admin/safety/emergency-stops?barnId=${encodeURIComponent(barnId)}`,
                { administrator: true }
            );
        }

        activateEmergencyStop({ level, barnId, feederId, reason }) {
            return this.request("/api/admin/safety/emergency-stops", {
                method: "POST",
                body: { level, barnId, feederId, reason },
                administrator: true
            });
        }

        requestEmergencyStopClear(emergencyStopId, reason) {
            return this.request(
                `/api/admin/safety/emergency-stops/${encodeURIComponent(emergencyStopId)}`
                + "/clearance-requests",
                {
                    method: "POST",
                    body: { reason },
                    administrator: true
                }
            );
        }

        listApprovalRequests(barnId) {
            return this.request(
                `/api/admin/safety/approval-requests?barnId=${encodeURIComponent(barnId)}`,
                { administrator: true }
            );
        }

        decideApproval(approvalRequestId, decision, reason, authorityRepresented) {
            return this.request(
                `/api/admin/safety/approval-requests/${encodeURIComponent(approvalRequestId)}`
                + "/decisions",
                {
                    method: "POST",
                    body: { decision, reason, authorityRepresented },
                    administrator: true
                }
            );
        }

        listResolutionCases(barnId) {
            return this.request(
                `/api/admin/safety/resolution-cases?barnId=${encodeURIComponent(barnId)}`,
                { administrator: true }
            );
        }

        requestOutcomeResolution(resolutionCaseId, resolution, reason, supportingNotes) {
            return this.request(
                `/api/admin/safety/resolution-cases/${encodeURIComponent(resolutionCaseId)}`
                + "/resolution-requests",
                {
                    method: "POST",
                    body: { resolution, reason, supportingNotes },
                    administrator: true
                }
            );
        }

        requestReplacementCommand(resolutionCaseId, reason) {
            return this.request(
                `/api/admin/safety/resolution-cases/${encodeURIComponent(resolutionCaseId)}`
                + "/replacement-requests",
                {
                    method: "POST",
                    body: { reason },
                    administrator: true
                }
            );
        }

        subscribeToLifecycle({ onEvent, onError } = {}) {
            if (typeof this.eventSourceFactory !== "function") {
                return null;
            }

            const eventSource = this.eventSourceFactory(
                `${this.baseUrl}/api/event-engine/events`
            );

            eventSource.addEventListener("lifecycle", event => {
                try {
                    const payload = JSON.parse(event.data);
                    if (typeof onEvent === "function") {
                        onEvent(payload);
                    }
                } catch (error) {
                    if (typeof onError === "function") {
                        onError(new ApiClientError("A lifecycle update could not be read.", {
                            code: "INVALID_LIFECYCLE_EVENT",
                            cause: error
                        }));
                    }
                }
            });

            eventSource.onerror = error => {
                if (typeof onError === "function") {
                    onError(new ApiClientError("Live lifecycle updates were interrupted.", {
                        code: "LIFECYCLE_STREAM_INTERRUPTED",
                        cause: error
                    }));
                }
            };

            return () => eventSource.close();
        }

        async request(path, {
            method = "GET",
            body,
            administrator = false,
            walletToken = null,
            walletId = null,
            supporter = false,
            csrfToken = null
        } = {}) {
            if (typeof this.fetchImpl !== "function") {
                throw new ApiClientError("This browser cannot connect to the feed service.", {
                    code: "FETCH_UNAVAILABLE"
                });
            }

            const controller = new AbortController();
            const timeoutId = global.setTimeout(() => controller.abort(), this.timeoutMs);
            const headers = {
                accept: "application/json",
                "x-request-id": this.createRequestId()
            };

            if (body !== undefined) {
                headers["content-type"] = "application/json";
            }
            if (administrator && this.developmentAdministratorIdentity) {
                headers.authorization =
                    `Development ${this.developmentAdministratorIdentity}`;
            } else if (walletToken) {
                headers.authorization = `Wallet ${walletToken}`;
            }
            const accountWalletId = walletId || (
                supporter ? this.supporterWalletId : null
            );
            if (!walletToken && accountWalletId) {
                headers["x-wallet-id"] = accountWalletId;
            }
            if (supporter && this.developmentSupporterIdentity) {
                headers["x-development-supporter"] =
                    this.developmentSupporterIdentity;
            }
            const accountCsrf = csrfToken || this.supporterCsrfToken;
            if (supporter && accountCsrf && method !== "GET") {
                headers["x-alpacaly-csrf"] = accountCsrf;
            }

            let response;
            try {
                response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                    method,
                    headers,
                    body: body === undefined ? undefined : JSON.stringify(body),
                    credentials: "include",
                    signal: controller.signal
                });
            } catch (error) {
                const timedOut = error && error.name === "AbortError";
                throw new ApiClientError(
                    timedOut
                        ? "The feed service took too long to respond."
                        : "The feed service is unavailable. Please try again shortly.",
                    {
                        code: timedOut ? "REQUEST_TIMEOUT" : "API_UNAVAILABLE",
                        cause: error
                    }
                );
            } finally {
                global.clearTimeout(timeoutId);
            }

            const payload = await this.readJson(response);
            if (!response.ok) {
                const backendError = payload && payload.error ? payload.error : {};
                throw new ApiClientError(
                    backendError.message || `The feed service returned HTTP ${response.status}.`,
                    {
                        code: backendError.code || "API_REQUEST_FAILED",
                        statusCode: response.status,
                        details: backendError.details || null
                    }
                );
            }

            return payload;
        }

        async readJson(response) {
            const text = await response.text();
            if (!text) {
                return null;
            }

            try {
                return JSON.parse(text);
            } catch (error) {
                throw new ApiClientError("The feed service returned an invalid response.", {
                    code: "INVALID_API_RESPONSE",
                    statusCode: response.status,
                    cause: error
                });
            }
        }

        createRequestId() {
            if (global.crypto && typeof global.crypto.randomUUID === "function") {
                return global.crypto.randomUUID();
            }

            return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        }
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { AlpacalyApiClient, ApiClientError };
    }

    if (global) {
        global.AlpacalyApiClient = AlpacalyApiClient;
        global.ApiClientError = ApiClientError;

        if (global.document) {
            const config = global.CONFIG || {};
            global.alpacalyApiClient = new AlpacalyApiClient({
                baseUrl: config.apiBaseUrl,
                timeoutMs: config.apiRequestTimeoutMs,
                developmentAdministratorIdentity:
                    config.developmentAdministratorIdentity,
                developmentSupporterIdentity:
                    config.developmentSupporterIdentity
            });
        }
    }
})(typeof window !== "undefined" ? window : globalThis);
