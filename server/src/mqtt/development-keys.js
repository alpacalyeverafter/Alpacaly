// Test/development fixtures only. Production configuration rejects these keys.
export const DEVELOPMENT_MQTT_KEYS = Object.freeze({
    server: Object.freeze({
        keyId: "alpacaly-development-server-2026-01",
        privateKey: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIGQhiT+NnpVFhT5+79jGbedsVpRR3a8h1QTzAgHoKGHN
-----END PRIVATE KEY-----`,
        publicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAGME1WkvSNrQ2PN7bX+nPiU7IzOVBg+2+TDz+9y1q0ns=
-----END PUBLIC KEY-----`
    }),
    controller: Object.freeze({
        keyId: "alpacaly-development-controller-2026-01",
        privateKey: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIDKhQC0v444tiwO2Pa84R3mMMFGLrkWKms4k2kqAr3iA
-----END PRIVATE KEY-----`,
        publicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAI7qmkT1JFPzLwvztJ275s5KgJsftp7gk9E+cZ+l/Kd8=
-----END PUBLIC KEY-----`
    })
});
