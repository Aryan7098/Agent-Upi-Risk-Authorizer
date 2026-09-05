"""FastAPI application entrypoint.

Phase 3 — full deterministic firewall (still no AI):
  POST /authorize   -> deterministic engine (all rules) -> audit -> ALLOW executes,
                       STEP_UP holds pending, BLOCK stops.
  POST /confirm/{id}-> human resolves a pending STEP_UP; executes the money action.
  PUT/GET /policy/{user_id} -> users set/read their own caps & lists (in rupees).
  GET /audit/verify -> proves the audit chain is intact / tampered.

The decision path fails safe: any error resolves toward not-executing, never a
silent allow of an unrecorded payment.
"""
from __future__ import annotations

import os
import threading
import time
from collections import defaultdict
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from firewall.combiner import combine
from firewall.llm import build_judge_from_env, draft_agent_reason
from firewall.models import (
    AuthorizationRequest,
    Decision,
    DecisionRecord,
    EngineResult,
    UserPolicy,
    new_request_id,
    now_iso,
)
from firewall.money import paise_to_rupees
from firewall.policy import DeterministicPolicyEngine
from firewall.rail import RailError, RazorpayRail
from firewall.risk import RiskModel
from firewall.storage import (
    ApiKeyStore,
    DbPolicyStore,
    IdempotencyStore,
    PendingStore,
    SqlAuditLog,
    make_engine,
)

app = FastAPI(
    title="AURA — Agent UPI Risk Authorizer",
    description="A payment-intent firewall that gates AI-agent payments against Razorpay (test mode).",
    version="0.3.0",
)

# --- Wiring (module-level so tests can substitute/patch these) ---
rail = RazorpayRail()
db_engine = make_engine()
audit = SqlAuditLog(db_engine)  # tamper-evident audit log, now DB-backed
engine = DeterministicPolicyEngine()

# AI judge — Groq -> Gemini chain, built from env keys. None if no keys are set
# (AI layer off; deterministic + ML still run).
judge = build_judge_from_env()

# ML risk layer — always-on, local, escalate-only. Trains on construction.
risk_model = RiskModel()

# Per-user policy store — persisted in the database (SQLite locally / Postgres in
# prod). Populated via PUT /policy/{user_id}; default otherwise.
DEFAULT_POLICY = UserPolicy()
policy_store = DbPolicyStore(db_engine)  # shares the same database as the audit log

# Requests held pending a human step-up confirmation — persisted, so a held
# payment survives a restart and can still be confirmed later.
pending_store = PendingStore(db_engine)

# API keys — how a real external agent authenticates to POST /authorize as its
# owner. The dashboard's own tester calls same-origin without a key.
api_key_store = ApiKeyStore(db_engine)

# Idempotency — a retry of /authorize with the same Idempotency-Key returns the
# original verdict instead of screening (or executing) the payment twice.
idempotency_store = IdempotencyStore(db_engine)


class RateLimiter:
    """A simple per-key sliding-window limiter. In-memory and per-process — fine
    for a single-worker deployment; a multi-worker fleet would move this to Redis.
    A firewall should throttle its own front door, so a leaked or runaway key
    cannot hammer /authorize."""

    def __init__(self, limit: int, window_seconds: float = 60.0):
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, list[float]] = defaultdict(list)
        self._lock = threading.Lock()

    def check(self, key: str) -> bool:
        """Record a hit; return True if allowed, False if over the limit."""
        now = time.monotonic()
        with self._lock:
            recent = [t for t in self._hits[key] if now - t < self.window]
            if len(recent) >= self.limit:
                self._hits[key] = recent
                return False
            recent.append(now)
            self._hits[key] = recent
            return True


# Requests per key per minute for key-authenticated calls (env-tunable).
rate_limiter = RateLimiter(limit=int(os.getenv("AURA_RATE_LIMIT_PER_MIN", "60")))


def get_policy(user_id: str) -> UserPolicy:
    return policy_store.get(user_id) or DEFAULT_POLICY


def _remember_merchant(user_id: str, merchant: str) -> bool:
    """Add a merchant to a user's allowlist ('trust on first use').

    Copies the policy so we never mutate the shared DEFAULT_POLICY. Idempotent
    and case-insensitive. Returns True if the merchant is now on the allowlist."""
    merchant = merchant.strip()
    if not merchant:
        return False
    updated = get_policy(user_id).model_copy(deep=True)
    if not any(merchant.casefold() == m.strip().casefold() for m in updated.merchant_allowlist):
        updated.merchant_allowlist.append(merchant)
    policy_store.set(user_id, updated)
    return True


