"""Deterministic policy engine — the HARD FLOOR of the firewall.

All rules are evaluated; the result is the MOST RESTRICTIVE outcome across them,
with every triggered reason collected. Comparisons are in exact integer paise;
reasons are rendered in rupees.

Decision mapping (documented so it can be audited by eye):
  BLOCK   — hard limits: per-txn / daily / monthly cap exceeded, velocity
            exceeded, or a denylisted merchant.
  STEP_UP — needs a human: an allowlist is configured and this merchant /
            category is not on it (unknown payee).
  ALLOW   — nothing triggered.

`history` is any object exposing `total_spent_paise(user_id, since)` and
`txn_count(user_id, since)` (the AuditLog provides these). If history is absent,
the spend/velocity rules are skipped (fail-safe note: without history we cannot
prove a cap is breached, so we do not fabricate an ALLOW — those specific rules
simply don't fire, while the caller still has the hard per-txn cap and lists).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from firewall.models import (
    AuthorizationRequest,
    Decision,
    EngineResult,
    UserPolicy,
    SEVERITY,
)
from firewall.money import format_rupees

MONTH_DAYS = 30


def _norm(s: str) -> str:
    return s.strip().casefold()


def _in_list(value: str, items: list[str]) -> bool:
    v = _norm(value)
    return any(v == _norm(x) for x in items)


class DeterministicPolicyEngine:
    def evaluate(
        self,
        request: AuthorizationRequest,
        policy: UserPolicy,
        history=None,
        now: datetime | None = None,
    ) -> EngineResult:
        now = now or datetime.now(timezone.utc)
        amount = request.amount_paise
        # Each triggered rule contributes (Decision, reason).
        hits: list[tuple[Decision, str]] = []

        # --- Caps (BLOCK) -----------------------------------------------------
        if amount > policy.per_txn_cap_paise:
            hits.append((
                Decision.BLOCK,
                f"amount {format_rupees(amount)} exceeds per-transaction cap "
                f"{format_rupees(policy.per_txn_cap_paise)}",
            ))

        if policy.daily_cap_paise is not None and history is not None:
            spent = history.total_spent_paise(request.user_id, now - timedelta(days=1))
            if spent + amount > policy.daily_cap_paise:
                hits.append((
                    Decision.BLOCK,
                    f"would exceed daily cap: already spent {format_rupees(spent)} + "
                    f"{format_rupees(amount)} > {format_rupees(policy.daily_cap_paise)}",
                ))

        if policy.monthly_cap_paise is not None and history is not None:
            spent = history.total_spent_paise(request.user_id, now - timedelta(days=MONTH_DAYS))
            if spent + amount > policy.monthly_cap_paise:
                hits.append((
                    Decision.BLOCK,
                    f"would exceed monthly cap: already spent {format_rupees(spent)} + "
                    f"{format_rupees(amount)} > {format_rupees(policy.monthly_cap_paise)}",
                ))

        # --- Velocity (BLOCK) -------------------------------------------------
        if policy.max_txns_per_hour is not None and history is not None:
            n = history.txn_count(request.user_id, now - timedelta(hours=1))
            if n + 1 > policy.max_txns_per_hour:
                hits.append((
                    Decision.BLOCK,
                    f"would exceed velocity limit of {policy.max_txns_per_hour} txns/hour "
                    f"(already {n} in the last hour)",
                ))

        if policy.max_txns_per_day is not None and history is not None:
            n = history.txn_count(request.user_id, now - timedelta(days=1))
            if n + 1 > policy.max_txns_per_day:
                hits.append((
                    Decision.BLOCK,
                    f"would exceed velocity limit of {policy.max_txns_per_day} txns/day "
                    f"(already {n} in the last 24h)",
                ))

        # --- Merchant denylist (BLOCK) ---------------------------------------
        if policy.merchant_denylist and _in_list(request.merchant, policy.merchant_denylist):
            hits.append((
                Decision.BLOCK,
                f"merchant '{request.merchant}' is on the denylist",
            ))

        # --- Merchant allowlist (STEP_UP) ------------------------------------
        if policy.merchant_allowlist and not _in_list(request.merchant, policy.merchant_allowlist):
            hits.append((
                Decision.STEP_UP,
                f"merchant '{request.merchant}' is not on the allowlist — needs confirmation",
            ))

        # --- Category allowlist (STEP_UP) ------------------------------------
        if policy.category_allowlist and not _in_list(request.category, policy.category_allowlist):
            hits.append((
                Decision.STEP_UP,
                f"category '{request.category}' is not on the allowlist — needs confirmation",
            ))

        if not hits:
            return EngineResult(
                decision=Decision.ALLOW,
                reasons=[
                    f"amount {format_rupees(amount)} within per-transaction cap "
                    f"{format_rupees(policy.per_txn_cap_paise)}; no policy rule triggered"
                ],
            )

        final = max((d for d, _ in hits), key=lambda d: SEVERITY[d])
        return EngineResult(decision=final, reasons=[r for _, r in hits])
