# Webhook Delivery Service

A reliable, fault-tolerant webhook delivery service built with Node.js, Express, and persistent SQLite storage. It reliably accepts events from internal producers and delivers them to customer-registered HTTP endpoints with smart retries, circuit breaking, and tenant isolation.

---

## Quick Start (One-Line Run)

### 1. Install & Start Server
```bash
npm install && npm start
```
*The service will start on `http://localhost:3000` with the SQLite database initialized at `./data/webhooks.db`.*

### 2. Run Automated Verification Test Suite
In a second terminal window (while the server is running):
```bash
npm test
```
*Runs the end-to-end automated verification script covering instant delivery, flaky endpoint recovery, 6-hour outage isolation, circuit breakers, and Dead-Letter Queue replay.*

---

## Architecture & Design Highlights

```
┌─────────────────┐       POST /api/events        ┌───────────────────────────────┐
│ Internal        │ ────────────────────────────> │ Webhook Delivery Service      │
│ Producer        │ <──────────────────────────── │ (Express.js + SQLite Engine)  │
└─────────────────┘         202 Accepted          └───────────────┬───────────────┘
                                                                  │
                                            ┌─────────────────────┴─────────────────────┐
                                            │ Asynchronous Poller & Fair Dispatcher     │
                                            │ • 5s Request Timeout (AbortSignal)        │
                                            │ • Circuit Breaker per Endpoint            │
                                            │ • Exponential Backoff + Full Jitter       │
                                            │ • Concurrency Fair Partitioning           │
                                            └──────────────┬─────────────┬──────────────┘
                                                           │             │
                                              HTTP POST    │             │   HTTP POST
                                            ┌──────────────┘             └──────────────┐
                                            ▼                                           ▼
                             ┌─────────────────────────────┐             ┌─────────────────────────────┐
                             │ Customer A (Healthy)        │             │ Customer B (Outage / Slow)  │
                             │ • Immediate 200 OK          │             │ • Isolated & Circuit Open   │
                             │ • Sub-second delivery       │             │ • Zero Head-of-Line Blocking│
                             └─────────────────────────────┘             └─────────────────────────────┘
```

1. **Delivery Guarantee**: **At-Least-Once Delivery** with unique `X-Event-ID` header and payload `id` for customer idempotency.
2. **Exponential Backoff with Full Jitter**:
   $$\text{Delay} = \min(\text{MaxDelay}, \text{Base} \times 2^{\text{attempt}-1}) \times \text{Jitter}(0.75 \dots 1.25)$$
   Prevents thundering herd problems when an outage recovers.
3. **Circuit Breaker & Outage Isolation**:
   - Outage on Customer B does **not** block Customer A (*No Head-of-Line Blocking*).
   - If an endpoint fails 5 consecutive times, its circuit trips to `OPEN`, entering progressive probe backoff to prevent hammering the dead host.
4. **Dead-Letter Queue (DLQ) & Manual Replay**:
   - Events exhausting retries enter status `failed`.
   - Operators can inspect logs and trigger manual redelivery with `POST /api/events/:id/retry`.
5. **HMAC-SHA256 Signing**:
   - Standard `X-Webhook-Signature: t=...,v1=...` header prevents tampering and replay attacks.
6. **Zero-Daemon ACID Durability**:
   - Uses SQLite in WAL (`Write-Ahead Logging`) mode. Even if the service crashes mid-delivery, pending events recover on restart.

---

## API Reference

### 1. Subscriptions

#### Register Endpoint
```bash
POST /api/subscriptions
Content-Type: application/json

{
  "customerId": "cust_123",
  "url": "http://localhost:3000/mock/success",
  "secret": "whsec_optional_custom_secret"
}
```
*Response: `201 Created` with subscription object.*

#### List Subscriptions & Circuit Breaker Status
```bash
GET /api/subscriptions
```

---

### 2. Events

#### Ingest Event
```bash
POST /api/events
Content-Type: application/json

{
  "subscriptionId": "sub_fbc1264d-c059-42d1-89f9-a1e602bc7b73",
  "eventType": "order.completed",
  "payload": {
    "orderId": "ord_9876",
    "amount": 150.00,
    "currency": "USD"
  },
  "maxAttempts": 5
}
```
*Response: `202 Accepted`*
```json
{
  "eventId": "evt_020d3a2d-6b22-4c02-bc59-0a70f9486375",
  "status": "pending",
  "subscriptionId": "sub_fbc1264d-c059-42d1-89f9-a1e602bc7b73",
  "eventType": "order.completed",
  "createdAt": "2026-09-24T03:40:00.000Z",
  "message": "Event accepted for delivery"
}
```

#### Get Event Status & Delivery Attempt History
```bash
GET /api/events/:id
```
*Response includes attempt counts, latency (ms), HTTP response codes, and error messages.*

#### List Events (with filters)
```bash
GET /api/events?status=delivered
GET /api/events?status=failed
GET /api/events?customerId=cust_123
```

#### Replay Dead-Letter Queue Event (Manual Retry)
```bash
POST /api/events/:id/retry
```
*Requeues a `failed` event back into `pending` for immediate redelivery.*

---

### 3. Built-in Mock Receivers

The service includes integrated mock endpoints for seamless local demonstration:
- `POST /mock/success`: Always returns HTTP 200 immediately.
- `POST /mock/flaky`: Fails the first 2 attempts with HTTP 500, then succeeds on attempt #3.
- `POST /mock/down`: Simulates a 6-hour outage by returning HTTP 503.
- `POST /mock/slow`: Delays response for 6s to trigger client timeout (5s).
- `POST /mock/reset`: Resets mock memory counters.

---

## Architectural Decisions Document

For the detailed reasoning on **Delivery Semantics**, **Retry Behavior**, **Long Outages**, and **Event Ordering**, please read [DECISIONS.md](./DECISIONS.md).
