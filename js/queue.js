// ==========================================
// Alpacaly Ever After
// Event Queue
// ==========================================

class EventQueue {
    constructor() {
        this.events = [];
        this.queuedEventIds = new Set();
    }

    add(event) {
        if (!event || !event.id) {
            throw new Error("A valid event with an ID is required.");
        }

        if (this.queuedEventIds.has(event.id)) {
            return {
                accepted: false,
                reason: "DUPLICATE_EVENT"
            };
        }

        this.events.push(event);
        this.queuedEventIds.add(event.id);

        return {
            accepted: true,
            position: this.events.length
        };
    }

    next() {
        if (this.events.length === 0) {
            return null;
        }

        const event = this.events.shift();
        this.queuedEventIds.delete(event.id);

        return event;
    }

    peek() {
        return this.events.length > 0
            ? this.events[0]
            : null;
    }

    size() {
        return this.events.length;
    }

    isEmpty() {
        return this.events.length === 0;
    }

    contains(eventId) {
        return this.queuedEventIds.has(eventId);
    }

    clear() {
        this.events = [];
        this.queuedEventIds.clear();
    }

    getAll() {
        return [...this.events];
    }
}

const eventQueue = new EventQueue();
