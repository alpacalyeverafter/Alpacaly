# Barn edge controller and simulated hardware safety layer

## Scope and safety boundary

Phase 7E-2 adds a production-shaped, separately runnable Barn edge-controller
package. It proves the Barn-side lifecycle using only deterministic simulated
inputs and outputs. It does not import a GPIO library, address a physical pin,
communicate with a PLC, or energise a relay, bell, contactor, auger, or motor.

The backend Event Engine remains authoritative. Contributions create Feed
Requests and the Event Engine creates durable Device Commands. The edge process
cannot create supporter feeding, mint a replacement command, or advance the
backend lifecycle directly. It only accepts a signed, current, assigned Device
Command over the existing fenced MQTT protocol and returns a signed
acknowledgement. MQTT delivery is transport evidence, not dispense evidence.

The package is under `src/edge-controller/` and runs independently with:

```sh
npm run edge:start
```

The process uses `EDGE_DATABASE_PATH` (default `./data/barn-edge.sqlite`), never
`DATABASE_PATH`, and has no reference to backend Event Store tables. Tests assert
that its schema contains no `Events` or `DeviceCommands` table.

## Architecture

The Barn path is:

1. `SecureMqttEdgeProcess` subscribes only to its controller command,
   assignment, and relevant safety topics.
2. Existing Ed25519 envelope verification checks protocol version, signature,
   identities, expiry, assignment generation, and authority lease.
3. `SqliteEdgeStore` durably records the received command before acceptance.
4. `BarnEdgeController` applies local safety, welfare, calibration,
   maintenance, and sensor-readiness gates.
5. `SimulatedHardwareAdapter` implements the hardware abstraction without
   physical I/O.
6. `SimulatedSafetyController` is the only component allowed to grant simulated
   motor authority or request simulated auger run.
7. Versioned sensor evidence determines the outcome.
8. The final result is persisted before a signed acknowledgement is published.
9. Lost acknowledgements remain pending locally and are reconciled without
   repeating the action.

The edge process uses a controller boot UUID and durable monotonic boot counter.
The safety-controller simulator has a separate boot UUID. Every boot, shutdown,
restart recovery, and safety-controller reboot defaults all outputs to OFF.

## Independent durable journal

Edge schema version 1 contains:

- `EdgeControllerRuntime`: boot identity, generation, schema, and safe shutdown.
- `EdgeAssignments` and `EdgeSafetyStates`: last verified retained authority
  state with generation and expiry.
- `EdgeCommands`: command/delivery/Event/resource identities, fencing, expiry,
  parameters, configuration versions, timestamps, STARTED, final
  acknowledgement, delivery, reconciliation, and operator-resolution state.
- `EdgeFeedCycles`: one-cycle reservation, bell/countdown evidence, authority,
  motor evidence, sensor package, movement/quantity, outcome, and lockout.
- Append-only command/cycle history and local audit records.
- Welfare configurations, calibration records, consumed safety cycle tokens,
  maintenance state, and observability counters.

The file uses foreign keys, full synchronous durability, WAL for file-backed
stores, a busy timeout, strict tables, append-only triggers, and an integrity
check on open. A corrupt journal is rejected; it is never silently replaced.

The reservation is Event-scoped to remain compatible with the existing backend
state machine, which issues `RING_BELL` and `DISPENSE_FEED` separately. One Event
has one cycle ID, at most one bell command, and at most one dispense command.
Duplicate delivery returns persisted state and never rings or dispenses again.

## Feed-cycle execution

Internal states are `RESERVED`, `SAFETY_CHECKING`, `BELL_PENDING`,
`BELL_ACTIVE`, `COUNTDOWN`, `FINAL_CHECK`, `STARTED`, `DISPENSING`,
`EVIDENCE_COLLECTION`, and one of `COMPLETED`, `FAILED`, `CANCELLED`,
`OUTCOME_UNKNOWN`, or `OPERATOR_LOCKOUT`. They do not replace the backend Device
Command state machine.

For a dispense, the controller:

1. authenticates the envelope and persists `RECEIVED`;
2. checks controller/Barn/Feeder identity, assignment generation, command and
   lease expiry, and controller/Feeder enablement;
3. checks current platform, Barn, and Feeder software-stop state;
4. checks the independent electrical emergency stop, isolator, safety
   controller/watchdog, enclosure, hopper, and outlet;
5. rejects maintenance conflicts and unresolved uncertain outcomes;
6. requires exact current welfare and approved calibration versions;
7. applies rolling, session, quantity, failure, disagreement, cooldown,
   interval, feeding-window, bell, countdown, and duration limits;
8. rings once if necessary, runs one local countdown, and repeats all relevant
   safety and authority checks;
9. durably writes `STARTED` before requesting output authority;
10. obtains a fresh one-use cycle-token handshake;
11. runs only through the safety controller within its hard duration while
    pulsing the watchdog;
12. removes authority, collects evidence, classifies and persists the outcome;
13. publishes the signed acknowledgement.

Bell and countdown never grant motor authority. Bell failure defaults to
`CANCEL`; `CONTINUE` must be explicit. Bell mute and local countdown cancellation
stop work before STARTED.

## Hardware abstraction and safety controller

The adapter models bell, motor-authority, auger-run, warning, and maintenance
outputs. Inputs include electrical emergency-stop health, isolator, safety
readiness/watchdog, contactor, current, shaft rotation, feed flow, receiving
weight, hopper, outlet, and enclosure.

