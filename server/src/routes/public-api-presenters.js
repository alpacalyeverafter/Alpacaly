export function presentPublicFeedRequest(feedRequest) {
    if (!feedRequest) {
        return null;
    }
    return {
        id: feedRequest.eventId || feedRequest.id,
        eventId: feedRequest.eventId || feedRequest.id,
        state: feedRequest.state || feedRequest.status,
        status: feedRequest.status || feedRequest.state,
        barnId: feedRequest.barnId,
        feederId: feedRequest.feederId,
        queueId: feedRequest.queueId,
        requestedAt: feedRequest.requestedAt,
        updatedAt: feedRequest.updatedAt,
        queuePosition: feedRequest.queuePosition,
        estimatedWaitMs: feedRequest.estimatedWaitMs
    };
}

export function presentPublicEventEngineSnapshot(snapshot) {
    return {
        status: snapshot.availability?.available === false
            ? "TEMPORARILY_UNAVAILABLE"
            : snapshot.status,
        date: snapshot.date,
        queueSize: snapshot.queueSize,
        waitingQueueSize: snapshot.waitingQueueSize,
        acceptedToday: snapshot.acceptedToday,
        completedFeeds: snapshot.completedFeeds,
        archivedCount: snapshot.archivedCount,
        feedsRemaining: snapshot.feedsRemaining,
        feedingWindowEnforced: snapshot.feedingWindowEnforced,
        lastUpdatedAt: snapshot.lastUpdatedAt,
        availability: snapshot.availability,
        activeEvent: presentPublicFeedRequest(snapshot.activeEvent)
    };
}

export function presentPublicQueueStatistics(statistics) {
    return {
        barnId: statistics.barnId,
        feederId: statistics.feederId,
        queueId: statistics.queueId,
        feederStatus: statistics.availability?.available === false
            ? "TEMPORARILY_UNAVAILABLE"
            : statistics.feederStatus,
        availability: statistics.availability,
        waitingCount: statistics.waitingCount,
        activeCount: statistics.activeCount,
        archivedCount: statistics.archivedCount,
        estimatedWaitMs: statistics.estimatedWaitMs,
        activeEvent: presentPublicFeedRequest(statistics.activeEvent)
    };
}

export function presentPublicLifecyclePayload(payload) {
    const presented = {
        type: payload.type,
        reason: payload.reason,
        eventId: payload.eventId,
        state: payload.state,
        timestamp: payload.timestamp
    };
    if (payload.feedRequest) {
        presented.feedRequest = presentPublicFeedRequest(payload.feedRequest);
    }
    if (payload.eventEngine) {
        presented.eventEngine = presentPublicEventEngineSnapshot(payload.eventEngine);
    }
    if (payload.queueStatistics) {
        presented.queueStatistics = presentPublicQueueStatistics(
            payload.queueStatistics
        );
    }
    return presented;
}
