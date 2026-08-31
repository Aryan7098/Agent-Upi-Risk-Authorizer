"""Checkpoint 4A: the combiner's two guarantees.

  1. The AI can only ESCALATE — never downgrade a deterministic decision.
  2. FAIL SAFE — a judge failure never yields a silent ALLOW.
"""
from firewall.combiner import combine
from firewall.judge import LLMResult, StubJudge
from firewall.models import AuthorizationRequest, Decision, EngineResult, UserPolicy


def _req():
    return AuthorizationRequest(
        agent_id="a1", user_id="u1", amount_rupees="500.00",
        merchant="BigBasket", category="groceries", user_intent="weekly groceries",
    )


def _det(decision: Decision) -> EngineResult:
    return EngineResult(decision=decision, reasons=[f"rules: {decision.value}"])


def _llm(decision: Decision, intent_match=True, manip=False) -> LLMResult:
    return LLMResult(
        decision=decision, intent_match=intent_match,
        manipulation_suspected=manip, reason="ai reason",
    )


# --- Guarantee 1: AI can only escalate ------------------------------------

def test_ai_escalates_allow_to_block():
    r = combine(_det(Decision.ALLOW), StubJudge(_llm(Decision.BLOCK)), _req(), UserPolicy())
    assert r.decision is Decision.BLOCK
    assert r.llm_status == "ok"


def test_ai_escalates_allow_to_step_up():
    r = combine(_det(Decision.ALLOW), StubJudge(_llm(Decision.STEP_UP)), _req(), UserPolicy())
    assert r.decision is Decision.STEP_UP


def test_ai_cannot_downgrade_step_up_to_allow():
    # Rules say STEP_UP, AI says ALLOW -> stays STEP_UP (most restrictive wins).
    r = combine(_det(Decision.STEP_UP), StubJudge(_llm(Decision.ALLOW)), _req(), UserPolicy())
    assert r.decision is Decision.STEP_UP


def test_ai_not_consulted_when_rules_already_block():
    # If the judge were called it would raise; proving it's skipped on BLOCK.
    exploding = StubJudge(error=RuntimeError("should not be called"))
    r = combine(_det(Decision.BLOCK), exploding, _req(), UserPolicy())
    assert r.decision is Decision.BLOCK
    assert r.llm_status == "skipped_block"


def test_clean_ai_keeps_allow():
    r = combine(_det(Decision.ALLOW), StubJudge(_llm(Decision.ALLOW)), _req(), UserPolicy())
    assert r.decision is Decision.ALLOW


# --- Guarantee 2: fail safe ------------------------------------------------

def test_judge_failure_holds_allow_for_step_up():
    r = combine(_det(Decision.ALLOW), StubJudge(error=TimeoutError("llm down")),
                _req(), UserPolicy())
    assert r.decision is Decision.STEP_UP          # never a silent ALLOW
    assert r.llm_status == "failed"
    assert any("unavailable" in x for x in r.reasons)


def test_judge_failure_keeps_step_up():
    r = combine(_det(Decision.STEP_UP), StubJudge(error=TimeoutError("llm down")),
                _req(), UserPolicy())
    assert r.decision is Decision.STEP_UP
    assert r.llm_status == "failed"


# --- Config: AI disabled ---------------------------------------------------

def test_disabled_judge_passes_deterministic_through():
    r = combine(_det(Decision.ALLOW), None, _req(), UserPolicy())
    assert r.decision is Decision.ALLOW
    assert r.llm_status == "disabled"


# --- Signals surface in reasons -------------------------------------------

def test_intent_mismatch_and_manipulation_add_reasons():
    r = combine(_det(Decision.ALLOW),
                StubJudge(_llm(Decision.BLOCK, intent_match=False, manip=True)),
                _req(), UserPolicy())
    assert r.decision is Decision.BLOCK
    assert any("does not match" in x for x in r.reasons)
    assert any("manipulation" in x for x in r.reasons)
