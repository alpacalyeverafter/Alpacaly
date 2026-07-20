const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ENVIRONMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class MqttTopicError extends Error {
    constructor(message, code = "MQTT_TOPIC_INVALID") {
        super(message);
        this.name = "MqttTopicError";
        this.code = code;
        this.terminalFailure = true;
    }
}

function requireIdentifier(value, name, pattern = RESOURCE_ID) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || !pattern.test(normalized) || /[+#/]/.test(normalized)) {
        throw new MqttTopicError(`${name} is not safe for an MQTT topic.`);
    }
    return normalized;
}

export class MqttTopicNamespace {
    constructor(environment) {
        this.environment = requireIdentifier(
            String(environment || "").toLowerCase(),
            "environment",
            ENVIRONMENT
        );
        this.prefix = `alpacaly/${this.environment}/v1`;
    }

    controller(controllerId, channel) {
        const id = requireIdentifier(controllerId, "controllerId");
        if (!["commands", "acknowledgements", "heartbeats", "status", "assignments"]
            .includes(channel)) {
            throw new MqttTopicError("Controller topic channel is unsupported.");
        }
        return `${this.prefix}/controllers/${id}/${channel}`;
    }

    commands(id) { return this.controller(id, "commands"); }
    acknowledgements(id) { return this.controller(id, "acknowledgements"); }
    heartbeats(id) { return this.controller(id, "heartbeats"); }
    status(id) { return this.controller(id, "status"); }
    assignments(id) { return this.controller(id, "assignments"); }
    controllerWildcard(channel) { return `${this.prefix}/controllers/+/${channel}`; }
    platformSafety() { return `${this.prefix}/safety/platform`; }
    barnSafety(barnId) {
        return `${this.prefix}/safety/barns/${requireIdentifier(barnId, "barnId")}`;
    }
    feederSafety(feederId) {
        return `${this.prefix}/safety/feeders/${requireIdentifier(feederId, "feederId")}`;
    }

    parse(topic) {
        const parts = String(topic || "").split("/");
        const expectedPrefix = this.prefix.split("/");
        if (
            parts.length < 4
            || expectedPrefix.some((part, index) => parts[index] !== part)
        ) {
            throw new MqttTopicError("Topic is outside the configured namespace.");
        }
        if (parts[3] === "controllers" && parts.length === 6) {
            return {
                kind: "CONTROLLER",
                controllerId: requireIdentifier(parts[4], "controllerId"),
                channel: requireIdentifier(parts[5], "channel")
            };
        }
        if (parts[3] === "safety" && parts.length === 5 && parts[4] === "platform") {
            return { kind: "SAFETY", level: "PLATFORM", barnId: null, feederId: null };
        }
        if (parts[3] === "safety" && parts.length === 6 && parts[4] === "barns") {
            return {
                kind: "SAFETY",
                level: "BARN",
                barnId: requireIdentifier(parts[5], "barnId"),
                feederId: null
            };
        }
        if (parts[3] === "safety" && parts.length === 6 && parts[4] === "feeders") {
            return {
                kind: "SAFETY",
                level: "FEEDER",
                barnId: null,
                feederId: requireIdentifier(parts[5], "feederId")
            };
        }
        throw new MqttTopicError("Topic shape is unsupported.");
    }

    assertControllerTopic(topic, controllerId, channel) {
        const parsed = this.parse(topic);
        if (
            parsed.kind !== "CONTROLLER"
            || parsed.controllerId !== controllerId
            || parsed.channel !== channel
        ) {
            throw new MqttTopicError(
                "Topic does not match the expected controller identity or channel.",
                "MQTT_TOPIC_IDENTITY_MISMATCH"
            );
        }
        return parsed;
    }
}
