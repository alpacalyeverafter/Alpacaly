import { isTerminalDeviceCommandState } from "../domain/device-commands.js";

function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            const error = new Error("Device Command wait was cancelled.");
            error.name = "AbortError";
            reject(error);
            return;
        }
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, Math.max(0, milliseconds));
        function abort() {
            clearTimeout(timeout);
            const error = new Error("Device Command wait was cancelled.");
            error.name = "AbortError";
            reject(error);
        }
        signal?.addEventListener("abort", abort, { once: true });
    });
}

export class DeviceCommandWorker {
    constructor({
        deviceCommandStore,
        deviceTransport = null,
        deviceAdapter = null,
        acknowledgementService,
        claimStore,
        workerIdentity,
        logger,
        clock = () => new Date(),
        pollIntervalMs = 100,
        acknowledgementTimeoutMs = 5000,
        retryDelayMs = 1000,
        claimHeartbeatIntervalMs = 5000,
        maximumClaimAttempts = 10,
        sleep = wait,
        onOutcomeUnknown = () => {}
    }) {
        this.deviceCommandStore = deviceCommandStore;
        this.deviceTransport = deviceTransport || deviceAdapter;
        if (!this.deviceTransport) {
            throw new Error("DeviceCommandWorker requires a device transport.");
        }
        this.deviceAdapter = this.deviceTransport;
        this.acknowledgementService = acknowledgementService;
        this.claimStore = claimStore;
        this.workerIdentity = workerIdentity;
        this.logger = logger;
        this.clock = clock;
        this.pollIntervalMs = pollIntervalMs;
        this.acknowledgementTimeoutMs = acknowledgementTimeoutMs;
        this.retryDelayMs = retryDelayMs;
        this.claimHeartbeatIntervalMs = claimHeartbeatIntervalMs;
        this.maximumClaimAttempts = maximumClaimAttempts;
        this.sleep = sleep;
        this.onOutcomeUnknown = onOutcomeUnknown;
        this.safetyService = null;
        this.started = false;
        this.transportStarted = false;
        this.timer = null;
        this.processingPoll = false;
        this.inFlight = new Map();
        this.abortController = new AbortController();
        this.workerRegistered = false;
        this.workerHeartbeatTimer = null;
    }

    start() {
        if (this.started) {
            return;
        }
        if (this.abortController.signal.aborted) {
            this.abortController = new AbortController();
        }
        this.startTransport();
        this.ensureWorkerRegistered();
        this.started = true;
        this.scheduleWorkerHeartbeat();
        this.reconcileOutcomeUnknownCommands();
        void this.reconcileOutstanding({ force: true });
        void this.processReadyCommands();
        this.scheduleNextPoll();
    }

    startTransport() {
        if (this.transportStarted) {
            return;
        }
        if (this.abortController.signal.aborted) {
            this.abortController = new AbortController();
        }
        this.deviceTransport.start({
            onAcknowledgement: acknowledgement => (
                this.acknowledgementService.record(acknowledgement)
            ),
            onTransportError: payload => {
                this.logger.warn({
                    event: "device_transport_error",
                    commandId: payload?.commandId,
                    controllerId: payload?.controllerId,
                    error: String(payload?.error?.message || payload?.error || "unknown")
                }, "Device transport reported an error");
            },
            onOutcomeUnknown: ({ commandId, reason }) => {
                const command = this.deviceCommandStore.getCommand(commandId);
                if (!command || isTerminalDeviceCommandState(command.status)) {
                    return;
                }
                this.markOutcomeUnknown(commandId, {
                    timestamp: this.clock().toISOString(),
                    lastError: reason || "Controller reported an uncertain outcome",
                    details: { source: "DEVICE_TRANSPORT" }
                });
            },
            onReconnect: () => {
                void this.reconcileOutstanding({ force: true });
            }
        });
        this.transportStarted = true;
    }

