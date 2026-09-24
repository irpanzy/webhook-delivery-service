# Architectural & Design Decisions

This document summarizes the core engineering decisions made for the Webhook Delivery Service, the trade-offs evaluated, and the rationale behind each choice.

---

### 1. Delivery Semantics: At-Least-Once Delivery

- **Guarantee**: **At-Least-Once Delivery**.
- **Rationale**: Exactly-once delivery across unreliable public HTTP networks is fundamentally unattainable without distributed consensus (Two-Phase Commit / 2PC), which standard HTTP endpoints do not support. If a customer endpoint successfully executes an action but the TCP connection drops or times out before our service receives the `200 OK`, we must retry to prevent event loss.
- **Cost**: Duplicate webhook deliveries can and will occur during network partitions or endpoint retries.
- **Demands on the Customer**:
  - The customer endpoint **must be idempotent**.
  - To enable easy deduplication, every webhook includes a unique `X-Event-ID` header and payload `id`. The customer should store processed event IDs in an idempotency cache/table (e.g., Redis with TTL or DB unique constraint) and return `200 OK` on duplicates without re-executing side effects.
  - Payloads include cryptographic signatures (`X-Webhook-Signature: t=...,v1=...`) using HMAC-SHA256 and a timestamp to verify authenticity and prevent replay attacks.

---

### 2. Retry Behavior & Terminal State

- **Strategy**: **Exponential Backoff with Full Jitter**:
  $$\text{Delay} = \min(\text{MaxBackoff}, \text{BaseDelay} \times 2^{\text{attempt}-1}) \times \text{Jitter}(0.75 \dots 1.25)$$
- **Parameters**: Default 5 attempts with configurable base delay (e.g., ~2s, ~4s, ~8s, ~16s, ~32s). Per-request timeout is strictly capped at 5 seconds via `AbortSignal.timeout` to prevent hanging connections (slowloris effect).
- **Why Jitter?**: Jitter prevents "thundering herd" spikes against recovering customer servers when a widespread network blip resolves.
- **Terminal State (Dead-Letter Queue / DLQ)**:
  - If delivery fails after maximum attempts, the event transitions to status `failed` (our DLQ).
  - The event is preserved indefinitely with all attempt timestamps, HTTP status codes, and error bodies for auditability.
  - Once the customer resolves their infrastructure issue, operators or automated reconciliation workflows can replay the failed events via `POST /api/events/:id/retry`.

---

### 3. Long Outages & Fairness (Customer Down for 6+ Hours)

- **Problem**: If Customer A is down for 6 hours while producing thousands of events, Customer A's failing retries must not exhaust connection pools, memory, or worker threads, starving healthy Customers B and C (Head-of-Line Blocking).
- **Mitigation & Solution**:
  1. **Non-blocking Asynchronous Retries**: Retries are scheduled with a timestamp (`next_retry_at`) in persistent storage. The dispatcher never blocks threads with `sleep()`.
  2. **Fair Concurrency Isolation**: Concurrency is partitioned per customer/subscription (`maxConcurrentPerSubscription = 2`, `maxConcurrentDeliveries = 10`). Even if Customer A has 10,000 pending failed events, Customer A can only occupy at most 2 worker slots, leaving the remaining capacity free for healthy tenants.
  3. **Circuit Breaker Pattern**:
     - If an endpoint accumulates 5 consecutive delivery failures, the circuit trips to `OPEN`.
     - New and retried events for that endpoint are immediately postponed to `next_probe_at` (e.g., 30s+ backoff) without firing HTTP requests.
     - When the probe window expires, the circuit moves to `HALF_OPEN` and fires a single canary request. If successful, the circuit resets to `CLOSED`; if it fails, the probe window backs off further.
     - This protects the customer's struggling servers from being hammered during an outage and preserves service egress resources.

---

### 4. Ordering: Best-Effort Ordering with Sequencing

- **Decision**: **Best-Effort Ordering with Monotonic Timestamps & Sequencing**, rather than strict synchronous FIFO blocking.
- **Trade-off Analysis**:
  - *Strict FIFO*: If Event #1 fails and is retrying over a 1-hour backoff window, Events #2, #3, and #4 for that customer must be stalled. A single transient failure in one event causes a catastrophic backlog for all future events of that customer.
  - *Best-Effort*: Industry leaders (Stripe, GitHub, Shopify) deliver webhooks concurrently with best-effort ordering. Events carry `created_at` timestamps and event identifiers. Customers who care about causal ordering can inspect the timestamp or version number to discard stale events (e.g., ignoring `order.created` if `order.cancelled` has already been processed).

---

### 5. Deliberately Left Out (Scope Constraints)

To respect the ~3-hour assignment time budget, the following were intentionally excluded:
- **Authentication & RBAC**: No JWT or multi-tenant user authentication on the REST API.
- **Frontend / Dashboard UI**: All observability is exposed via clean REST endpoints (`GET /api/events/:id`, `GET /api/subscriptions`).
- **External Broker Daemon (RabbitMQ/Kafka/Redis)**: SQLite was chosen with WAL mode instead. It provides true zero-dependency ACID persistence, crash recovery, and simple one-line running without requiring Docker or external services to evaluate.
