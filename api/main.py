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

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from firewall.audit import AuditLog
from firewall.combiner import combine
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

app = FastAPI(
    title="AURA — Agent UPI Risk Authorizer",
    description="A payment-intent firewall that gates AI-agent payments against Razorpay (test mode).",
    version="0.3.0",
)

# --- Wiring (module-level so tests can substitute/patch these) ---
rail = RazorpayRail()
audit = AuditLog(os.getenv("AUDIT_LOG_PATH", "audit_log.jsonl"))
engine = DeterministicPolicyEngine()

# AI judge — wired in Checkpoint 4C (Groq -> Gemini chain). None = AI layer off,
# deterministic decision passes through unchanged.
judge = None

# Per-user policy store. Populated via PUT /policy/{user_id}; default otherwise.
DEFAULT_POLICY = UserPolicy()
_policy_store: dict[str, UserPolicy] = {}

# Requests held pending a human step-up confirmation (ephemeral, in-memory).
_pending: dict[str, AuthorizationRequest] = {}


def get_policy(user_id: str) -> UserPolicy:
    return _policy_store.get(user_id, DEFAULT_POLICY)


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
    _policy_store[user_id] = updated
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


@app.post("/authorize", response_model=AuthorizeResponse)
def authorize(request: AuthorizationRequest) -> AuthorizeResponse:
    # Server owns identity + time; never trust client-supplied values for these.
    request.request_id = new_request_id()
    request.timestamp = now_iso()

    policy = get_policy(request.user_id)

    # 1. Deterministic engine (the hard floor). History comes from the audit log
    #    for daily/monthly caps and velocity.
    det = engine.evaluate(request, policy, history=audit)

    # 2. Combine with the AI judge (escalate-only, fail-safe). judge=None until 4C.
    combined = combine(det, judge, request, policy)
    final = combined.decision
    llm = combined.llm_result

    record = DecisionRecord(
        request_id=request.request_id,
        user_id=request.user_id,
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
    )

    # 3. Act on the decision.
    if final is Decision.ALLOW:
        _execute_on_rail(record, request)
    elif final is Decision.STEP_UP:
        # Hold the money action pending human confirmation.
        _pending[request.request_id] = request
        record.reasons.append("held pending human confirmation (POST /confirm/{request_id})")
    # BLOCK: do nothing (no money action).

    # 4. Always write the audit entry.
    audit.append(record)
    return _to_response(record)


@app.post("/confirm/{request_id}", response_model=AuthorizeResponse)
def confirm(request_id: str, remember: bool = False) -> AuthorizeResponse:
    """Resolve a pending STEP_UP: a human approves, so execute the money action.

    Pass `?remember=true` to also add this merchant to the user's allowlist, so
    future payments to it are allowed without another step-up."""
    request = _pending.pop(request_id, None)
    if request is None:
        raise HTTPException(status_code=404, detail="no pending step-up for this request_id")

    record = DecisionRecord(
        request_id=request_id,
        user_id=request.user_id,
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
    _policy_store[user_id] = policy
    return {"user_id": user_id, "policy": policy.model_dump(mode="json")}


@app.get("/policy/{user_id}")
def read_policy(user_id: str) -> dict:
    return {"user_id": user_id, "policy": get_policy(user_id).model_dump(mode="json")}


@app.get("/audit/verify")
def audit_verify() -> dict:
    valid, error = audit.verify_chain()
    return {"valid": valid, "error": error, "entries": len(audit.read_all())}
