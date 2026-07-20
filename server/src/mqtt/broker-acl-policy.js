import { MqttTopicNamespace } from "./topic-namespace.js";

export class BrokerAclPolicy {
    constructor({ environment, controllerStore }) {
        this.topics = new MqttTopicNamespace(environment);
        this.controllerStore = controllerStore;
    }

    canPublish(principal, topic) {
        if (principal?.type === "SERVER") {
            return this.serverMayPublish(topic);
        }
        if (principal?.type === "CONTROLLER") {
            return this.controllerMayPublish(principal.controllerId, topic);
        }
        return false;
    }

    canSubscribe(principal, topic) {
        if (principal?.type === "SERVER") {
            return this.serverMaySubscribe(topic);
        }
        if (principal?.type === "CONTROLLER") {
            return this.controllerMaySubscribe(principal.controllerId, topic);
        }
        return false;
    }

    serverMayPublish(topic) {
        try {
            const parsed = this.topics.parse(topic);
            return parsed.kind === "SAFETY"
                || (parsed.kind === "CONTROLLER"
                    && ["commands", "assignments"].includes(parsed.channel));
        } catch {
            return false;
        }
    }

    serverMaySubscribe(topic) {
        const allowed = ["acknowledgements", "heartbeats", "status"];
        return allowed.some(channel => (
            topic === this.topics.controllerWildcard(channel)
        )) || this.exactControllerChannel(topic, allowed);
    }

    controllerMayPublish(controllerId, topic) {
        return this.exactControllerIdentity(
            controllerId,
            topic,
            ["acknowledgements", "heartbeats", "status"]
        );
    }

    controllerMaySubscribe(controllerId, topic) {
        if (this.exactControllerIdentity(
            controllerId,
            topic,
            ["commands", "assignments"]
        )) {
            return true;
        }
        let parsed;
        try {
            parsed = this.topics.parse(topic);
        } catch {
            return false;
        }
        if (parsed.kind !== "SAFETY") {
            return false;
        }
        const controller = this.controllerStore.getController(controllerId);
        if (!controller) {
            return false;
        }
        if (parsed.level === "PLATFORM") {
            return true;
        }
        if (parsed.level === "BARN") {
            return parsed.barnId === controller.barnId;
        }
        return controller.assignments.some(item => (
            item.feederId === parsed.feederId
        ));
    }

    exactControllerChannel(topic, channels) {
        try {
            const parsed = this.topics.parse(topic);
            return parsed.kind === "CONTROLLER" && channels.includes(parsed.channel);
        } catch {
            return false;
        }
    }

    exactControllerIdentity(controllerId, topic, channels) {
        try {
            const parsed = this.topics.parse(topic);
            return parsed.kind === "CONTROLLER"
                && parsed.controllerId === controllerId
                && channels.includes(parsed.channel);
        } catch {
            return false;
        }
    }
}
