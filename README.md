# AURA — Agent UPI Risk Authorizer

**A payment-intent firewall that gates AI-agent payments against Razorpay.**

AURA sits between an AI agent and Razorpay's payment APIs. It intercepts every
payment an agent attempts, evaluates it against user-defined policy, an ML risk
model, and an AI intent/integrity check, decides **ALLOW / STEP-UP / BLOCK**,
writes a tamper-evident audit entry explaining why, and only then lets the money
action reach the rail. A live React dashboard sits on top of it all.

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

1. **Deterministic rules are the hard floor.** The ML and AI layers can only
   *escalate* toward BLOCK, never downgrade a deterministic decision.
2. **Fail safe.** On any error, timeout, or ambiguity the system degrades toward
   STEP-UP / BLOCK — never a silent ALLOW.
3. **All agent-supplied fields are untrusted** — merchant, reason, notes are data
   to inspect, never instructions to follow.
4. **Money is exact.** Users enter rupees (e.g. `"500.34"`); internally
   everything is integer **paise** (`50034`) via `Decimal` — no floats.
5. **Every decision is auditable.** Append-only, hash-chained audit log,
   verifiable at any time.

## Architecture

```
   AI Agent  (or the dashboard's Payments tab, role-playing an agent)
      │  POST /authorize  { payment intent + context }
      ▼
┌────────────────────────────────────────────────────┐
│                       AURA                           │
│  1. Deterministic Policy Engine (hard floor)         │
│       per-txn / daily / monthly caps · frequency     │
│       merchant allow/denylist · category rules       │
│  2. ML Risk Layer (Isolation Forest, per-user)       │
│  3. AI Intent & Integrity Judge (Groq → Gemini)      │
│  4. Decision Combiner (most-restrictive wins)        │
│  5. Audit Logger (hash-chained, append-only, in DB)  │
└────────────────────────────────────────────────────┘
      │  ALLOW → execute   ·   STEP-UP → hold   ·   BLOCK → stop
      ▼
   Razorpay Test-Mode API  (order.create)
```

Four signals — deterministic rules (the floor), the ML risk model, and the
Groq→Gemini AI judge — are combined **most-restrictively**; the ML and AI layers
can only ever make a verdict stricter.

## Decisions

| Outcome     | Meaning                                            |
|-------------|----------------------------------------------------|
| **ALLOW**   | Money action executed against Razorpay test mode.  |
| **STEP_UP** | Held pending human confirmation (`POST /confirm`). |
| **BLOCK**   | No money action; reason recorded.                  |

**Deterministic mapping:**
- **BLOCK** — per-txn / daily / monthly cap exceeded, or a denylisted merchant.
- **STEP_UP** — payment frequency over the limit (a few over → confirm), or an
  allowlist is configured and this merchant / category isn't on it.
- **BLOCK (frequency)** — *far* over the frequency limit (past the grace band) is
  treated as abuse and blocked outright.
- **ALLOW** — nothing triggered.

All rules are evaluated and the **most restrictive** outcome wins, with every
triggered reason recorded.

## The dashboard

A React + Vite + Tailwind single-page app, served by FastAPI itself (same origin,
no CORS). Five sections:

- **Overview** — live KPIs, verdict distribution, a "what's catching payments"
  breakdown, system/integrity status, the latest decision, and the live ledger.
- **Payments** — describe a payment an agent wants to make and watch AURA clear,
  hold, or block it live. An **AI drafter** writes the agent's reason in an
  honest / borderline / manipulative style (Groq→Gemini) to demo each outcome.
- **Ledger** — the full, filterable audit feed with search, chain verification,
  and click-to-expand rows showing the three-signal breakdown.
- **Policy** — set your spending caps, payment-frequency limits, and merchant
  allow/deny + category lists.
- **Pending** — approve payments AURA has held for you.

Sign-in is via **Clerk** when a publishable key is configured, otherwise a
lightweight username login; every view is scoped to the signed-in user, who can
also erase all of their data (audit entries are removed and the hash chain is
re-sealed so it still verifies).

## Getting started

**Requirements:** Python 3.11+, Node 18+, and Razorpay **test-mode** API keys.

### Backend

```bash
python -m venv venv
# Windows:  venv\Scripts\activate      macOS/Linux:  source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # then edit .env with your keys
uvicorn api.main:app --reload
```

`.env`:
```
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
# Optional — enables the AI judge + reason drafter (deterministic + ML run without them)
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=...
# Optional — defaults to a local SQLite file (aura.db); point at Postgres for prod
DATABASE_URL=sqlite:///./aura.db
```

### Frontend

```bash
cd frontend
npm install
npm run dev      # dev server on :5173, proxies the API to :8000
# or, to serve the built app from FastAPI itself:
npm run build    # outputs frontend/dist, which api/main.py mounts at /
```

