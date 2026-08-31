"""The AI intent & integrity judge — interface + result type.

The judge answers two questions about a payment: does it match what the user
authorized (`intent_match`), and does the agent look manipulated / prompt-injected
(`manipulation_suspected`). It returns a decision plus a plain-English reason.

Real providers (Groq, Gemini) are added in Checkpoint 4C. This module defines the
swappable interface (`LLMJudge`) and a `StubJudge` used for offline tests — so the
combiner and fail-safe logic can be proven without any API keys.

SECURITY: the judge only ever *inspects* agent-supplied fields as data. It can
never downgrade a deterministic decision — that guarantee lives in the combiner.
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable

from pydantic import BaseModel, Field

from firewall.models import Decision


class LLMResult(BaseModel):
    """Structured output of a judge assessment (fixed schema)."""

    decision: Decision
    intent_match: bool
    manipulation_suspected: bool
    reason: str = ""

    # Reproducibility metadata (populated by real providers in 4C).
    model_version: str = "stub"
    prompt_hash: str | None = None
    temperature: float = 0.0


@runtime_checkable
class LLMJudge(Protocol):
    """Any object with `assess(request, policy) -> LLMResult` is a judge.

    Implementations must raise on failure (timeout, outage, bad output) so the
    combiner can apply the fail-safe path — they must never return a fabricated
    ALLOW on error."""

    def assess(self, request, policy) -> LLMResult: ...


class StubJudge:
    """Test double. Returns a preset result, or raises a preset error to
    simulate an outage/timeout."""

    def __init__(self, result: LLMResult | None = None, error: Exception | None = None):
        self._result = result
        self._error = error

    def assess(self, request, policy) -> LLMResult:
        if self._error is not None:
            raise self._error
        if self._result is None:
            # A neutral, clean assessment.
            return LLMResult(
                decision=Decision.ALLOW,
                intent_match=True,
                manipulation_suspected=False,
                reason="stub: no concerns",
            )
        return self._result
