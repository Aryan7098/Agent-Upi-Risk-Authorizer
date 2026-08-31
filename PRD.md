# PRD — Agentic UPI Payments Firewall
### An intent-and-integrity firewall that gates AI-agent payments against Razorpay

> **For the implementing agent (Claude Code):** Read this whole document before writing any code. Build it in the phases defined in Section 10, **in order**, and stop for a working, tested checkpoint at the end of each phase. Do not jump ahead to the intelligent layers before the deterministic skeleton runs end-to-end. When something is ambiguous or a design decision isn't specified here, ask rather than assume — this is a money-handling system and wrong assumptions are expensive.

---

## 1. One-line summary

A middleware service that sits between an AI agent and Razorpay's payment APIs. It intercepts every payment an agent attempts, evaluates it against user-defined policy **and** an AI intent/integrity check, decides **ALLOW / STEP-UP / BLOCK**, writes a tamper-evident audit entry explaining why, and only then lets the money action reach the rail.

## 2. Context & what wins

This is a hackathon submission (Razorpay Buildathon). The judging bar, across every track, rewards the same qualities: **every money action must be bounded, gated, auditable, and explainable**, with **measured results on a batch** (not a single cherry-picked demo) and **at least one failure handled gracefully**. This PRD is designed to hit that bar directly.

The differentiator vs. existing agent-payment guardrail products (Privy, Fystack, MoltPe, Locus, etc.): those are (a) almost all crypto-rail products, and (b) deterministic spend-limit engines only. This project targets **UPI / Razorpay / India's UAP direction**, and its core is the part none of them do well — **AI-based detection of whether a payment matches the user's authorized intent, and whether the agent has been manipulated or compromised (e.g. prompt injection).** Deterministic spend limits are treated as table-stakes baseline, not the headline.

## 3. What we are building (and what we are NOT)

**Building:** a working, end-to-end firewall service with a real Razorpay test-mode integration, a deterministic policy engine, an AI intent/integrity layer, a tamper-evident audit log, and an evaluation harness that measures decision quality on a labeled dataset.

**Not building (out of scope for this submission):** a real UPI/UAP production integration, a consumer UI beyond what's needed to demo, multi-tenant account management, real money movement, or mobile apps. Test mode only. No real funds ever move.

## 4. Core design principles (non-negotiable)

1. **Thinnest end-to-end slice first, intelligence later.** A single transaction must flow through the entire pipe (agent → firewall → decision → audit log → test-mode rail) before any AI, dataset, or advanced rule is added.
2. **Deterministic rules are the hard floor.** The LLM may only *increase* suspicion (escalate a decision toward BLOCK). It can never *remove* a block or downgrade a deterministic decision. Final decision = the most restrictive of (deterministic result, LLM result).
3. **The money-critical path fails safe.** On any error, timeout, or ambiguity, the system must never silently allow. It degrades toward STEP-UP or BLOCK, never toward a silent ALLOW.
4. **All transaction payload fields are untrusted.** Merchant name, product description, agent-supplied reason, and notes are attacker-controllable. They are treated as *data to be inspected*, never as *instructions to follow*.
5. **Every decision is reproducible and auditable.** Deterministic model settings, logged model version + prompt, and a hash-chained audit trail.
6. **Honest measurement.** Report precision, recall, false-positive rate **and** false-positive cost, plus an explicit list of what the system still gets wrong. No cherry-picking.

## 5. Architecture overview

```
   AI Agent
      │  POST /authorize  { payment intent + context }
      ▼
┌─────────────────────────────────────────────┐
│                 FIREWALL                      │
│                                               │
│  1. Deterministic Policy Engine (hard floor)  │
│       spend caps · velocity · allow/denylist  │
│       category rules                          │
│                                               │
│  2. AI Intent & Integrity Layer               │
│       intent match · manipulation / injection │
│       detection · plain-English reason        │
│                                               │
│  3. Decision Combiner (most-restrictive wins) │
│                                               │
│  4. Audit Logger (hash-chained, append-only)  │
└─────────────────────────────────────────────┘
      │  if ALLOW  →  execute money action
      ▼
   Razorpay Test-Mode API
```

- **ALLOW** → the money action is executed against Razorpay test mode.
- **STEP-UP** → execution is held pending simulated human confirmation (represented as a pending state + a confirm endpoint).
- **BLOCK** → no money action; reason recorded.

## 6. Data models

Use Pydantic models. Amounts are always integers in **paise** (₹500 = 50000).