Optional Clerk auth — create an app at [clerk.com](https://clerk.com), then add
to `frontend/.env.local`:
```
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
```

## API

| Method & path                 | Purpose                                                    |
|-------------------------------|------------------------------------------------------------|
| `GET  /health`                | Liveness + whether Razorpay keys are configured.           |
| `POST /authorize`             | Evaluate a payment intent → ALLOW / STEP_UP / BLOCK.       |
| `POST /confirm/{id}`          | Human resolves a held STEP_UP; executes the action. `?remember=true` also trusts the merchant. |
| `PUT  /policy/{user_id}`      | Set a user's caps, frequency limits & lists (in rupees).   |
| `GET  /policy/{user_id}`      | Read a user's policy.                                       |
| `GET  /pending`               | Payments currently held awaiting confirmation.             |
| `GET  /audit/recent`          | Most-recent decisions (for the live feed; `?user_id=` scopes). |
| `GET  /audit/verify`          | Verify the audit hash chain is intact.                     |
| `DELETE /profile/{user_id}`   | Erase a user's data; audit chain is re-sealed and still verifies. |
| `POST /simulate/agent-note`   | Demo helper: AI-draft an agent reason in a given style.    |

### Example

```bash
# Set your own limits (rupees)
curl -X PUT localhost:8000/policy/u1 \
  -H "Content-Type: application/json" \
  -d '{"per_txn_cap":"5000.00","monthly_cap":"1000.00","max_txns_per_hour":10,"merchant_allowlist":["BigBasket"]}'

# Authorize a payment
curl -X POST localhost:8000/authorize \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"a1","user_id":"u1","amount_rupees":"800.00",
       "merchant":"BigBasket","category":"groceries",
       "user_intent":"weekly groceries","agent_reason":"buying groceries"}'
# → {"decision":"ALLOW","order_id":"order_...","executed":true, ...}
```

## Project layout

```
firewall/
  config.py    # secret loading (.env), secret masking
  money.py     # exact rupee <-> paise (Decimal, no float)
  models.py    # Pydantic models: request, policy, decision record
  policy.py    # deterministic policy engine (the hard floor)
  risk.py      # ML risk layer (Isolation Forest, per-user)
  judge.py     # LLM judge interface + stub
  llm.py       # Groq → Gemini judge chain + AI reason drafter
  combiner.py  # combines rules + risk + AI (escalate-only, fail-safe)
  audit.py     # hash-chained, tamper-evident audit log + verify_chain()
  storage.py   # SQLAlchemy persistence (SQLite / Postgres)
  rail.py      # Razorpay test-mode rail (the only file that calls Razorpay)
api/
  main.py      # FastAPI endpoints + wiring + serves the built dashboard
frontend/      # React + Vite + Tailwind dashboard
eval/          # labeled dataset + metrics harness
tests/         # unit + integration tests
```

## Tests

```bash
pytest -q      # 80 tests
```

## Failure modes handled

| # | Failure                                   | Mitigation                                                       | Status   |
|---|-------------------------------------------|-----------------------------------------------------------------|----------|
| 1 | LLM is an unreliable gate                 | Deterministic rules are the hard floor; ML/AI can only escalate. | **Done** |
| 2 | LLM outage / timeout mid-decision         | Groq→Gemini→rules+ML+STEP_UP; never a silent ALLOW.              | **Done** |
| 3 | Firewall prompt-injected via payload      | Untrusted fields strictly delimited; fixed JSON output schema.   | **Done** |
| 4 | Audit log not tamper-evident              | Hash-chained entries + `verify_chain()` (re-sealed on erasure).  | **Done** |
| 5 | Non-reproducible decisions                | LLM temperature 0; log model version + prompt hash.              | **Done** |

## Evaluation

Run `python -m eval.run` for a full metrics report (confusion matrix, per-class
precision/recall, false-positive rate + cost, and an honest "still gets wrong"
list). The AI layer catches intent-mismatch / prompt-injection attacks that
rules alone would allow, and every error is over-caution — never a bad payment
let through. See [EVAL.md](EVAL.md) for full results and limitations.

## Roadmap

- **Phase 0–2 ✅** Skeleton, safety, Razorpay test rail, walking skeleton.
- **Phase 3 ✅** Full deterministic engine, tamper-evident audit, STEP_UP + confirm, policy endpoint.
- **Phase 4 ✅** AI intent & integrity judge (Groq→Gemini), ML risk layer, decision combiner, LLM-outage fallback.
- **Phase 5 ✅** Evaluation harness: labeled dataset, precision/recall, false-positive rate + cost.
- **Phase 6 ✅** Database persistence (SQLite/Postgres) for policies, audit chain, and held step-ups.
- **Phase 7 ✅** React dashboard, Clerk auth, per-user scoping, and data erasure.
- **Phase 8 ⏳** Deployment.

## Status

Phases 0–7 complete and tested. Four decision signals — deterministic rules (the
hard floor), the ML risk model, and the Groq→Gemini AI judge — combine
most-restrictively, with the ML and AI layers only ever escalating. Everything is
persisted, auditable, and driven by a live dashboard. **Test mode only; no real
money moves.**
