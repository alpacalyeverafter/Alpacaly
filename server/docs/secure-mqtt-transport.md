# Secure MQTT transport (Phase 7D-2)

## Architecture and authority

The Event Engine and durable Device Command worker remain authoritative. They use
the existing `DeviceTransport` interface and do not import an MQTT library. The
configuration-selected `MqttDeviceTransport` signs an authorised Device Command,
publishes it at QoS 1 without retention, and receives signed controller messages.
Validated lifecycle acknowledgements enter the existing
`DeviceAcknowledgementService`; there is no second command state machine.

```text
Contribution -> FeedIntent -> Feed Request -> Event Engine -> DeviceCommand
    -> signed MQTT command -> simulated controller -> durable edge journal
    -> signed MQTT acknowledgement -> existing acknowledgement service
    -> Event Engine completion or OUTCOME_UNKNOWN safety escalation
```

`DEVICE_TRANSPORT=in_process` remains the default. Set it to `mqtt` to select
MQTT. Production never falls back to the in-process simulator when MQTT is
misconfigured or disconnected.

## MQTT version and test broker

Production requires MQTT 5 and an `mqtts://` URL. The production-shaped client is
mqtt.js 5.x. Automated tests start Aedes on a loopback-only ephemeral port, so no
developer installs a broker and the suite never contacts a public broker.

Aedes 0.51 supports MQTT 3.1/3.1.1, not MQTT 5. Embedded-broker tests therefore
set protocol version 4 only at the test boundary. They exercise the same client,
topics, QoS, retained-state policy, signed envelopes, reconnect logic, journal,
and command state machine. MQTT 5 packet properties and a real mutual-TLS listener
need a dedicated integration environment later. Production validation remains
hard-locked to MQTT 5.

Run the complete suite with:

```sh
cd server
npm test
```

## Topic namespace

Every identifier is validated before use. Slashes, wildcards, empty IDs, and
paths outside the configured environment are rejected.

```text
alpacaly/{environment}/v1/controllers/{controllerId}/commands
alpacaly/{environment}/v1/controllers/{controllerId}/acknowledgements
alpacaly/{environment}/v1/controllers/{controllerId}/heartbeats
alpacaly/{environment}/v1/controllers/{controllerId}/status
alpacaly/{environment}/v1/controllers/{controllerId}/assignments
alpacaly/{environment}/v1/safety/platform
alpacaly/{environment}/v1/safety/barns/{barnId}
alpacaly/{environment}/v1/safety/feeders/{feederId}
```

The application validates the topic identity against every envelope even after a
broker ACL accepts it. `MQTT_ENVIRONMENT` isolates development, test, and
production namespaces.

## Broker ACL model

The testable `BrokerAclPolicy` expresses the production ACL contract:

- A controller subscribes only to its own command and assignment topics, the
  platform safety topic, its Barn safety topic, and assigned Feeder safety topics.
- A controller publishes only its own acknowledgement, heartbeat, and status
  topics. It cannot publish commands or assignment/safety authority.
- The server publishes command, assignment, and safety state and subscribes only
  to acknowledgement, heartbeat, and status topics.
- A controller cannot access another controller or an unrelated Barn/Feeder.

The embedded broker tests exercise this as application policy. Broker-specific
ACL syntax and certificate-to-principal mapping remain deployment work because
this phase does not choose a production broker.

## Envelopes

Command envelopes use `protocolVersion=1.0` and contain `messageType`,
`commandId`, optional `eventId`, controller/Barn/Feeder/Device IDs, `action`,
`parameters`, `issuedAt`, `expiresAt`, `deliveryId`, `assignmentGeneration`, the
existing Device Command `fencingToken`, `authorityLeaseExpiresAt`,
`correlationId`, signature metadata, and signature.

The edge verifies required fields, protocol version, Ed25519 signature,
environment, all resource identities, the action allow-list, command expiry,
authority lease, current assignment generation, and current safety state before
`STARTED`. Invalid, expired, wrongly addressed, revoked-key, or stale-generation
messages never execute.

Acknowledgements support `RECEIVED`, `ACCEPTED`, `STARTED`, `COMPLETED`,
`REJECTED`, `FAILED`, and `OUTCOME_UNKNOWN`. They contain acknowledgement and
command IDs, all resource IDs, controller boot ID, durable journal sequence,
assignment generation, status, occurrence time, correlation ID, outcome details,
signature metadata, and signature. The server maps `COMPLETED` to the existing
`SUCCEEDED` result. `RECEIVED` is audit evidence and `OUTCOME_UNKNOWN` invokes
the established safety escalation. Duplicate/out-of-order handling stays in the
Phase 7C acknowledgement service.

Heartbeats and status contain boot identity, boot counter, monotonic sequence,
occurrence time, and expiry. Effective states are `ONLINE`, `STALE`, `OFFLINE`,
`DISABLED`, and `REVOKED`. Server ordering uses boot identity and sequence rather
than controller wall clock alone.

## Signing and credentials

Canonical JSON recursively sorts object keys, rejects undefined/non-finite data,
and omits only `signature` from the signed bytes. Node's Ed25519 implementation
signs and verifies these bytes. Metadata identifies algorithm, key ID,
environment, and whether a key is developmental.

