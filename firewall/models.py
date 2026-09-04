"""Core data models (Pydantic).

Money is entered by users in **rupees** with up to 2 decimal places (e.g.
"500.34"), always as a JSON string to stay exact. Internally everything is an
integer number of **paise** via `firewall.money`. All agent-supplied fields
(merchant, category, user_intent, agent_reason, notes) are UNTRUSTED input —
treated as data to inspect, never as instructions.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator

from firewall.money import rupees_to_paise


class Decision(str, Enum):
    ALLOW = "ALLOW"
    STEP_UP = "STEP_UP"
    BLOCK = "BLOCK"


# Ordering for "most-restrictive wins" (used by the combiner in later phases).
SEVERITY: dict[Decision, int] = {
    Decision.ALLOW: 0,
    Decision.STEP_UP: 1,
    Decision.BLOCK: 2,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_request_id() -> str:
    return "req_" + uuid4().hex[:16]


def _validate_rupees(value, *, allow_none: bool = False, must_be_positive: bool = True) -> Decimal | None:
    """Shared validator: coerce to a 2-dp Decimal in rupees, rejecting >2 dp and
    (optionally) non-positive values. Reuses the exact paise conversion so the
    2-decimal rule lives in one place."""
    if value is None:
        if allow_none:
            return None
        raise ValueError("amount is required")
    paise = rupees_to_paise(value)  # raises on >2 decimal places / junk input
    if must_be_positive and paise <= 0:
        raise ValueError("amount must be greater than 0")
    if not must_be_positive and paise < 0:
        raise ValueError("amount cannot be negative")
    # Normalize to exactly 2 dp so money always renders as e.g. "1000.00".
    return (Decimal(paise) / 100).quantize(Decimal("0.01"))


class AuthorizationRequest(BaseModel):
    """What the agent sends to POST /authorize.

    `amount_rupees` is entered in rupees (send as a string, e.g. "500.34").
    `request_id` and `timestamp` are server-controlled and overwritten server
    side so a client cannot spoof them.
    """

    request_id: str = Field(default_factory=new_request_id)
    agent_id: str
    user_id: str

    amount_rupees: Decimal = Field(description='Amount in rupees, e.g. "500.34"; must be > 0')
    currency: str = "INR"

    merchant: str = ""          # untrusted
    category: str = ""          # untrusted
    user_intent: str = ""       # what the user actually authorized
    agent_reason: str = ""      # untrusted — why the agent says it wants to pay
    notes: dict = Field(default_factory=dict)  # untrusted

    timestamp: str = Field(default_factory=now_iso)

    @field_validator("amount_rupees", mode="before")
    @classmethod
    def _check_amount(cls, v):
        return _validate_rupees(v, allow_none=False, must_be_positive=True)

    @property
    def amount_paise(self) -> int:
        return rupees_to_paise(self.amount_rupees)


class UserPolicy(BaseModel):
    """Per-user policy. Caps are configured in **rupees** (strings) and exposed
    as `_paise` for the engine. Phase 2 uses only the per-txn cap; the rest are
    wired up in Phase 3."""

    per_txn_cap: Decimal = Decimal("2000.00")    # ₹2000 default
    daily_cap: Decimal | None = None
    monthly_cap: Decimal | None = None

    max_txns_per_hour: int | None = None
    max_txns_per_day: int | None = None

    merchant_allowlist: list[str] = Field(default_factory=list)
    merchant_denylist: list[str] = Field(default_factory=list)
    category_allowlist: list[str] = Field(default_factory=list)
    allowed_intents: list[str] = Field(default_factory=list)

    @field_validator("per_txn_cap", "daily_cap", "monthly_cap", mode="before")
    @classmethod
    def _check_caps(cls, v):
        # Caps may be None (no limit); when present they must be positive rupees.
        return _validate_rupees(v, allow_none=True, must_be_positive=True)

    @property
    def per_txn_cap_paise(self) -> int:
        return rupees_to_paise(self.per_txn_cap)

    @property
    def daily_cap_paise(self) -> int | None:
        return None if self.daily_cap is None else rupees_to_paise(self.daily_cap)

    @property
    def monthly_cap_paise(self) -> int | None:
        return None if self.monthly_cap is None else rupees_to_paise(self.monthly_cap)


class EngineResult(BaseModel):
    """Result from a single evaluator (deterministic engine or, later, the LLM)."""

    decision: Decision
    reasons: list[str] = Field(default_factory=list)


class DecisionRecord(BaseModel):
    """One audit entry per request.

    `amount_paise` is the canonical integer amount, logged for a precise,
    float-free audit trail. `prev_hash`/`entry_hash` form the tamper-evident
    hash chain (set by the AuditLog on append). The `model_version` /
    `prompt_hash` / `temperature` fields are populated in Phase 4."""

    request_id: str
    user_id: str = ""
    merchant: str = ""
    amount_paise: int
    decision: Decision
    deterministic_result: EngineResult
    llm_result: EngineResult | None = None
    reasons: list[str] = Field(default_factory=list)

    executed: bool = False
    order_id: str | None = None
    execution_error: str | None = None

    # AI intent/integrity signals (Phase 4).
    intent_match: bool | None = None
    manipulation_suspected: bool | None = None
    llm_status: str | None = None  # ok | skipped_block | disabled | failed

    # ML risk layer signals (Phase 4B).
    risk_anomaly: bool | None = None
    risk_score: float | None = None

    # Reproducibility (Phase 4).
    model_version: str | None = None
    prompt_hash: str | None = None
    temperature: float | None = None

    timestamp: str = Field(default_factory=now_iso)

    # Hash chain (set by AuditLog.append).
    prev_hash: str | None = None
    entry_hash: str | None = None
