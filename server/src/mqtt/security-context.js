import { DEVELOPMENT_MQTT_KEYS } from "./development-keys.js";
import {
    Ed25519MessageSigner,
    Ed25519MessageVerifier,
    MessageSecurityError
} from "./message-signing.js";

export function createMqttSecurityContext(config) {
    const environment = config.mqttEnvironment
        || (config.nodeEnv === "production" ? "production" : config.nodeEnv || "development");
    const development = config.nodeEnv !== "production"
        && config.mqttDevelopmentKeys !== false;
    const serverKeyId = config.mqttServerSigningKeyId
        || DEVELOPMENT_MQTT_KEYS.server.keyId;
    const controllerKeyId = config.mqttControllerSigningKeyId
        || DEVELOPMENT_MQTT_KEYS.controller.keyId;
    const serverPrivateKey = config.mqttServerSigningPrivateKey
        || (development ? DEVELOPMENT_MQTT_KEYS.server.privateKey : null);
    const controllerPrivateKey = config.mqttControllerSigningPrivateKey
        || (development ? DEVELOPMENT_MQTT_KEYS.controller.privateKey : null);
    const serverPublicKeys = { ...(config.mqttServerSigningPublicKeys || {}) };
    const controllerPublicKeys = {
        ...(config.mqttControllerSigningPublicKeys || {})
    };
    if (development) {
        serverPublicKeys[DEVELOPMENT_MQTT_KEYS.server.keyId] = {
            publicKey: DEVELOPMENT_MQTT_KEYS.server.publicKey,
            environment,
            development: true
        };
        controllerPublicKeys[DEVELOPMENT_MQTT_KEYS.controller.keyId] = {
            publicKey: DEVELOPMENT_MQTT_KEYS.controller.publicKey,
            environment,
            development: true
        };
    }
    if (!serverPrivateKey) {
        throw new MessageSecurityError(
            "Server application-message signing is not configured.",
            "MQTT_SERVER_SIGNING_KEY_REQUIRED"
        );
    }
    if (Object.keys(controllerPublicKeys).length === 0) {
        throw new MessageSecurityError(
            "No controller verification keys are configured.",
            "MQTT_CONTROLLER_VERIFICATION_KEYS_REQUIRED"
        );
    }
    return {
        environment,
        serverSigner: new Ed25519MessageSigner({
            keyId: serverKeyId,
            privateKey: serverPrivateKey,
            environment,
            development
        }),
        serverVerifier: new Ed25519MessageVerifier({
            keys: serverPublicKeys,
            environment,
            production: config.nodeEnv === "production"
        }),
        controllerSigner: controllerPrivateKey
            ? new Ed25519MessageSigner({
                keyId: controllerKeyId,
                privateKey: controllerPrivateKey,
                environment,
                development
            })
            : null,
        controllerVerifier: new Ed25519MessageVerifier({
            keys: controllerPublicKeys,
            environment,
            production: config.nodeEnv === "production"
        })
    };
}