The repository includes two clearly labelled Ed25519 development fixtures for
the local server and simulated controller. They are not production secrets, and
production rejects their development marker. Verification accepts multiple key
IDs for rotation. A key can be revoked immediately, after which its messages fail.
No API returns a private key, raw credential, signature, or unsafe payload.

Production obtains the server signing private key and controller public-key map
from deployment secrets. The production server does not hold controller private
keys. Private production material must never enter Git or SQLite.

## Production TLS expectations

Production startup fails unless:

- `DEVICE_TRANSPORT=mqtt`, `MQTT_PROTOCOL_VERSION=5`, and an `mqtts://` URL are set;
- CA, client certificate, and client private-key paths are configured;
- a server Ed25519 signing private key is configured;
- at least one controller public verification key is configured; and
- development signing keys and development authentication are disabled.

Certificate validation is enabled in mqtt.js. This phase creates no production
certificate, certificate authority, broker, or device credential.

## Assignment fencing and authority leases

Migration 9 adds a positive durable `assignmentGeneration`, lease expiry, and
append-only assignment history. A Feeder has exactly one active controller.
Assignment, replacement, reinstallation, disable, re-enable, and reassignment
advance the generation. Delayed old commands cannot execute; delayed old
acknowledgements are protocol evidence but cannot complete current commands.
Generations and history survive database/server restarts.

Disabling is immediate for an authorised Hardware Operator or Administrator. It
advances affected generations, expires leases, publishes disabled authority, and
creates immutable audit evidence. Production enable/re-enable and reassignment
create expiring requests requiring two distinct current approvers representing
hardware and platform-administrator authority. Identity status, role, scope, and
strong authentication are rechecked at execution. Development controls are
simpler only outside production.

A new action starts only while its command, assignment, lease, controller,
Feeder, and all applicable safety states are valid. Losing connectivity after
`STARTED` does not create a new action: the bounded action may finish and is
journalled for reconciliation.

## Retention and emergency stops

| Message | Retained |
| --- | --- |
| Command | Never |
| Acknowledgement | Never |
| Heartbeat | Never |
| Controller status / Last Will | Yes, signed with boot ID and expiry |
| Assignment | Yes, signed, expiring, generation-fenced |
| Platform/Barn/Feeder safety state | Yes, signed, expiring, generation-fenced |

On connect/reconnect the server publishes a complete signed safety snapshot,
including explicit inactive states. A controller begins fail-safe: missing,
expired, invalid, or stale safety state blocks `STARTED`. A retained stop therefore
blocks a restarted controller before any action.

Before `STARTED`, a stop rejects/cancels safely. During a bounded action the
controller checks safety again before recording the simulated physical result. A
result that cannot be proved becomes `OUTCOME_UNKNOWN`; the Feeder is blocked and
the dispense is never retried automatically.

## Durable journal and reconciliation

The edge journal persists command/controller/Feeder identity, assignment
generation, action, parameters, receipt/accept/start timestamps, durable sequence,
physical-action evidence, final state/acknowledgement, acknowledgement delivery,
and reconciliation state. Boot identity is persisted with controller state. It
survives duplicate delivery and simulated controller/server/database restart.

Reconciliation follows evidence, not MQTT delivery assumptions:

- a completed journal/final acknowledgement is replayed safely;
- a possible dispense without a provable result becomes `OUTCOME_UNKNOWN`;
- a publish proven to fail before delivery may be retried;
- broker receipt without controller evidence is uncertain;
- duplicate commands replay journal evidence and never repeat the action;
- late/duplicate/out-of-order acknowledgements remain audit-safe; and
- controller replacement and generation changes fence old traffic.

## Administrator visibility and observability

Protected APIs include:

```text
GET  /api/admin/device-transport
GET  /api/admin/device-controllers/{controllerId}/protocol
POST /api/admin/device-controllers/{controllerId}/assignments/{feederId}
```

Controller output includes boot ID/counter, effective state, last heartbeat,
status expiry, assignment generation, lease expiry/validity, and revocation state.
Protocol visibility returns transport/connection state, reconnect count,
sanitized last error, counters, and recent sanitized protocol events.

Structured counters/events cover reconnect, offline/stale controller, publish
failure, expiry, duplicate delivery, malformed input, signature/authentication
failure, fencing failure, emergency stop, lease expiry, acknowledgement latency,
and `OUTCOME_UNKNOWN`. They can feed a later monitoring exporter without choosing
a vendor now.

## Configuration

`.env.example` lists all settings. The main groups are:

- transport/namespace: `DEVICE_TRANSPORT`, `MQTT_ENVIRONMENT`,
  `MQTT_PROTOCOL_VERSION`, `MQTT_BROKER_URL`, `MQTT_CLIENT_ID`;
- connection: `MQTT_CONNECT_TIMEOUT_MS`, `MQTT_RECONNECT_PERIOD_MS`, QoS;
- authority: command expiry, authority lease, and clock-drift tolerance;
- liveness: heartbeat, stale, and offline thresholds;
- X.509: CA, client certificate, and private-key paths; and
- signing: key IDs, server private key, public-key maps, development-key switch.

## What remains simulated

The broker is embedded only in tests. The controller is a Node runtime using
SQLite in the test environment. Dispensing and bell actions are records, not
motors or sound. There is no Raspberry Pi/ESP32 software, GPIO, auger, physical
emergency-stop wiring, production broker, CA, secure element, managed enrolment,
or field network test.
