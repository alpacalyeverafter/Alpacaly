# Alpacaly Phase 1 Server

This directory contains the Phase 1 backend for Alpacaly Ever After. It is a small Node.js 24 and Express service that accepts feed requests, applies welfare rules through one central server-side Event Engine, and records request activity as structured JSON logs.

## Phase 1 boundaries

Included:

- Express HTTP server
- Health endpoint
- Feed-request API
- In-memory Event Engine and queue
- Duplicate-request protection when a client request ID is supplied
- Configurable daily feed limit and feeding window
- Structured JSON application and HTTP request logs
- Automated unit and API tests

Intentionally excluded:

- Stripe or any payment processing
- Database or other persistent storage
- Authentication and authorisation
- Hardware or feeder control

All Event Engine state is held in memory and is reset whenever the server restarts. The API must not be treated as production-ready until persistence and appropriate security controls are designed.

## Requirements

- Node.js 24 LTS
- npm 11 or later

## Local setup

```sh
cd server
cp .env.example .env
npm install
npm run dev
```

The default server address is `http://localhost:3000`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment label used in logs and health output. |
| `PORT` | `3000` | HTTP listening port. |
| `LOG_LEVEL` | `info` | Pino structured-log level. |
| `MAX_DAILY_FEEDS` | `100` | Maximum feed requests accepted in one local calendar day. |
| `ENFORCE_FEEDING_WINDOW` | `false` | Reject requests outside the configured welfare window when `true`. |
| `FEEDING_WINDOW_START` | `08:00` | Local start time in 24-hour format. |
| `FEEDING_WINDOW_END` | `18:00` | Local end time in 24-hour format. |
| `REQUEST_BODY_LIMIT` | `16kb` | Maximum JSON request-body size accepted by Express. |

## API

### Health

```http
GET /health
```

Returns HTTP 200 with the service name, environment, timestamp, and process uptime.

### Submit a feed request

```http
POST /api/feed-requests
Content-Type: application/json

{
  "supporterName": "Ada",
  "source": "website",
  "message": "For the herd",
  "clientRequestId": "website-unique-request-123"
}
```

`supporterName` is required. The other fields are optional. Supplying a stable, unique `clientRequestId` lets the Event Engine reject accidental retries. Accepted requests return HTTP 202 with a server-generated feed-request ID, `QUEUED` status, and queue position.

### Read one feed request

```http
GET /api/feed-requests/:feedRequestId
```

Returns the current in-memory representation of an accepted request, or HTTP 404 after an unknown ID or a server restart.

### Event Engine status

```http
GET /api/event-engine/status
```

Returns queue totals, the current local date, accepted feed count, remaining daily allowance, and whether the feeding window is enforced. It does not expose supporter details.

Every response includes an `x-request-id` header. API errors use a consistent JSON shape containing `code`, `message`, and `requestId`.

## Structured logging

The server writes newline-delimited JSON logs to standard output. Request-completion entries include the request ID, HTTP method, path, response status, and duration. Feed-request entries include operational IDs and queue position but omit supporter names and messages.

## Tests

```sh
npm test
```

The test suite covers configuration-independent Event Engine rules and the public HTTP contract without opening a network port.

## Development Summary

Phase 1 establishes a deliberately small backend boundary around feed requests. Express owns transport concerns, the Event Engine owns validation, duplicate protection, welfare limits, and queue state, and Pino provides machine-readable operational logs. Runtime configuration is environment-based and validated at startup. The implementation has no payment, persistence, identity, or hardware side effects; those remain explicit future phases.
