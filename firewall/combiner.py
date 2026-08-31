"""Decision combiner — the safety core.

Combines the deterministic result (the hard floor) with the AI judge. Two
guarantees, both money-critical:

1. The AI can ONLY escalate. final = most_restrictive(deterministic, llm). The
   AI can never turn a BLOCK/STEP_UP into an ALLOW.
2. Fail safe. If the judge errors/times out, we never silently allow: a
   deterministic ALLOW is held for STEP_UP; a stricter deterministic decision
   stands.

`judge=None` means the AI layer is disabled (e.g. earlier phases / config off) —
then the deterministic decision passes through unchanged (this is a deliberate
config state, distinct from a judge that was tried and failed).
"""
from __future__ import annotations

from dataclasses import dataclass, field

from firewall.judge import LLMJudge, LLMResult
from firewall.models import Decision, EngineResult, SEVERITY
from firewall.risk import RiskAssessment


@dataclass
class CombinedResult:
    decision: Decision
    reasons: list[str] = field(default_factory=list)
    llm_result: LLMResult | None = None
    # "ok" | "skipped_block" | "disabled" | "failed"
    llm_status: str = "disabled"
    risk_result: RiskAssessment | None = None


def _most_restrictive(a: Decision, b: Decision) -> Decision:
    return a if SEVERITY[a] >= SEVERITY[b] else b


def combine(
    deterministic: EngineResult,
    judge: LLMJudge | None,
    request,
    policy,
    risk=None,
    history=None,
    now=None,
) -> CombinedResult:
    reasons = list(deterministic.reasons)

    # 1. Already blocked by rules → most restrictive already; skip everything.
    if deterministic.decision is Decision.BLOCK:
        return CombinedResult(Decision.BLOCK, reasons, None, "skipped_block")

    final = deterministic.decision

    # 2. ML risk layer (local, escalate-only, non-fatal). Runs even if the LLM
    #    is disabled or down — it's the always-on signal.
    risk_result = None
    if risk is not None:
        try:
            risk_result = risk.assess(request, history, now)
            if risk_result.anomaly:
                reasons.append(f"risk model: {risk_result.reason}")
                final = _most_restrictive(final, risk_result.decision)
        except Exception as exc:  # noqa: BLE001 — risk is advisory; never fatal
            reasons.append(f"risk model unavailable ({exc}); ignored")

    # 3. AI layer disabled → return with rules + risk only.
    if judge is None:
        return CombinedResult(final, reasons, None, "disabled", risk_result)

    # 4. Run the judge; fail safe on ANY error (outage, timeout, bad output).
    try:
        llm = judge.assess(request, policy)
    except Exception as exc:  # noqa: BLE001 — deliberately catch-all; must fail safe
        if final is Decision.ALLOW:
            reasons.append(
                f"AI intent/integrity check unavailable ({exc}); "
                f"holding for human confirmation (fail-safe)"
            )
            return CombinedResult(Decision.STEP_UP, reasons, None, "failed", risk_result)
        reasons.append(
            f"AI intent/integrity check unavailable ({exc}); "
            f"keeping decision {final.value}"
        )
        return CombinedResult(final, reasons, None, "failed", risk_result)

    # 5. Combine — the AI can only escalate.
    final = _most_restrictive(final, llm.decision)
    if llm.reason:
        reasons.append(f"AI: {llm.reason}")
    if not llm.intent_match:
        reasons.append("AI: payment does not match the user's stated intent")
    if llm.manipulation_suspected:
        reasons.append("AI: possible manipulation / prompt-injection detected")

    return CombinedResult(final, reasons, llm, "ok", risk_result)
