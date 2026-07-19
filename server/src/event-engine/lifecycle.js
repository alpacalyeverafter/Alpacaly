export const FEED_LIFECYCLE_STATES = Object.freeze([
    "RECEIVED",
    "VALIDATED",
    "QUEUED",
    "APPROVED",
    "COUNTDOWN",
    "BELL",
    "DISPENSING",
    "COMPLETE",
    "ARCHIVED"
]);

export const PREVIOUS_LIFECYCLE_STATE = Object.freeze({
    RECEIVED: null,
    VALIDATED: "RECEIVED",
    QUEUED: "VALIDATED",
    APPROVED: "QUEUED",
    COUNTDOWN: "APPROVED",
    BELL: "COUNTDOWN",
    DISPENSING: "BELL",
    COMPLETE: "DISPENSING",
    ARCHIVED: "COMPLETE"
});

export const HARDWARE_ACKNOWLEDGEMENT_STAGES = Object.freeze([
    "BELL",
    "DISPENSING"
]);

export function isLifecycleState(value) {
    return FEED_LIFECYCLE_STATES.includes(value);
}
