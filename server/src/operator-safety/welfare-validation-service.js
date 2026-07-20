import { ApplicationError } from "../errors/application-error.js";

export class WelfareValidationService {
    constructor({ store, eventEngine, config, clock = () => new Date() }) {
        this.store = store;
        this.eventEngine = eventEngine;
        this.config = config;
        this.clock = clock;
    }

    validateReplacement(resolutionCase) {
        const feeder = this.store.getFeederSafety(resolutionCase.feederId);
        if (!feeder || feeder.barnId !== resolutionCase.barnId) {
            this.reject("Replacement feeder was not found.", "FEEDER_NOT_FOUND", 404);
        }
        if (this.store.getEffectiveStops(
            resolutionCase.barnId,
            resolutionCase.feederId
        ).length > 0) {
            this.reject(
                "An emergency stop prevents replacement command creation.",
                "EMERGENCY_STOP_ACTIVE"
            );
        }
        if (feeder.operationalStatus !== "AVAILABLE") {
            this.reject(
                "The feeder is not operationally available.",
                "FEEDER_OPERATIONALLY_UNAVAILABLE"
            );
        }
        const unresolved = this.store.getResolutionCases({
            status: "OPEN",
            feederId: resolutionCase.feederId
        });
        if (unresolved.length > 0) {
            this.reject(
                "An unresolved uncertain outcome still blocks this feeder.",
                "UNRESOLVED_OUTCOME_UNKNOWN"
            );
        }
        const snapshot = resolutionCase.feederId === this.eventEngine
            .getDefaultFeederId()
            ? this.eventEngine.getSnapshot()
            : null;
        if (snapshot && snapshot.acceptedToday > this.config.maxDailyFeeds) {
            this.reject(
                "The daily welfare limit prevents a replacement command.",
                "DAILY_FEED_LIMIT_REACHED"
            );
        }
        if (
            this.config.enforceFeedingWindow
            && !this.eventEngine.isWithinFeedingWindow(this.clock())
        ) {
            this.reject(
                "The current feeding window prevents a replacement command.",
                "OUTSIDE_FEEDING_WINDOW"
            );
        }
        return {
            eligible: true,
            checkedAt: this.clock().toISOString(),
            feederId: resolutionCase.feederId
        };
    }

    reject(message, code, statusCode = 409) {
        throw new ApplicationError(message, { code, statusCode });
    }
}