class AuthorizeResponse(BaseModel):
    request_id: str
    amount_rupees: str  # echoed back as a string to stay exact (no float)
    decision: Decision
    reasons: list[str]
    executed: bool
    order_id: str | None = None
    execution_error: str | None = None


def _execute_on_rail(record: DecisionRecord, request: AuthorizationRequest) -> None:
    """Attempt the money action, recording the outcome honestly on `record`."""
    try:
        result = rail.create_order(
            amount=request.amount_paise,
            currency=request.currency,
            receipt=record.request_id,
            notes={"user_id": request.user_id, "agent_id": request.agent_id},
        )
        record.executed = True
        record.order_id = result.order_id
        record.reasons.append(f"executed on rail: order {result.order_id} ({result.status})")
    except RailError as exc:
        # Fail safe: decision stands, but execution failed — record it, do not
        # pretend the payment went through.
        record.executed = False
        record.execution_error = str(exc)
        record.reasons.append(f"rail execution failed: {exc}")


def _to_response(record: DecisionRecord) -> AuthorizeResponse:
    return AuthorizeResponse(
        request_id=record.request_id,
        amount_rupees=str(paise_to_rupees(record.amount_paise)),
        decision=record.decision,
        reasons=record.reasons,
        executed=record.executed,
        order_id=record.order_id,
        execution_error=record.execution_error,
    )


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "agentic-upi-payments-firewall",
        "razorpay_configured": rail.is_configured,
    }


def _bearer_token(authorization: str | None) -> str | None:
    """Extract the token from an `Authorization: Bearer <token>` header."""
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return None


@app.post("/authorize", response_model=AuthorizeResponse)
def authorize(
    request: AuthorizationRequest,
    authorization: str | None = Header(default=None),
    idempotency_key: str | None = Header(default=None),
) -> AuthorizeResponse:
    # An external agent authenticates with an API key; the key's owner becomes the
    # authoritative user_id (a caller cannot screen payments as someone else). The
    # dashboard's own tester calls same-origin without a key and uses the body's
    # user_id. A key that is present but invalid is rejected — never fail open.
    token = _bearer_token(authorization)
    if token is not None:
        meta = api_key_store.resolve_meta(token)
        if meta is None:
            raise HTTPException(status_code=401, detail="invalid or revoked API key")
        request.user_id = meta["user_id"]
        # Throttle key-authenticated traffic per individual key.
        if not rate_limiter.check(meta["id"]):
            raise HTTPException(
                status_code=429,
                detail="rate limit exceeded — slow down and retry shortly",
                headers={"Retry-After": "60"},
            )
    elif not request.user_id.strip():
        # No API key and no identity: nothing to scope the decision to.
        raise HTTPException(
            status_code=400,
            detail="user_id is required, or authenticate with an API key",
        )

    # Idempotency: a retry with the same key (scoped to this user) replays the
    # original verdict without screening or executing the payment again.
    if idempotency_key:
        prior = idempotency_store.get(request.user_id, idempotency_key)
        if prior is not None:
            return AuthorizeResponse(**prior)

    # Server owns identity + time; never trust client-supplied values for these.
    request.request_id = new_request_id()
    request.timestamp = now_iso()

    policy = get_policy(request.user_id)

    # 1. Deterministic engine (the hard floor). History comes from the audit log
    #    for daily/monthly caps and velocity.
    det = engine.evaluate(request, policy, history=audit)

    # 2. Combine rules + ML risk + AI judge (all escalate-only, fail-safe).
    #    judge=None until 4C; the ML risk layer is always on.
    combined = combine(det, judge, request, policy, risk=risk_model, history=audit)
    final = combined.decision
    llm = combined.llm_result
    risk = combined.risk_result

    record = DecisionRecord(
        request_id=request.request_id,
        user_id=request.user_id,
        merchant=request.merchant,
        amount_paise=request.amount_paise,
        decision=final,
        deterministic_result=det,
        llm_result=(
            EngineResult(decision=llm.decision, reasons=[llm.reason]) if llm else None
        ),
        reasons=list(combined.reasons),
        llm_status=combined.llm_status,
        intent_match=(llm.intent_match if llm else None),
        manipulation_suspected=(llm.manipulation_suspected if llm else None),
        model_version=(llm.model_version if llm else None),
        prompt_hash=(llm.prompt_hash if llm else None),
        temperature=(llm.temperature if llm else None),
        risk_anomaly=(risk.anomaly if risk else None),
        risk_score=(risk.score if risk else None),
    )

    # 3. Act on the decision.
    if final is Decision.ALLOW:
        _execute_on_rail(record, request)
    elif final is Decision.STEP_UP:
        # Hold the money action pending human confirmation (persisted).
        pending_store.put(request)
        record.reasons.append("held pending human confirmation (POST /confirm/{request_id})")
    # BLOCK: do nothing (no money action).

    # 4. Always write the audit entry.
    audit.append(record)

    response = _to_response(record)
    # Record the verdict under the idempotency key so a retry replays it exactly.
    if idempotency_key:
        idempotency_store.put(request.user_id, idempotency_key, response.model_dump())
    return response