    async stop() {
        this.started = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.workerHeartbeatTimer) {
            clearTimeout(this.workerHeartbeatTimer);
            this.workerHeartbeatTimer = null;
        }
        this.abortController.abort();
        await Promise.allSettled([...this.inFlight.values()]);
        await this.deviceTransport.shutdown();
        if (this.workerRegistered && !this.deviceCommandStore.eventStore.closed) {
            this.claimStore.stopWorker(this.workerIdentity);
        }
        this.workerRegistered = false;
        this.transportStarted = false;
    }

    cancelInFlight() {
        this.abortController.abort();
        this.abortController = new AbortController();
    }

    setSafetyService(safetyService) {
        this.safetyService = safetyService;
        this.deviceTransport.setSafetyService?.(safetyService);
    }

    processCommand(commandId, { forceReconcile = false } = {}) {
        this.startTransport();
        const existing = this.inFlight.get(commandId);
        if (existing) {
            return existing;
        }
        const processing = this.processCommandOnce(commandId, { forceReconcile })
            .finally(() => {
                this.inFlight.delete(commandId);
            });
        this.inFlight.set(commandId, processing);
        return processing;
    }

    async processCommandOnce(commandId, { forceReconcile = false } = {}) {
        this.ensureWorkerRegistered();
        const initial = this.deviceCommandStore.getCommand(commandId);
        if (!initial || isTerminalDeviceCommandState(initial.status)) {
            return initial;
        }
        const claim = this.claimStore.claim(
            "DEVICE_COMMAND",
            commandId,
            this.workerIdentity,
            {
                maximumAttempts: this.maximumClaimAttempts,
                force: forceReconcile,
                metadata: {
                    deviceId: initial.deviceId,
                    feederId: initial.feederId,
                    commandType: initial.commandType
                }
            }
        );
        if (!claim) {
            return initial;
        }

        const ownershipAbortController = new AbortController();
        const signal = AbortSignal.any([
            this.abortController.signal,
            ownershipAbortController.signal
        ]);
        const heartbeat = setInterval(() => {
            try {
                const retained = this.claimStore.extend(claim, this.workerIdentity);
                if (!retained) {
                    ownershipAbortController.abort();
                }
            } catch (error) {
                this.logger.error({
                    event: "device_command_claim_heartbeat_failed",
                    commandId,
                    err: error
                }, "Device Command ownership heartbeat failed");
                ownershipAbortController.abort();
            }
        }, this.claimHeartbeatIntervalMs);
        heartbeat.unref?.();

        try {
            const result = await this.processOwnedCommandOnce(
                commandId,
                { forceReconcile, signal }
            );
            const latest = this.deviceCommandStore.getCommand(commandId) || result;
            if (latest?.status === "OUTCOME_UNKNOWN") {
                this.claimStore.fail(claim, this.workerIdentity, {
                    error: new Error(latest.lastError || "Physical outcome is unknown."),
                    failureCode: "PHYSICAL_OUTCOME_UNKNOWN",
                    potentiallyCompleted: true,
                    details: { commandStatus: latest.status }
                });
            } else if (latest?.status === "FAILED") {
                this.claimStore.fail(claim, this.workerIdentity, {
                    error: new Error(latest.lastError || "Device Command failed."),
                    failureCode: "DEVICE_COMMAND_FAILED",
                    nonRetryable: true,
                    details: { commandStatus: latest.status }
                });
            } else if (["ACKNOWLEDGED", "CANCELLED"].includes(latest?.status)) {
                this.claimStore.complete(claim, this.workerIdentity, {
                    commandStatus: latest.status
                });
            } else {
                this.claimStore.release(claim, this.workerIdentity, {
                    nextEligibleAt: latest?.nextAttemptAt || latest?.acknowledgementDeadline,
                    reason: `COMMAND_${latest?.status || "UNRESOLVED"}`
                });
            }
            return result;
        } catch (error) {
            const latest = this.deviceCommandStore.getCommand(commandId);
            this.claimStore.fail(claim, this.workerIdentity, {
                error,
                retryAt: new Date(this.clock().getTime() + this.retryDelayMs).toISOString(),
                failureCode: error?.code || "DEVICE_COMMAND_WORKER_FAILED",
                potentiallyCompleted: ["SENT", "TIMED_OUT", "OUTCOME_UNKNOWN"]
                    .includes(latest?.status),
                details: { commandStatus: latest?.status }
            });
            throw error;
        } finally {
            clearInterval(heartbeat);
        }
    }

    async processOwnedCommandOnce(commandId, { forceReconcile = false, signal } = {}) {
        let command = this.deviceCommandStore.getCommand(commandId);
        if (!command || isTerminalDeviceCommandState(command.status)) {
            return command;
        }
        if (!this.commandMayProgress(command)) {
            return command;
        }
        if (command.status === "PENDING") {
            command = this.deviceCommandStore.transitionCommand(commandId, "READY", {
                timestamp: this.clock().toISOString(),
                nextAttemptAt: this.clock().toISOString(),
                details: { recovery: "PENDING_COMMAND_RECONCILED" }
            });
        }
        if (command.status === "SENT" || command.status === "TIMED_OUT") {
            return this.reconcileCommand(command, { force: forceReconcile });
        }
        if (!["READY", "RETRY_SCHEDULED"].includes(command.status)) {
            return command;
        }
        if (!this.commandMayProgress(command)) {
            return command;
        }
        if (
            this.deviceCommandStore.getDeviceOperationalStatus(command.deviceId)
                ?.operationalStatus !== "AVAILABLE"
        ) {
            return command;
        }
        const nextAttempt = Date.parse(command.nextAttemptAt);
        if (Number.isFinite(nextAttempt) && nextAttempt > this.clock().getTime()) {
            return command;
        }

        const sentAtDate = this.clock();
        command = this.deviceCommandStore.transitionCommand(commandId, "SENT", {
            timestamp: sentAtDate.toISOString(),
            acknowledgementDeadline: new Date(
                sentAtDate.getTime() + this.acknowledgementTimeoutMs
            ).toISOString(),
            nextAttemptAt: null,
            lastError: null,
            incrementAttempt: true,
            details: { delivery: "DEVICE_ADAPTER" }
        });
        try {
            const delivery = await this.deviceTransport.deliver(command, {
                signal
            });
            // Phase 7A adapters returned an acknowledgement directly. The
            // Phase 7C transport emits acknowledgements through its receiver.
            if (delivery?.acknowledgementId && delivery?.commandId) {
                this.acknowledgementService.record(delivery);
            }
        } catch (error) {
            if (error?.name === "AbortError") {
                return this.deviceCommandStore.getCommand(commandId);
            }
            if (error?.terminalFailure) {
                return this.deviceCommandStore.transitionCommand(commandId, "FAILED", {
                    timestamp: this.clock().toISOString(),
                    lastError: String(error?.message || error),
                    details: { reason: error?.code || "TERMINAL_DELIVERY_FAILURE" }
                });
            }
            if (error?.deliveryOutcome === "CONFIRMED_NOT_PROCESSED") {
                return this.scheduleRetryOrFailure(commandId, error);
            }
            return this.markOutcomeUnknown(commandId, {
                timestamp: this.clock().toISOString(),
                lastError: String(error?.message || error),
                details: { deliveryOutcome: "UNKNOWN" }
            });
        }
        return this.deviceCommandStore.getCommand(commandId);
    }

    ensureWorkerRegistered() {
        if (!this.workerRegistered) {
            this.claimStore.registerWorker(this.workerIdentity);
            this.workerRegistered = true;
        }
    }

    scheduleWorkerHeartbeat() {
        if (!this.started || !this.workerRegistered) {
            return;
        }
        this.workerHeartbeatTimer = setTimeout(() => {
            this.workerHeartbeatTimer = null;
            if (this.deviceCommandStore.eventStore.closed) {
                this.started = false;
                this.workerRegistered = false;
                return;
            }
            if (this.started && this.workerRegistered) {
                this.claimStore.heartbeatWorker(this.workerIdentity);
                this.scheduleWorkerHeartbeat();
            }
        }, this.claimHeartbeatIntervalMs);
        this.workerHeartbeatTimer.unref?.();
    }

    async reconcileCommand(command, { force = false } = {}) {
        const now = this.clock();
        const deadline = Date.parse(command.acknowledgementDeadline);
        if (!force && Number.isFinite(deadline) && deadline > now.getTime()) {
            return command;
        }

        const reconciliation = await this.deviceTransport.reconcile(command);
        if (reconciliation.acknowledgement) {
            this.acknowledgementService.record(reconciliation.acknowledgement);
            return this.deviceCommandStore.getCommand(command.commandId);
        }
        if (reconciliation.outcome === "CONFIRMED_NOT_PROCESSED") {
            if (Number.isFinite(deadline) && deadline <= now.getTime()) {
                command = this.deviceCommandStore.transitionCommand(
                    command.commandId,
                    "TIMED_OUT",
                    {
                        timestamp: now.toISOString(),
                        lastError: "Acknowledgement deadline expired",
                        details: { acknowledgementDeadline: command.acknowledgementDeadline }
                    }
                );
            }
            return this.scheduleRetryOrFailure(
                command.commandId,
                new Error("Command was confirmed not processed by the device.")
            );
        }
        if (force && reconciliation.outcome === "UNKNOWN") {
            return this.markOutcomeUnknown(command.commandId, {
                timestamp: now.toISOString(),
                lastError: "Device transport reported an uncertain outcome",
                details: { reconciliationOutcome: "UNKNOWN", forced: true }
            });
        }
        if (Number.isFinite(deadline) && deadline <= now.getTime()) {
            if (command.status !== "TIMED_OUT") {
                command = this.deviceCommandStore.transitionCommand(
                    command.commandId,
                    "TIMED_OUT",
                    {
                        timestamp: now.toISOString(),
                        lastError: "Acknowledgement deadline expired",
                        details: { acknowledgementDeadline: command.acknowledgementDeadline }
                    }
                );
            }
            return this.markOutcomeUnknown(command.commandId, {
                timestamp: now.toISOString(),
                lastError: "Device could not confirm whether the action occurred",
                details: { reconciliationOutcome: "UNKNOWN" }
            });
        }
        return command;
    }

    scheduleRetryOrFailure(commandId, error) {
        const command = this.deviceCommandStore.getCommand(commandId);
        if (!command || isTerminalDeviceCommandState(command.status)) {
            return command;
        }
        const timestamp = this.clock();
        const message = String(error?.message || error || "Device delivery failed")
            .slice(0, 1000);
        if (command.attemptCount >= command.maximumAttempts) {
            return this.deviceCommandStore.transitionCommand(commandId, "FAILED", {
                timestamp: timestamp.toISOString(),
                lastError: message,
                details: {
                    maximumAttempts: command.maximumAttempts,
                    reason: error?.code || "DELIVERY_FAILED"
                }
            });
        }
        const nextAttemptAt = new Date(
            timestamp.getTime() + this.retryDelayMs
        ).toISOString();
        return this.deviceCommandStore.transitionCommand(
            commandId,
            "RETRY_SCHEDULED",
            {
                timestamp: timestamp.toISOString(),
                nextAttemptAt,
                lastError: message,
                details: {
                    nextAttemptAt,
                    reason: error?.code || "DELIVERY_FAILED"
                }
            }
        );
    }

    markOutcomeUnknown(commandId, options) {
        const command = this.deviceCommandStore.transitionCommand(
            commandId,
            "OUTCOME_UNKNOWN",
            options
        );
        this.onOutcomeUnknown(command);
        return command;
    }

    commandMayProgress(command) {
        if (!this.safetyService) {
            return true;
        }
        try {
            this.safetyService.assertCommandMayProgress(command);
            return true;
        } catch (error) {
            if (error?.code === "FEEDER_SAFETY_BLOCKED") {
                return false;
            }
            throw error;
        }
    }

    async driveCommandToResolution(commandId, { signal } = {}) {
        while (!signal?.aborted) {
            let command = this.deviceCommandStore.getCommand(commandId);
            if (!command) {
                throw new Error(`DeviceCommand ${commandId} was not found.`);
            }
            if (isTerminalDeviceCommandState(command.status)) {
                return command;
            }
            const deadline = Date.parse(command.acknowledgementDeadline);
            const forceReconcile = command.status === "TIMED_OUT"
                || (command.status === "SENT"
                    && Number.isFinite(deadline)
                    && deadline <= this.clock().getTime());
            await this.processCommand(commandId, { forceReconcile });
            command = this.deviceCommandStore.getCommand(commandId);
            if (isTerminalDeviceCommandState(command.status)) {
                return command;
            }
            const candidateTimes = [
                Date.parse(command.nextAttemptAt),
                Date.parse(command.acknowledgementDeadline)
            ].filter(Number.isFinite);
            const nextWakeAt = candidateTimes.length > 0
                ? Math.min(...candidateTimes)
                : this.clock().getTime() + this.pollIntervalMs;
            try {
                await this.sleep(
                    Math.min(
                        this.pollIntervalMs,
                        Math.max(0, nextWakeAt - this.clock().getTime())
                    ),
                    signal
                );
            } catch (error) {
                if (error?.name === "AbortError") {
                    return null;
                }
                throw error;
            }
        }
        return null;
    }

    async processReadyCommands() {
        if (this.processingPoll || this.deviceCommandStore.eventStore.closed) {
            return [];
        }
        this.processingPoll = true;
        try {
            this.reconcileOutcomeUnknownCommands();
            const commands = this.deviceCommandStore.getDeliverableCommands(
                this.clock().toISOString()
            );
            return await Promise.all(commands.map(command => this.processCommand(
                command.commandId
            )));
        } finally {
            this.processingPoll = false;
        }
    }

    reconcileOutcomeUnknownCommands() {
        this.deviceCommandStore.getAllCommands()
            .filter(command => command.status === "OUTCOME_UNKNOWN")
            .forEach(command => this.onOutcomeUnknown(command));
    }

    async reconcileOutstanding({ force = false } = {}) {
        const commands = this.deviceCommandStore.getOutstandingCommands();
        return Promise.all(commands.map(command => this.processCommand(
            command.commandId,
            { forceReconcile: force }
        )));
    }

    scheduleNextPoll() {
        if (!this.started || this.deviceCommandStore.eventStore.closed) {
            return;
        }
        this.timer = setTimeout(async () => {
            this.timer = null;
            if (!this.started || this.deviceCommandStore.eventStore.closed) {
                return;
            }
            try {
                await this.reconcileOutstanding();
                await this.processReadyCommands();
            } catch (error) {
                this.logger.error({
                    event: "device_command_worker_poll_failed",
                    err: error
                }, "Device Command worker poll failed");
            }
            this.scheduleNextPoll();
        }, this.pollIntervalMs);
        this.timer.unref?.();
    }
}
