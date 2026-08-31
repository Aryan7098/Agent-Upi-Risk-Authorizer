"""Phase 3: every deterministic rule type fires, and most-restrictive wins."""
from datetime import datetime, timedelta, timezone

from firewall.models import AuthorizationRequest, Decision, UserPolicy
from firewall.policy import DeterministicPolicyEngine

engine = DeterministicPolicyEngine()
NOW = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)


def _req(amount="500.00", merchant="BigBasket", category="groceries", user="u1"):
    return AuthorizationRequest(
        agent_id="a1", user_id=user, amount_rupees=amount,
        merchant=merchant, category=category, user_intent="x",
    )


class FakeHistory:
    """Stub spend/velocity source."""
    def __init__(self, spent=0, count=0):
        self._spent, self._count = spent, count

    def total_spent_paise(self, user_id, since):
        return self._spent

    def txn_count(self, user_id, since):
        return self._count


def test_clean_allows():
    r = engine.evaluate(_req("500.00"), UserPolicy(), history=FakeHistory(), now=NOW)
    assert r.decision is Decision.ALLOW


def test_per_txn_cap_blocks():
    r = engine.evaluate(_req("5000.00"), UserPolicy(per_txn_cap="2000.00"),
                        history=FakeHistory(), now=NOW)
    assert r.decision is Decision.BLOCK
    assert any("per-transaction cap" in x for x in r.reasons)


def test_daily_cap_blocks_on_accumulated_spend():
    policy = UserPolicy(per_txn_cap="10000.00", daily_cap="5000.00")
    # Already spent ₹4800; a ₹500 txn pushes over ₹5000.
    r = engine.evaluate(_req("500.00"), policy,
                        history=FakeHistory(spent=480000), now=NOW)
    assert r.decision is Decision.BLOCK
    assert any("daily cap" in x for x in r.reasons)


def test_monthly_cap_blocks():
    policy = UserPolicy(per_txn_cap="100000.00", monthly_cap="50000.00")
    r = engine.evaluate(_req("1000.00"), policy,
                        history=FakeHistory(spent=4995000), now=NOW)
    assert r.decision is Decision.BLOCK
    assert any("monthly cap" in x for x in r.reasons)


def test_velocity_per_hour_blocks():
    policy = UserPolicy(per_txn_cap="100000.00", max_txns_per_hour=3)
    r = engine.evaluate(_req("100.00"), policy,
                        history=FakeHistory(count=3), now=NOW)
    assert r.decision is Decision.BLOCK
    assert any("txns/hour" in x for x in r.reasons)


def test_denylist_blocks():
    policy = UserPolicy(merchant_denylist=["SketchyStore"])
    r = engine.evaluate(_req(merchant="sketchystore"), policy,  # case-insensitive
                        history=FakeHistory(), now=NOW)
    assert r.decision is Decision.BLOCK
    assert any("denylist" in x for x in r.reasons)


def test_merchant_not_on_allowlist_steps_up():
    policy = UserPolicy(merchant_allowlist=["BigBasket", "Amazon"])
    r = engine.evaluate(_req(merchant="RandomShop"), policy,
                        history=FakeHistory(), now=NOW)
    assert r.decision is Decision.STEP_UP
    assert any("allowlist" in x for x in r.reasons)


def test_category_not_on_allowlist_steps_up():
    policy = UserPolicy(category_allowlist=["groceries", "utilities"])
    r = engine.evaluate(_req(category="gambling"), policy,
                        history=FakeHistory(), now=NOW)
    assert r.decision is Decision.STEP_UP


def test_most_restrictive_wins():
    # Merchant off-allowlist (STEP_UP) AND over per-txn cap (BLOCK) -> BLOCK.
    policy = UserPolicy(per_txn_cap="2000.00", merchant_allowlist=["BigBasket"])
    r = engine.evaluate(_req("5000.00", merchant="RandomShop"), policy,
                        history=FakeHistory(), now=NOW)
    assert r.decision is Decision.BLOCK
    # Both reasons are recorded.
    assert any("per-transaction cap" in x for x in r.reasons)
    assert any("allowlist" in x for x in r.reasons)