@app.post("/confirm/{request_id}", response_model=AuthorizeResponse)
def confirm(request_id: str, remember: bool = False) -> AuthorizeResponse:
    """Resolve a pending STEP_UP: a human approves, so execute the money action.

    Pass `?remember=true` to also add this merchant to the user's allowlist, so
    future payments to it are allowed without another step-up."""
    request = pending_store.pop(request_id)
    if request is None:
        raise HTTPException(status_code=404, detail="no pending step-up for this request_id")

    record = DecisionRecord(
        request_id=request_id,
        user_id=request.user_id,
        merchant=request.merchant,
        amount_paise=request.amount_paise,
        decision=Decision.ALLOW,
        deterministic_result=EngineResult(
            decision=Decision.ALLOW,
            reasons=["human confirmed a held step-up"],
        ),
        reasons=[f"step-up confirmed by human for {request_id}"],
    )

    if remember and _remember_merchant(request.user_id, request.merchant):
        record.reasons.append(
            f"merchant '{request.merchant}' added to your allowlist (will auto-allow next time)"
        )

    _execute_on_rail(record, request)
    audit.append(record)
    return _to_response(record)


@app.put("/policy/{user_id}")
def set_policy(user_id: str, policy: UserPolicy) -> dict:
    """Set a user's policy (caps in rupees, e.g. "monthly_cap": "50000.00")."""
    policy_store.set(user_id, policy)
    return {"user_id": user_id, "policy": policy.model_dump(mode="json")}


@app.get("/policy/{user_id}")
def read_policy(user_id: str) -> dict:
    return {"user_id": user_id, "policy": get_policy(user_id).model_dump(mode="json")}


class CreateKeyRequest(BaseModel):
    user_id: str
    name: str = ""


@app.post("/keys")
def create_key(req: CreateKeyRequest) -> dict:
    """Mint an API key for a user. The plaintext `key` is returned ONCE here and
    never stored — the caller must copy it now."""
    if not req.user_id.strip():
        raise HTTPException(status_code=400, detail="user_id is required")
    return api_key_store.create(req.user_id, req.name)


@app.get("/keys")
def list_keys(user_id: str) -> dict:
    """Masked metadata for a user's keys (never the key itself)."""
    keys = api_key_store.list_for(user_id)
    return {"count": len(keys), "keys": keys}


@app.delete("/keys/{key_id}")
def revoke_key(key_id: str, user_id: str) -> dict:
    """Revoke one key. Scoped to its owner."""
    revoked = api_key_store.delete(key_id, user_id)
    if not revoked:
        raise HTTPException(status_code=404, detail="no such key for this user")
    return {"revoked": True, "id": key_id}


class AgentNoteRequest(BaseModel):
    style: str = "honest"  # honest | borderline | manipulative
    amount_rupees: str = ""
    merchant: str = ""
    category: str = ""
    user_intent: str = ""


@app.post("/simulate/agent-note")
def simulate_agent_note(req: AgentNoteRequest) -> dict:
    """Draft an agent's reason in the requested style (demo helper for the UI)."""
    if judge is None:
        raise HTTPException(status_code=503, detail="AI layer is not configured (no LLM keys)")
    try:
        note = draft_agent_reason(
            req.style, req.amount_rupees, req.merchant, req.category, req.user_intent
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"could not draft a reason: {exc}") from exc
    return {"agent_reason": note, "style": req.style}


@app.delete("/profile/{user_id}")
def delete_profile(user_id: str) -> dict:
    """Erase a user's data: their audit entries (chain re-sealed), their policy,
    and any held step-ups. The remaining audit chain still verifies."""
    audit_removed = audit.delete_user_and_reseal(user_id)
    policy_removed = policy_store.delete(user_id)
    pending_removed = pending_store.delete_user(user_id)
    keys_removed = api_key_store.delete_user(user_id)
    idempotency_store.delete_user(user_id)
    valid, error = audit.verify_chain()
    return {
        "user_id": user_id,
        "audit_removed": audit_removed,
        "policy_removed": policy_removed,
        "pending_removed": pending_removed,
        "keys_removed": keys_removed,
        "chain_valid": valid,
        "chain_error": error,
    }


