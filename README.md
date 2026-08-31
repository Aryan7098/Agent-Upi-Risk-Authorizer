# AURA — Agent UPI Risk Authorizer

**A safety checkpoint for payments made by AI agents.**

When an AI assistant tries to pay for something on your behalf, AURA checks the
payment first. It looks at your rules and decides one of three things — **allow
it**, **pause and ask you first**, or **block it** — and writes down exactly why.
Only after it decides "allow" does the payment actually go through.

> Built for the Razorpay Buildathon. **Test mode only — no real money ever moves.**

---

## Why this exists

AI agents are starting to spend real money for people. The danger isn't only
spending too much — it's paying the wrong person, or paying for something you
never actually asked for, or an agent that has been tricked into making a bad
payment. AURA sits in the middle and makes sure every payment stays inside the
limits you set, and that you can always see the reason behind every decision.

## What it promises

1. **Your rules always win.** The smart checks (added later) can only make a
   payment *more* cautious, never override a rule you set.
2. **When in doubt, it stops.** If anything goes wrong or is unclear, AURA pauses
   or blocks the payment. It never lets a doubtful payment slip through quietly.
3. **It doesn't trust what the agent says.** Details like the shop name or the
   agent's reason are treated as information to check, not orders to follow.
4. **The money is always exact.** You work in rupees (like `500.34`) and the
   amounts are handled precisely, with no rounding surprises.
5. **Nothing is hidden.** Every decision is saved in a running record that can't
   be quietly edited later.

## How a payment flows

```
   AI Agent wants to pay
          │
          ▼
   ┌──────────────────────────────┐
   │            AURA               │
   │  • Check it against your rules │
   │  • Decide: allow / ask / block │
   │  • Save the reason             │
   └──────────────────────────────┘
          │
          ▼
   If allowed → the payment is made (Razorpay test mode)
```

## The three outcomes

| Outcome     | What it means                                              |
|-------------|------------------------------------------------------------|
| **Allow**   | The payment goes through.                                  |
| **Ask me**  | The payment is paused until you confirm it yourself.       |
| **Block**   | The payment is stopped, and the reason is saved.           |

**How AURA decides:**
- **Block** — the payment is over a limit you set (per payment, per day, or per
  month), too many payments too quickly, or the shop is on your blocked list.
- **Ask me** — you've set a list of approved shops or categories, and this one
  isn't on it, so AURA checks with you first.
- **Allow** — nothing on your list was triggered.

If more than one rule applies, the most cautious outcome wins, and every reason
is written down.

## Getting started

You'll need Python (version 3.11 or newer) and a set of Razorpay **test** keys.

```bash
# 1. Set up a workspace
python -m venv venv
# Windows:  venv\Scripts\activate      Mac/Linux:  source venv/bin/activate

# 2. Install what it needs
pip install -r requirements.txt

# 3. Add your test keys
cp .env.example .env      # then open .env and paste your keys

# 4. Start it
uvicorn api.main:app --reload
```

Your `.env` file should contain:
```
RAZORPAY_KEY_ID=your_test_key_id
RAZORPAY_KEY_SECRET=your_test_key_secret
```

These keys stay on your machine and are never shared or saved to the project.

## What you can do with it

| Action                         | What it does                                         |
|--------------------------------|------------------------------------------------------|
| `GET  /health`                 | Check that the service is running.                   |
| `POST /authorize`              | Ask AURA to check a payment (allow / ask / block).   |
| `POST /confirm/{id}`           | Approve a paused payment so it goes through.          |
| `PUT  /policy/{user_id}`       | Set your own limits and lists (in rupees).            |
| `GET  /policy/{user_id}`       | See your current limits.                              |
| `GET  /audit/verify`           | Confirm the saved records haven't been changed.       |

### A quick example

```bash
# Set your own limits: max 5000 per payment, 1000 for the month, only BigBasket allowed
curl -X PUT localhost:8000/policy/u1 \
  -H "Content-Type: application/json" \
  -d '{"per_txn_cap":"5000.00","monthly_cap":"1000.00","merchant_allowlist":["BigBasket"]}'

# The agent tries to pay 800 at BigBasket
curl -X POST localhost:8000/authorize \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"a1","user_id":"u1","amount_rupees":"800.00",
       "merchant":"BigBasket","category":"groceries",
       "user_intent":"weekly groceries"}'
# → allowed, and the payment is made
```

## What's inside

```
firewall/   the core: rules, money handling, saved records, Razorpay connection
api/        the service people talk to
tests/      automated checks that everything works
```

## Checking it works

```bash
pytest -q
```

## Where the project is

- Set-up and Razorpay connection — done
- Basic payment check end to end — done
- Full set of rules, the paused-payment flow, personal limits, and the
  tamper-proof record — done
- Smart intent checks (making sure a payment matches what you actually asked for)
  — coming next
- A full test run on many sample payments to measure how well it works — after that

**Test mode only. No real money moves.**
