"""Checkpoint 4B: the ML risk layer flags unusual payments (escalate-only)."""
from datetime import datetime, timezone

from firewall.combiner import combine
from firewall.judge import StubJudge
from firewall.models import AuthorizationRequest, Decision, EngineResult, UserPolicy
from firewall.risk import RiskModel

NOON = "2026-08-31T13:00:00+00:00"
NOW = datetime(2026, 8, 31, 13, 0, tzinfo=timezone.utc)

# One shared model (training is deterministic via fixed seed).
model = RiskModel()


class FakeHistory:
    def __init__(self, mean_paise=None, count=0):
        self._mean, self._count = mean_paise, count

    def mean_amount_paise(self, user_id):
        return self._mean

    def txn_count(self, user_id, since):
        return self._count

    def total_spent_paise(self, user_id, since):
        return 0


def _req(amount="500.00", user="u1", ts=NOON):
    return AuthorizationRequest(
        agent_id="a1", user_id=user, amount_rupees=amount,
        merchant="Shop", category="groceries", user_intent="x", timestamp=ts,
    )


def test_normal_payment_is_not_flagged():
    # ₹500 at midday, in line with a ₹500 average, no burst -> normal.
    r = model.assess(_req("500.00"), FakeHistory(mean_paise=50000, count=0), NOW)
    assert r.anomaly is False
    assert r.decision is Decision.ALLOW


def test_amount_far_above_user_average_is_flagged():
    # User usually spends ~₹100; a ₹1900 payment is ~19x their norm -> anomaly.
    r = model.assess(_req("1900.00"), FakeHistory(mean_paise=10000, count=0), NOW)
    assert r.anomaly is True
    assert r.decision is Decision.STEP_UP
    assert "usual" in r.reason


def test_rapid_burst_is_flagged():
    # Normal amount but many payments in the last hour -> anomaly.
    r = model.assess(_req("500.00"), FakeHistory(mean_paise=50000, count=12), NOW)
    assert r.anomaly is True
    assert r.decision is Decision.STEP_UP


def test_no_history_does_not_crash():
    r = model.assess(_req("500.00"), None, NOW)
    assert r.decision in (Decision.ALLOW, Decision.STEP_UP)


def test_score_is_reproducible():
    a = model.assess(_req("1900.00"), FakeHistory(mean_paise=10000), NOW)
    b = model.assess(_req("1900.00"), FakeHistory(mean_paise=10000), NOW)
    assert a.score == b.score  # temperature-0 spirit: same input -> same output


# --- combiner integration: risk is escalate-only ---------------------------

class _AnomalyModel:
    def assess(self, request, history=None, now=None):
        from firewall.risk import RiskAssessment
        return RiskAssessment(decision=Decision.STEP_UP, anomaly=True, score=-0.2,
                              reason="unusual pattern (test)")


class _NormalModel:
    def assess(self, request, history=None, now=None):
        from firewall.risk import RiskAssessment
        return RiskAssessment(decision=Decision.ALLOW, anomaly=False, score=0.2,
                              reason="normal (test)")


def _det(d):
    return EngineResult(decision=d, reasons=[f"rules: {d.value}"])


def test_risk_escalates_allow_to_step_up():
    r = combine(_det(Decision.ALLOW), None, _req(), UserPolicy(), risk=_AnomalyModel())
    assert r.decision is Decision.STEP_UP
    assert r.risk_result.anomaly is True


def test_risk_cannot_downgrade():
    # Rules STEP_UP, ML says normal -> stays STEP_UP.
    r = combine(_det(Decision.STEP_UP), None, _req(), UserPolicy(), risk=_NormalModel())
    assert r.decision is Decision.STEP_UP


def test_risk_runs_even_when_llm_fails_and_stacks_with_fail_safe():
    # ML flags anomaly AND the judge is down -> STEP_UP (both point the same way).
    r = combine(_det(Decision.ALLOW), StubJudge(error=TimeoutError("down")),
                _req(), UserPolicy(), risk=_AnomalyModel())
    assert r.decision is Decision.STEP_UP


def test_risk_failure_is_non_fatal():
    class _Broken:
        def assess(self, *a, **k):
            raise RuntimeError("model boom")

    r = combine(_det(Decision.ALLOW), None, _req(), UserPolicy(), risk=_Broken())
    assert r.decision is Decision.ALLOW  # ignored, not fatal
    assert any("risk model unavailable" in x for x in r.reasons)
