// ============================================
// Alpacaly Ever After
// Event Queue
// ============================================

class EventQueue {
    constructor() {
        this.events = [];
        this.knownEventIds = new Set();
    }

    add(event) {
        if (!event || !event.id) {
            return {
                accepted: false,
                reason: "INVALID_EVENT"
            };
        }

        if (this.knownEventIds.has(event.id)) {
            return {
                accepted: false,
                reason: "DUPLICATE_EVENT"
            };
        }

        this.events.push(event);
        this.knownEventIds.add(event.id);

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
        this.knownEventIds.delete(event.id);

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
        return this.knownEventIds.has(eventId);
    }

    clear() {
        this.events = [];
        this.knownEventIds.clear();
    }

    getAll() {
        return [...this.events];
    }
}

const eventQueue = new EventQueue();
