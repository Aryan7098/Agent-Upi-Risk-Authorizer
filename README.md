# AURA — Agent UPI Risk Authorizer

**A payment-intent firewall that gates AI-agent payments against Razorpay.**

AURA sits between an AI agent and Razorpay's payment APIs. It intercepts every
payment an agent attempts, evaluates it against user-defined policy (and, from
Phase 4, an AI intent/integrity check), decides **ALLOW / STEP-UP / BLOCK**,
writes a tamper-evident audit entry explaining why, and only then lets the money
action reach the rail.

> Built for the Razorpay Buildathon. **Test mode only — no real funds ever move.**

---

## Why

AI agents are starting to spend real money. The risk isn't just "too much" — it's
a payment that doesn't match what the user actually authorized, or an agent that
has been manipulated (e.g. prompt-injected) into paying the wrong party. AURA
treats deterministic spend limits as the baseline floor and layers intent &
integrity checking on top, with every decision bounded, gated, auditable, and
explainable.

## Core principles

1. **Deterministic rules are the hard floor.** The AI layer (Phase 4) can only
   *escalate* toward BLOCK, never downgrade a deterministic decision.
2. **Fail safe.** On any error, timeout, or ambiguity the system degrades toward
   STEP-UP / BLOCK — never a silent ALLOW.
3. **All agent-supplied fields are untrusted** — merchant, reason, notes are data
   to inspect, never instructions to follow.
4. **Money is exact.** Users enter rupees (e.g. `"500.34"`); internally
   everything is integer **paise** (`50034`) via `Decimal` — no floats.
5. **Every decision is auditable.** Append-only, hash-chained audit log.

## Architecture

```
   AI Agent
      │  POST /authorize  { payment intent + context }
      ▼
┌───────────────────────────────────────────────┐
│                    AURA                          │
│  1. Deterministic Policy Engine (hard floor)     │
│       per-txn / daily / monthly caps · velocity  │
│       merchant allow/denylist · category rules   │
│  2. AI Intent & Integrity Layer      (Phase 4)   │
│  3. Decision Combiner (most-restrictive wins)    │
│  4. Audit Logger (hash-chained, append-only)     │
└───────────────────────────────────────────────┘
      │  if ALLOW → execute money action
      ▼
   Razorpay Test-Mode API  (order.create)
```

## Decisions

| Outcome     | Meaning                                            |
|-------------|----------------------------------------------------|
| **ALLOW**   | Money action executed against Razorpay test mode.  |
| **STEP_UP** | Held pending human confirmation (`POST /confirm`). |
| **BLOCK**   | No money action; reason recorded.                  |

**Decision mapping (deterministic engine):**
- **BLOCK** — per-txn / daily / monthly cap exceeded, velocity exceeded, or a denylisted merchant.
- **STEP_UP** — an allowlist is configured and this merchant / category is not on it.
- **ALLOW** — nothing triggered.

All rules are evaluated and the **most restrictive** outcome wins, with every
triggered reason recorded.

## Getting started

**Requirements:** Python 3.11+ and Razorpay **test-mode** API keys.

```bash
# 1. Create and activate a virtualenv
python -m venv venv
# Windows:  venv\Scripts\activate      macOS/Linux:  source venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure secrets
cp .env.example .env      # then edit .env with your test keys

# 4. Run the server
uvicorn api.main:app --reload
```

`.env`:
```
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

## API

| Method & path              | Purpose                                             |
|----------------------------|-----------------------------------------------------|
| `GET  /health`             | Liveness + whether Razorpay keys are configured.    |
| `POST /authorize`          | Evaluate a payment intent → ALLOW / STEP_UP / BLOCK.|
| `POST /confirm/{id}`       | Human resolves a held STEP_UP; executes the action. |
| `PUT  /policy/{user_id}`   | Set a user's caps & lists (in rupees).              |
| `GET  /policy/{user_id}`   | Read a user's policy.                               |
| `GET  /audit/verify`       | Verify the audit hash chain is intact.              |

### Example

```bash
# Set your own limits (rupees)
curl -X PUT localhost:8000/policy/u1 \
  -H "Content-Type: application/json" \
  -d '{"per_txn_cap":"5000.00","monthly_cap":"1000.00","merchant_allowlist":["BigBasket"]}'

# Authorize a payment
curl -X POST localhost:8000/authorize \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"a1","user_id":"u1","amount_rupees":"800.00",
       "merchant":"BigBasket","category":"groceries",
       "user_intent":"weekly groceries"}'
# → {"decision":"ALLOW","order_id":"order_...","executed":true, ...}
```

## Project layout

```
firewall/
  config.py    # secret loading (.env), secret masking
  money.py     # exact rupee <-> paise (Decimal, no float)
  models.py    # Pydantic models: request, policy, decision record
  policy.py    # deterministic policy engine (the hard floor)
  audit.py     # hash-chained, tamper-evident audit log + verify_chain()
  rail.py      # Razorpay test-mode rail (the only file that calls Razorpay)
api/
  main.py      # FastAPI endpoints + wiring
tests/         # unit + integration tests
```

## Tests

```bash
pytest -q
```

## Failure modes handled

| # | Failure                                   | Mitigation                                                       | Status   |
|---|-------------------------------------------|-----------------------------------------------------------------|----------|
| 1 | LLM is an unreliable gate                 | Deterministic rules are the hard floor; LLM can only escalate.   | **Done** |
| 2 | LLM outage / timeout mid-decision         | Groq→Gemini→rules+ML+STEP_UP; never a silent ALLOW.              | **Done** |
| 3 | Firewall prompt-injected via payload      | Untrusted fields strictly delimited; fixed JSON output schema.   | **Done** |
| 4 | Audit log not tamper-evident              | Hash-chained entries + `verify_chain()`.                         | **Done** |
| 5 | Non-reproducible decisions                | LLM temperature 0; log model version + prompt hash.              | **Done** |

All five failure modes are implemented and demonstrable.

## Roadmap

- **Phase 0–1 ✅** Skeleton, safety, Razorpay test rail proven.
- **Phase 2 ✅** Walking skeleton: `POST /authorize` → decision → audit → rail.
- **Phase 3 ✅** Full deterministic engine, tamper-evident audit, STEP_UP + confirm, policy endpoint.
- **Phase 4 ✅** AI intent & integrity layer (Groq→Gemini judge), ML risk layer, decision combiner, LLM-outage fallback.
- **Phase 5 ✅** Evaluation harness: labeled dataset, precision/recall, false-positive rate + cost.

## Evaluation

Run `python -m eval.run` for a full metrics report (confusion matrix, per-class
precision/recall, false-positive rate + cost, and an honest "still gets wrong"
list). Headline: on 42 labeled cases, **92.9% accuracy with 0 unsafe allows** —
every error is over-caution, never a bad payment let through. The AI layer
catches 10 intent-mismatch / prompt-injection attacks that rules alone allow.
See [EVAL.md](EVAL.md) for full results, known limitations, and a development
narrative.

## Status

Phases 0–5 complete and tested (63 unit + integration tests). Four decision
signals — deterministic rules (hard floor), ML risk, and the Groq→Gemini AI
judge — combine most-restrictively, with the AI only ever escalating. **Test
mode only; no real money moves.**