**AuthorizationRequest** (what the agent sends):
- `request_id` (server-generated), `agent_id`, `user_id`
- `amount` (paise, int), `currency` (default "INR")
- `merchant` (string, untrusted), `category` (string)
- `user_intent` (string — what the user actually authorized, e.g. "buy groceries under ₹2000")
- `agent_reason` (string, untrusted — why the agent says it wants to pay)
- `notes` (dict, untrusted)
- `timestamp`

**UserPolicy** (configured per user):
- `per_txn_cap`, `daily_cap`, `monthly_cap` (paise)
- `max_txns_per_hour`, `max_txns_per_day` (velocity)
- `merchant_allowlist`, `merchant_denylist` (lists)
- `category_allowlist` (list)
- `allowed_intents` (free-text list describing what the user has authorized)

**DecisionRecord** (one per request, this is the audit entry):
- `request_id`, `decision` (ALLOW/STEP_UP/BLOCK)
- `deterministic_result`, `llm_result` (each with decision + reasons)
- `reasons` (list of plain-English strings)
- `model_version`, `prompt_hash`, `temperature`
- `timestamp`, `prev_hash`, `entry_hash`

## 7. Decision logic

1. Run the **deterministic policy engine**. It returns one of ALLOW/STEP_UP/BLOCK plus reasons. This is the floor.
2. If deterministic = BLOCK, you may skip the LLM (already most restrictive) — but still log.
3. Otherwise run the **AI intent/integrity layer**, which returns ALLOW/STEP_UP/BLOCK plus a natural-language reason and structured signals (intent_match: bool, manipulation_suspected: bool).
4. **Combine:** `final = max_severity(deterministic, llm)` where BLOCK > STEP_UP > ALLOW.
5. Write the audit entry. Then act on `final`.

## 8. Failure modes & REQUIRED mitigations

These are graded. Each must be implemented and demonstrable.

| # | Failure | Required mitigation |
|---|---------|--------------------|
| 1 | LLM is an unreliable gate (wrongly allows/blocks) | Deterministic rules are the hard floor; LLM can only escalate, never downgrade. |
| 2 | LLM outage / rate-limit / timeout mid-decision | Tiered fallback: on LLM failure, fall back to deterministic-only. Anything the rules cannot confidently clear → STEP_UP. Never a silent ALLOW. Enforce a timeout on the LLM call. |
| 3 | Firewall itself gets prompt-injected via payload fields | Treat all payload fields as untrusted data. Strictly delimit them in the prompt. Require structured JSON output against a fixed schema. The judge prompt must not be steerable by payload content. Add test cases where a field contains "ignore previous instructions…". |
| 4 | Audit log is not actually tamper-evident | Hash-chain entries: each entry stores `prev_hash` and an `entry_hash = sha256(canonical_entry + prev_hash)`. Provide a `verify_chain()` function that detects any edit/insert/delete. |
| 5 | Non-reproducible decisions | LLM temperature = 0; log `model_version`, `prompt_hash`, and `temperature` on every decision. |

## 9. Tech stack

