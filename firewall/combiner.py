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


@dataclass
class CombinedResult:
    decision: Decision
    reasons: list[str] = field(default_factory=list)
    llm_result: LLMResult | None = None
    # "ok" | "skipped_block" | "disabled" | "failed"
    llm_status: str = "disabled"


def _most_restrictive(a: Decision, b: Decision) -> Decision:
    return a if SEVERITY[a] >= SEVERITY[b] else b


def combine(
    deterministic: EngineResult,
    judge: LLMJudge | None,
    request,
    policy,
) -> CombinedResult:
    reasons = list(deterministic.reasons)

    # 1. Already blocked by rules → most restrictive already; skip the AI call.
    if deterministic.decision is Decision.BLOCK:
        return CombinedResult(Decision.BLOCK, reasons, None, "skipped_block")

    # 2. AI layer disabled → deterministic result passes through.
    if judge is None:
        return CombinedResult(deterministic.decision, reasons, None, "disabled")

    # 3. Run the judge; fail safe on ANY error (outage, timeout, bad output).
    try:
        llm = judge.assess(request, policy)
    except Exception as exc:  # noqa: BLE001 — deliberately catch-all; must fail safe
        if deterministic.decision is Decision.ALLOW:
            reasons.append(
                f"AI intent/integrity check unavailable ({exc}); "
                f"holding for human confirmation (fail-safe)"
            )
            return CombinedResult(Decision.STEP_UP, reasons, None, "failed")
        # STEP_UP stays STEP_UP.
        reasons.append(
            f"AI intent/integrity check unavailable ({exc}); "
            f"keeping deterministic {deterministic.decision.value}"
        )
        return CombinedResult(deterministic.decision, reasons, None, "failed")

    # 4. Combine — the AI can only escalate.
    final = _most_restrictive(deterministic.decision, llm.decision)
    if llm.reason:
        reasons.append(f"AI: {llm.reason}")
    if not llm.intent_match:
        reasons.append("AI: payment does not match the user's stated intent")
    if llm.manipulation_suspected:
        reasons.append("AI: possible manipulation / prompt-injection detected")

    return CombinedResult(final, reasons, llm, "ok")
