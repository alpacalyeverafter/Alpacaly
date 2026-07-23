export class FeederQueueManager {
    constructor(queues = []) {
        this.runtimes = new Map();
        queues.forEach(queue => this.register(queue));
    }

    register(queue) {
        const existing = this.runtimes.get(queue.feederId);
        if (existing) {
            if (
                existing.queueId !== queue.queueId
                || existing.barnId !== queue.barnId
            ) {
                throw new Error(`Feeder ${queue.feederId} has conflicting queue resources.`);
            }
            return existing;
        }

        const runtime = {
            barnId: queue.barnId,
            feederId: queue.feederId,
            queueId: queue.queueId,
            eventIds: [],
            archivedEventIds: [],
            activeEventId: null,
            processing: false,
            processingScheduled: false,
            resumeAfterCurrent: false,
            acceptedToday: 0,
            completedToday: 0
        };
        this.runtimes.set(queue.feederId, runtime);
        return runtime;
    }

    get(feederId) {
        return this.runtimes.get(feederId) || null;
    }

    has(feederId) {
        return this.runtimes.has(feederId);
    }

    values() {
        return this.runtimes.values();
    }

    forEach(callback) {
        this.runtimes.forEach(callback);
    }

    get size() {
        return this.runtimes.size;
    }

    resetState() {
        this.runtimes.forEach(runtime => {
            runtime.eventIds = [];
            runtime.archivedEventIds = [];
            runtime.processing = false;
            runtime.processingScheduled = false;
            runtime.resumeAfterCurrent = false;
            runtime.activeEventId = null;
            runtime.acceptedToday = 0;
            runtime.completedToday = 0;
        });
    }

    hasProcessingActivity() {
        return [...this.runtimes.values()].some(runtime => (
            runtime.processing || runtime.processingScheduled
        ));
    }

    isCompletelyIdle() {
        return !this.hasProcessingActivity()
            && [...this.runtimes.values()].every(runtime => runtime.eventIds.length === 0);
    }

    totalQueuedEvents() {
        return [...this.runtimes.values()].reduce(
            (total, runtime) => total + runtime.eventIds.length,
            0
        );
    }

    totalArchivedEvents() {
        return [...this.runtimes.values()].reduce(
            (total, runtime) => total + runtime.archivedEventIds.length,
            0
        );
    }
}