- **Language:** Python 3.11+
- **Web framework:** FastAPI + uvicorn
- **Payment rail:** Razorpay Python SDK, **test mode only**. Keys from `.env` (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`). The confirmed-working money action is `client.order.create(...)`; treat order creation as the executed money action for this project. Structure it so it can later extend to capture / RazorpayX test payouts.
- **LLM:** a **free-tier** provider (Google Gemini Flash or Groq). Put it behind a single `LLMJudge` interface with one method (e.g. `assess(request, policy) -> LLMResult`) so the provider is swappable and so it can be mocked in tests. API key from `.env`. Never hardcode keys.
- **Storage:** start with an append-only JSONL file or SQLite for the audit log; keep it behind a small interface so it can be swapped.
- **Config:** `.env` for secrets (git-ignored). `.gitignore` must include `.env`, `venv/`, `__pycache__/` before the first commit.

## 10. Build phases (execute in order; test at each checkpoint)

**Phase 0 — Project skeleton & safety.** Set up the repo: folder structure, virtualenv, dependencies (`razorpay`, `fastapi`, `uvicorn`, `python-dotenv`, plus the chosen LLM SDK), `.env` loading, and `.gitignore` containing `.env`, `venv/`, `__pycache__/` **before any commit**. Add a `GET /health` endpoint that returns OK. **Checkpoint:** server runs, `git status` confirms `.env` is untracked.

> **Note on current state:** the Razorpay test rail is ALREADY PROVEN. A working `test_rail.py` exists that creates a test-mode order (`client.order.create(...)`) and returns an `order_...` id with status `created`. Do not re-prove the rail from scratch — fold that existing code into the project structure in Phase 0 as the rail module (`firewall/rail.py`), and move straight to Phase 2.

**Phase 1 — (already complete) Rail proven.** Order creation against Razorpay test mode works. Nothing to do here except integrate the existing `test_rail.py` logic into `firewall/rail.py` during Phase 0. **Checkpoint:** already met.

**Phase 2 — Walking skeleton (NO AI).** `POST /authorize` accepting an `AuthorizationRequest`. One hardcoded deterministic rule (e.g. `amount > per_txn_cap → BLOCK`). Write a plain audit entry. If ALLOW, execute the Phase-1 money action. **Checkpoint:** one request flows agent → firewall → decision → log → rail, both an ALLOW and a BLOCK case work.

**Phase 3 — Full deterministic policy engine + hash-chained audit.** Implement all `UserPolicy` rules (per-txn/daily/monthly caps, velocity, allow/denylist, category). Implement the hash-chained audit log + `verify_chain()`. Add the STEP_UP outcome and a `POST /confirm/{request_id}` endpoint that resolves a pending step-up. **Checkpoint:** all rule types demonstrably fire; tampering with a log entry is detected by `verify_chain()`.

**Phase 4 — AI intent & integrity layer.** Add the `LLMJudge` (temperature 0, structured JSON output, untrusted-field delimiting). It returns intent_match, manipulation_suspected, a decision, and a plain-English reason. Wire in the decision combiner (most-restrictive-wins) and the tiered fallback for LLM failure. **Checkpoint:** an intent-mismatch case and a prompt-injection case are both caught; killing the LLM (simulated outage) degrades to deterministic-only + STEP_UP, never a silent allow.

**Phase 5 — Evaluation harness (the thing that proves it works).** A labeled synthetic dataset of transactions, each tagged with a ground-truth decision and a category (clean, over-limit, velocity-abuse, denylisted-merchant, intent-mismatch, prompt-injection, etc.). A runner that pushes all of them through the firewall and outputs a confusion matrix, per-class precision/recall, false-positive rate **and** false-positive cost, and an explicit "still gets wrong" list. Output both machine-readable JSON and a human-readable summary. **Checkpoint:** `python -m eval.run` produces a metrics report.

**Phase 6 (optional, only if time remains) — Demo polish.** A minimal way to show the system live (a simple script or thin UI) and a short README with the run instructions and the failure-mode narrative.

## 11. Instructions for the implementing agent (Claude Code)

- **Work phase by phase.** Complete and verify each phase before starting the next. Do not scaffold Phases 4–5 while Phase 2 is unproven.
- **Never commit secrets.** Confirm `.env` is in `.gitignore` before the first `git add`. Never print full secrets to logs.
- **Write tests as you go.** Each phase gets at least a couple of unit/integration tests. The eval harness in Phase 5 is not a substitute for unit tests on the policy engine and hash chain.
- **Keep money-critical code deterministic and readable.** The policy engine and decision combiner must be simple enough to audit by eye. No cleverness in the gating path.
- **Treat all agent-supplied fields as hostile input** in every prompt and log.
- **Ask before assuming** on: exact policy thresholds, dataset composition, the LLM provider choice if keys aren't present, and anything involving how money actions are executed. State assumptions explicitly when you do make them.
- **Fail safe by default** everywhere: exceptions in the decision path resolve to STEP_UP or BLOCK, never ALLOW.
- Keep the code modular: `firewall/policy.py`, `firewall/judge.py`, `firewall/combiner.py`, `firewall/audit.py`, `firewall/rail.py`, `api/main.py`, `eval/`. Adjust names sensibly but keep the separation.

## 12. Definition of done

- A running FastAPI service where `POST /authorize` returns a bounded, gated, explained decision for any agent payment attempt, and executes the money action on the Razorpay test rail only when allowed.
- All five failure modes in Section 8 implemented and demonstrable.
- `verify_chain()` proves the audit log is tamper-evident.
- The eval harness produces honest metrics (precision, recall, false-positive rate + cost) on a labeled dataset, with a documented list of remaining failures.
- A README that a judge can follow to run it, plus a short written narrative of what failed during development and how it was solved.

## 13. Success metrics (report these)

- Per-class **precision & recall** on the labeled dataset (especially for BLOCK-worthy classes).
- **False-positive rate and false-positive cost** (legitimate payments wrongly blocked).
- Audit integrity: `verify_chain()` passes on an intact log and fails on a tampered one.
- Graceful degradation: demonstrated behavior under simulated LLM outage.