Only `SimulatedSafetyController` can change authority or auger output. Enablement
requires a healthy independent stop input, a ready controller, a fresh token
persisted in `EdgeSafetyCycleTokens`, and a duration within the independent hard
maximum. Repeated tokens are rejected. Periodic watchdog pulses are required and
their real elapsed age is checked. Trip, reboot, power restoration, shutdown,
and stuck-output evidence remove authority and never cause automatic restart.

## Sensor evidence and outcomes

Evidence schema `1.0` records motor request, safety grant, contactor, current,
shaft, flow, weight before/after/change, hopper/outlet, action duration,
timestamps, confidence, disagreement, missing fields, calibration version, and
adapter version.

- `COMPLETED` requires valid authority, a bounded action, at least two agreed
  movement signals, and quantity inside tolerance.
- `FAILED` requires affirmative proof that the motor did not start and no feed
  moved.
- `OUTCOME_UNKNOWN` follows STARTED/authority when missing, contradictory, lost,
  or interrupted evidence cannot prove the result.
- Hard-duration, continuous/excessive flow, watchdog, stuck output, safety trip,
  and disagreement evidence causes local operator lockout.

A timer alone never produces `COMPLETED`.

## Welfare and calibration

Local welfare configuration is versioned and expiring. Installation validates
every setting and may compare local maximums with server maximums; a weaker local
limit is rejected. Counts come from durable cycles, so restart cannot reset
them.

Calibration contains identity, Feeder/version, feed batch, test count, command
basis, measured outputs, average, variance/spread, tolerance, hopper condition,
creation/expiry, approval, approving operator, notes, and explicit
simulated/physical status. Only approved, current, exact-version records
authorise dispense. Production rejects simulated calibration.

No record in this phase claims a physical feeder is calibrated. Tests and
optional development bootstrapping use explicitly labelled simulator fixtures.

## Maintenance mode

Entry requires simulated local-presence evidence and operator identity, expires
strictly, blocks supporter commands, lights a separate indicator, and creates
immutable local audit records. Supported simulations are bell test, sensor test,
short auger jog, calibration test cycle, emergency-stop input test, and watchdog
test. Auger jog is hold-to-run and very short. Maintenance never creates a
Contribution, Feed Request, or supporter cycle; emergency stops and normal
safety checks still apply. Exit requires deliberate local confirmation and an
OFF/reset sequence.

## Restart and network recovery

Outputs are OFF before reconciliation:

- incomplete pre-STARTED work is cancelled;
- STARTED, dispensing, or evidence-collection uncertainty becomes
  `OUTCOME_UNKNOWN` and blocks the feeder;
- complete durable evidence creates a recovered completion acknowledgement
  without repeating the action;
- an already-created final acknowledgement is republished until delivered.

Disconnect before final check blocks STARTED because current remote safety
cannot be verified. Disconnect after STARTED cannot extend or restart the
action: it may finish only within the hard local bound and persists locally.
Authority expiry blocks every new STARTED transition. The electrical emergency
stop is local and never depends on MQTT.

## Configuration safety

Edge variables are in `.env.example`. Development may explicitly set
`EDGE_BOOTSTRAP_SIMULATED_FIXTURES=true` to install a 24-hour simulator-only
welfare/calibration fixture. The default is false.

Production edge mode requires MQTT 5 over `mqtts://`, TLS paths, a controller
signing identity/private key, server verification keys, and non-development
identity settings. It rejects development keys/identities, simulator bootstrap,
and the simulated hardware adapter. This phase has no physical adapter, so it
cannot drive production hardware.

## Administrator visibility and observability

Backend migration 10 stores signed edge status as a latest snapshot and
append-only summaries. Existing authentication and `VIEW_DEVICE_CONTROLLERS`
protect:

- `GET /api/admin/device-controllers/:controllerId/edge`
- `GET /api/admin/device-controllers/:controllerId/edge-status`

The view includes boot/journal/cycle, configuration versions, maintenance,
electrical stop, safety controller/watchdog, latest evidence, lockout,
reconciliation, and counters. Local-presence detail and signing/TLS secrets are
not published.

Counters cover restart/recovery, duplicate/stale command, lease/config expiry,
maintenance, watchdog/electrical trip, safety refusal, disagreement, missing
motor/flow evidence, uncertainty, acknowledgement loss, lockout, and
reconciliation.

Deterministic modes cover motor failure, current without shaft, shaft without
flow, flow without motor evidence, excessive/insufficient weight,
missing/contradictory evidence, empty hopper, blocked outlet, bell failure,
electrical stop, unavailable safety controller, stuck output, watchdog expiry,
safety-controller reboot/refusal, and token replay. Tests inject named restart,
disconnect, and acknowledgement-loss stages; no random failure is used.

## Future adapter boundary and remaining work

A future phase can implement another adapter behind the same input/output
contract and replace the simulator with authenticated PLC or microcontroller
communication. It must preserve the journal, one-use token, STARTED-before-
authority rule, evidence schema, hard duration, watchdog, and fail-closed config.

Unimplemented: real GPIO, PLC protocol, firmware, electrical emergency-stop
wiring, isolator/contactor/motor starter, auger, bell, load cell, current/shaft/
flow/hopper/outlet sensors, production certificates/broker, physical
calibration, commissioning, and electrical safety validation.
