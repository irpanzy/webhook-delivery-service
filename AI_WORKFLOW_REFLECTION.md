# AI-Assisted Workflow & Decision-Making Reflection

This document reflects on the AI-assisted engineering process used during the implementation of the Webhook Delivery Service, outlining prompt strategies, technical trade-offs navigated, and key learnings.

---

## 1. Prompting & Engineering Strategy

Rather than treating the AI as an autocomplete engine or jumping straight into ad-hoc code, the development process was structured into distinct phases:

1. **Strategic Decomposition First**:
   - Analyzed the candidate brief with a focus on system resilience and boundary conditions (*what happens during prolonged outages? how do we avoid head-of-line blocking?*).
   - Formulated an **Implementation Plan** and architectural blueprint before writing code, explicitly addressing the 4 open-ended questions raised in the brief.

2. **Zero-Dependency & Self-Contained Constraint**:
   - Instead of spinning up Redis/PostgreSQL containers (which introduce run complexity for an evaluator), prompted for an ACID-compliant, single-process datastore: SQLite with Write-Ahead Logging (`WAL`) mode.
   - Enforced standard native modules (`fetch`, `AbortSignal.timeout`, `node:crypto`) to maintain zero native build friction and guaranteed one-line execution.

3. **Defensive Design Patterns**:
   - Directed the AI to implement enterprise-grade webhook safety patterns:
     - Full Jitter added to Exponential Backoff to avoid thundering herds.
     - Circuit Breaker pattern with `CLOSED`, `OPEN`, and `HALF_OPEN` canary probes.
     - Concurrency caps per subscription to eliminate starvation.
     - HMAC-SHA256 signature verification matching industry standards (Stripe/GitHub).

4. **Closed-Loop Verification**:
   - Prompted creation of a companion mock receiver (`src/mockReceiver.js`) and an automated verification script (`scripts/demo.js`) that automatically asserts all scenarios (instant delivery, flaky recovery, long outage isolation, DLQ manual replay).

---

## 2. Key Learnings & Workflow Observations

- **Intentional Underspecification as an Engineering Test**:
  The brief intentionally left semantics, ordering, and retry behavior open. Utilizing AI to rapidly flesh out the mathematical models (exponential backoff with jitter) and trade-off matrices allowed more time to be spent on edge cases (e.g., recovering aborted events across process restarts).
- **Head-of-Line Blocking Trap**:
  A naive implementation of a webhook worker uses an in-memory FIFO queue. When Customer A is down, Customer A's retry attempts fill the queue and block Customer B. Using a database-polled scheduled model with per-subscription concurrency quotas resolved this cleanly.
- **Transcript Transparency**:
  As requested by the brief, complete AI interaction transcripts are preserved verbatim in the repository to provide full visibility into the prompt engineering and iteration process.
