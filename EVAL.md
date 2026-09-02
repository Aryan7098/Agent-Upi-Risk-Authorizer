# AURA — Evaluation & Development Notes

This document reports how well AURA actually performs on a labeled dataset, what
it still gets wrong, and an honest account of what broke during development and
how it was fixed. No cherry-picking.

## How to run

```bash
python -m eval.run            # full pipeline (rules + ML risk + LLM); needs .env keys
python -m eval.run --no-llm   # rules + ML only (fast, offline)
```

Outputs a human-readable summary plus machine-readable `eval/report.json`.

## The dataset

42 labeled synthetic transactions across 13 classes. Each has a ground-truth
decision (ALLOW / STEP_UP / BLOCK). Stateful classes (daily-cap, velocity) seed
prior payments into the audit log so the accumulated state is real.

| Class | Expected | Notes |
|-------|----------|-------|
| clean | ALLOW | normal, matches intent, within limits |
| over-limit | BLOCK | over the per-transaction cap |
| daily-cap | BLOCK | accumulated spend exceeds the daily cap |
| velocity-abuse | BLOCK | too many payments in the window |
| denylist | BLOCK | merchant on the denylist |
| unknown-merchant | STEP_UP | allowlist set, merchant not on it |
| intent-mismatch | BLOCK | payment contradicts the stated intent (LLM) |
| prompt-injection | BLOCK | adversarial text in a field (LLM) |
| **hard-*** | mixed | deliberately borderline / adversarial cases |

## Results

Representative run (LLM output can vary slightly; temperature is 0):

| Metric | Rules + ML only | Full pipeline (+ LLM) |
|--------|-----------------|-----------------------|
| Exact-match accuracy | 70.6% | **92.9%** |
| intent-mismatch caught | 0 / 5 | **5 / 5** |
| prompt-injection caught | 0 / 5 | **5 / 5** |
| Unsafe allows (bad payments let through) | 10 | **0** |
| False-positive rate | 0% | 22.2% (hard tier only) |
| False-positive cost | ₹0 | ₹52,000 |

Per-class (full pipeline): ALLOW precision 1.00 / recall 0.78; STEP_UP 0.67 /
0.80; BLOCK 0.97 / 1.00.

### The most important number: **0 unsafe allows**

Across every case, AURA never allowed a payment that should have been stopped.
Every error it makes is in the *safe* direction — being over-cautious — never the
dangerous direction of letting a bad payment through.

### Why the LLM layer earns its place

Without the LLM, rules + ML score 70.6% and allow **10** attacks (all the
intent-mismatch and prompt-injection cases). With the LLM they are all caught.
The deterministic layer cannot understand *intent*; the AI layer can. This
contrast is the core justification for the AI layer.

## What it still gets wrong

All current misses are "safe" (over-cautious). From the representative run:

1. **`hard-boundary-eq`** — user intent said *"under 2000"*, amount was *exactly*
   ₹2000. Rules allow it (2000 is not `> 2000`), but the LLM flagged that ₹2000
   is not *under* ₹2000 and asked for confirmation. Arguably the label is wrong
   and the system is right — a good example of ground truth itself being fuzzy.
2. **`hard-unusual-legit`** — a user who normally spends ~₹200 makes a legitimate
   ₹50,000 one-off purchase. The ML risk layer flags it (~250× their norm) and
   asks for confirmation. Over-cautious, but sensible; this is the main driver of
   the ₹52,000 false-positive cost.
3. **`hard-subtle-drift`** — a ₹8,000 person-to-person transfer under a
   "groceries" intent. Expected STEP_UP; the LLM judged it a clear contradiction
   and blocked. Debatable, but safe.

### Known limitations

- **Cold start.** The ML risk layer needs history to personalize; a brand-new
  user leans on absolute signals until a profile builds.
- **Ground truth for borderline cases is subjective.** Some "hard" labels are
  genuinely debatable; we report exact-match accuracy *and* a safety view
  (unsafe allows) so the honest picture is visible.
- **LLM variability.** Even at temperature 0, providers can differ slightly. The
  fixed schema + escalate-only combiner bound the impact, but the exact STEP_UP
  vs BLOCK split on borderline cases can move between runs.
- **Self-learning is intentionally NOT in the live money path.** The risk model
  personalizes from history and the "remember merchant" feature learns trusted
  payees from explicit human confirmation, but no component retrains itself in
  real time — that would be vulnerable to poisoning (an attacker slowly
  normalizing bad payments) and would undermine reproducibility. A bounded,
  offline feedback loop is future work.

## What broke during development (and the fix)

- **`test_rail.py` did not exist.** The brief said a proven rail module existed to
  fold in; it wasn't there. Wrote `firewall/rail.py` from the spec and proved it
  live against Razorpay test mode instead.
- **Money as "long with decimals."** Considered storing rupee decimals directly.
  Rejected: a `long`/int can't hold decimals and floats corrupt money
  (`0.1 + 0.2 != 0.3`). Settled on rupees-as-string at the edge, parsed via
  `Decimal`, stored as exact integer paise internally — and we *reject* any
  amount finer than a paisa rather than silently rounding.
- **Retired LLM model names.** `llama-3.3-70b-versatile` and `gemini-2.0-flash`
  both 404'd — the keys were valid, the models were decommissioned. Queried each
  provider's live model list and switched to `openai/gpt-oss-120b` and
  `gemini-flash-lite-latest`.
- **Wrong-type Gemini credential (suspected).** The Gemini key format looked
  unusual; it authenticated for model listing but `generateContent` 404'd until
  the model name was corrected — the error message ("no longer available to new
  users") revealed the real cause.
- **Windows console couldn't print ₹.** The evaluation summary crashed on the
  rupee glyph under cp1252. Fixed by reconfiguring stdout to UTF-8 (the JSON
  report was always UTF-8 and unaffected).
- **The dataset was too easy (100%).** A perfect score on a self-authored dataset
  is a cherry-picking risk and hurts credibility. Added a hard/adversarial tier
  that dropped the score to 92.9% and surfaced three real (safe) failure modes —
  a more honest and more convincing result.
