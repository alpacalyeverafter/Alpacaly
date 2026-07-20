import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import { signingPayload } from "./canonical-json.js";

export class MessageSecurityError extends Error {
    constructor(message, code = "MQTT_SIGNATURE_INVALID") {
        super(message);
        this.name = "MessageSecurityError";
        this.code = code;
        this.terminalFailure = true;
    }
}

function normalizeKeyRecord(keyId, value, defaultEnvironment) {
    if (typeof value === "string") {
        return {
            keyId,
            publicKey: value,
            environment: defaultEnvironment,
            development: false,
            revoked: false
        };
    }
    return {
        keyId,
        publicKey: value?.publicKey,
        environment: value?.environment || defaultEnvironment,
        development: value?.development === true,
        revoked: value?.revoked === true || Boolean(value?.revokedAt)
    };
}

export class Ed25519MessageSigner {
    constructor({ keyId, privateKey, environment, development = false }) {
        if (!keyId || !privateKey || !environment) {
            throw new MessageSecurityError(
                "A signing key ID, private key and environment are required.",
                "MQTT_SIGNING_CONFIGURATION_INVALID"
            );
        }
        this.keyId = keyId;
        this.privateKey = createPrivateKey(privateKey);
        if (this.privateKey.asymmetricKeyType !== "ed25519") {
            throw new MessageSecurityError(
                "The application-message signing key must be Ed25519.",
                "MQTT_SIGNING_KEY_TYPE_INVALID"
            );
        }
        this.environment = environment;
        this.development = development;
    }

    sign(envelope) {
        const signed = {
            ...envelope,
            signatureMetadata: {
                algorithm: "Ed25519",
                keyId: this.keyId,
                environment: this.environment,
                development: this.development
            }
        };
        return Object.freeze({
            ...signed,
            signature: sign(
                null,
                Buffer.from(signingPayload(signed), "utf8"),
                this.privateKey
            ).toString("base64")
        });
    }
}

export class Ed25519MessageVerifier {
    constructor({ keys = {}, environment, production = false }) {
        this.environment = environment;
        this.production = production;
        this.keys = new Map(Object.entries(keys).map(([keyId, value]) => (
            [keyId, normalizeKeyRecord(keyId, value, environment)]
        )));
    }

    rotate(keyId, record) {
        this.keys.set(keyId, normalizeKeyRecord(keyId, record, this.environment));
    }

    revoke(keyId) {
        const current = this.keys.get(keyId);
        if (current) {
            this.keys.set(keyId, { ...current, revoked: true });
        }
    }

    verify(envelope) {
        const metadata = envelope?.signatureMetadata;
        if (!metadata || metadata.algorithm !== "Ed25519" || !metadata.keyId) {
            throw new MessageSecurityError(
                "Message signature metadata is missing or unsupported."
            );
        }
        if (metadata.environment !== this.environment) {
            throw new MessageSecurityError(
                "Message signature belongs to a different environment.",
                "MQTT_SIGNATURE_ENVIRONMENT_MISMATCH"
            );
        }
        const record = this.keys.get(metadata.keyId);
        if (!record?.publicKey) {
            throw new MessageSecurityError(
                "Message signing key is unknown.",
                "MQTT_SIGNING_KEY_UNKNOWN"
            );
        }
        if (record.revoked) {
            throw new MessageSecurityError(
                "Message signing key has been revoked.",
                "MQTT_SIGNING_KEY_REVOKED"
            );
        }
        if (record.environment !== this.environment) {
            throw new MessageSecurityError(
                "Signing key belongs to a different environment.",
                "MQTT_SIGNING_KEY_ENVIRONMENT_MISMATCH"
            );
        }
        if (this.production && (record.development || metadata.development)) {
            throw new MessageSecurityError(
                "Development signing keys are forbidden in production.",
                "MQTT_DEVELOPMENT_KEY_FORBIDDEN"
            );
        }
        let publicKey;
        try {
            publicKey = createPublicKey(record.publicKey);
        } catch {
            throw new MessageSecurityError(
                "Message signing key is invalid.",
                "MQTT_SIGNING_KEY_INVALID"
            );
        }
        const signature = typeof envelope.signature === "string"
            ? Buffer.from(envelope.signature, "base64") : Buffer.alloc(0);
        if (!signature.length || !verify(
            null,
            Buffer.from(signingPayload(envelope), "utf8"),
            publicKey,
            signature
        )) {
            throw new MessageSecurityError("Message signature verification failed.");
        }
        return true;
    }
}