@app.get("/audit/verify")
def audit_verify() -> dict:
    valid, error = audit.verify_chain()
    return {"valid": valid, "error": error, "entries": len(audit.read_all())}


@app.get("/audit/recent")
def audit_recent(limit: int = 25, user_id: str | None = None) -> dict:
    """Most-recent decisions first, for the live feed."""
    entries = audit.read_all()
    if user_id:
        entries = [e for e in entries if e.get("user_id") == user_id]
    recent = list(reversed(entries))[: max(1, min(limit, 200))]
    fields = ("request_id", "user_id", "amount_paise", "decision", "executed",
              "order_id", "reasons", "timestamp", "llm_status", "risk_anomaly",
              "intent_match", "manipulation_suspected", "entry_hash", "merchant",
              "deterministic_result")
    return {"count": len(recent),
            "decisions": [{k: e.get(k) for k in fields} for e in recent]}


@app.get("/pending")
def list_pending() -> dict:
    """Payments currently held awaiting human confirmation."""
    held = pending_store.list_all()
    return {"count": len(held),
            "pending": [
                {"request_id": r.request_id, "user_id": r.user_id,
                 "amount_paise": r.amount_paise, "merchant": r.merchant,
                 "category": r.category, "user_intent": r.user_intent,
                 "timestamp": r.timestamp}
                for r in held
            ]}


_PRIVACY_HTML = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AURA — Privacy Policy</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0B0C0E; color:#E7E8EB; font-family: system-ui, -apple-system, sans-serif;
         line-height:1.65; }
  main { max-width: 720px; margin: 0 auto; padding: 64px 24px 96px; }
  h1 { font-size: 1.9rem; letter-spacing:-0.02em; margin:0 0 4px; }
  .eyebrow { font-size:11px; letter-spacing:0.14em; text-transform:uppercase; color:#6B6D75; }
  h2 { font-size:1.05rem; margin:36px 0 8px; color:#E7E8EB; }
  p, li { color:#9B9DA4; font-size:0.95rem; }
  a { color:#E7E8EB; }
  .updated { color:#6B6D75; font-size:0.85rem; margin-top:8px; }
  hr { border:none; border-top:1px solid #232529; margin:28px 0; }
</style></head><body><main>
  <div class="eyebrow">AURA — Agent UPI Risk Authorizer</div>
  <h1>Privacy Policy</h1>
  <p class="updated">Test-mode application. Last updated: September 2026.</p>
  <hr>
  <p>AURA is a demonstration payment-screening firewall operated in <strong>test mode only</strong>.
     No real money moves and no real payment instruments are processed. This policy explains what
     limited data the app handles.</p>

  <h2>What we collect</h2>
  <ul>
    <li><strong>Sign-in identity.</strong> If you sign in with Google, we receive your name and email
        address to identify your session and scope your data to you. We store only an account identifier
        and display name.</li>
    <li><strong>Payment-screening data you submit.</strong> The amount, merchant, category, and intent of
        the test payments you screen, plus the resulting decisions, are stored to power your ledger,
        policy, and audit trail.</li>
    <li><strong>API keys.</strong> Keys you create are stored only as a one-way hash; the secret itself is
        shown once and never retained.</li>
  </ul>

  <h2>How we use it</h2>
  <p>Solely to operate the app for you: authenticating your session, enforcing your policy, screening test
     payments, and displaying your history. We do not sell data or use it for advertising.</p>

  <h2>Data retention & deletion</h2>
  <p>You can erase all of your data at any time from the dashboard ("Delete data"), which removes your
     audit entries, policy, held payments, and API keys.</p>

  <h2>Third parties</h2>
  <p>Sign-in is handled via Google. Test payment orders are created on Razorpay's test rail. Risk
     evaluation may call Groq and Google Gemini APIs. No real financial data is involved.</p>

  <h2>Contact</h2>
  <p>Questions about this policy: <a href="mailto:aryangopinathan07@gmail.com">aryangopinathan07@gmail.com</a>.</p>
</main></body></html>"""


@app.get("/privacy", response_class=HTMLResponse)
def privacy() -> HTMLResponse:
    """Public privacy policy — required for the Google OAuth consent screen."""
    return HTMLResponse(content=_PRIVACY_HTML)


# --- Serve the built React dashboard (single-app: no separate frontend host) ---
# Mounted LAST so all API routes above take precedence. Only mounts if the
# frontend has been built (frontend/dist exists).
_frontend_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _frontend_dist.exists():
    app.mount("/", StaticFiles(directory=str(_frontend_dist), html=True), name="frontend")
