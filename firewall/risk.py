"""ML risk layer — unsupervised anomaly detection (Isolation Forest).

A local, free, always-on 4th signal that asks a different question than the
rules or the LLM: *is this payment unusual for this user?* — an odd amount vs.
their history, a strange hour, or a burst of rapid payments.

Design choices (honest about what this is):
- **Unsupervised.** No labels needed. We fit an Isolation Forest on a synthetic
  "normal spending" profile (fixed seed → reproducible), and personalize per user
  through an "amount vs. this user's average" feature drawn from the audit log.
- **Escalate-only.** Like the LLM, the risk model can only raise caution. An
  anomaly maps to STEP_UP ("ask the human"), never to a silent block or allow.
  Being *unusual* is not proof of being *wrong*, so a human decides.
- **Cold start.** A brand-new user has little history; the model then leans on
  absolute signals (amount magnitude, hour, velocity) until a profile builds up.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
from pydantic import BaseModel
from sklearn.ensemble import IsolationForest

from firewall.models import Decision


class RiskAssessment(BaseModel):
    decision: Decision            # ALLOW or STEP_UP (never BLOCK)
    anomaly: bool
    score: float                  # >0 normal, <0 anomalous (raw model score)
    reason: str = ""


def _hour_of(timestamp: str) -> float:
    try:
        return float(datetime.fromisoformat(timestamp).hour)
    except (ValueError, TypeError):
        return 12.0  # neutral daytime default


class RiskModel:
    """Isolation Forest wrapper. Trains itself on construction."""

    def __init__(self, seed: int = 42, contamination: float = 0.03, n_samples: int = 2000):
        self.seed = seed
        self.model = IsolationForest(
            n_estimators=150, contamination=contamination, random_state=seed
        )
        self._fit_synthetic(n_samples)

    # --- training ------------------------------------------------------------

    def _fit_synthetic(self, n: int) -> None:
        """Fit on a synthetic profile of 'normal' payments (reproducible)."""
        rng = np.random.default_rng(self.seed)
        amount_rupees = rng.lognormal(mean=np.log(500), sigma=0.6, size=n)  # ~₹150–₹2000
        hour = np.clip(rng.normal(14, 3.5, n), 0, 23)                       # daytime-ish
        ratio = np.abs(rng.normal(1.0, 0.35, n))                           # ~1x user avg
        velocity = rng.poisson(0.4, n).astype(float)                       # a few per hour
        X = np.column_stack([
            np.log10(amount_rupees + 1),
            hour / 23.0,
            np.clip(ratio, 0, 20),
            velocity,
        ])
        self.model.fit(X)

    # --- features ------------------------------------------------------------

    def _feature_context(self, request, history, now: datetime) -> dict:
        amount_rupees = request.amount_paise / 100.0
        hour = _hour_of(request.timestamp)

        mean_paise, count_last_hour = None, 0
        if history is not None:
            mean_paise = history.mean_amount_paise(request.user_id)
            count_last_hour = history.txn_count(request.user_id, now - timedelta(hours=1))

        ratio = (request.amount_paise / mean_paise) if mean_paise else 1.0
        return {
            "amount_rupees": amount_rupees,
            "hour": hour,
            "ratio": float(min(max(ratio, 0.0), 20.0)),
            "velocity": float(count_last_hour),
        }

    def _vector(self, ctx: dict) -> np.ndarray:
        return np.array([[
            np.log10(ctx["amount_rupees"] + 1),
            ctx["hour"] / 23.0,
            ctx["ratio"],
            ctx["velocity"],
        ]])

    # --- scoring -------------------------------------------------------------

    def assess(self, request, history=None, now: datetime | None = None) -> RiskAssessment:
        now = now or datetime.now(timezone.utc)
        ctx = self._feature_context(request, history, now)
        x = self._vector(ctx)

        anomaly = int(self.model.predict(x)[0]) == -1     # -1 anomaly, 1 normal
        score = float(self.model.decision_function(x)[0])  # >0 normal, <0 anomaly

        if not anomaly:
            return RiskAssessment(
                decision=Decision.ALLOW, anomaly=False, score=round(score, 4),
                reason=f"looks normal for this user (risk score {score:.3f})",
            )

        bits = []
        if ctx["ratio"] >= 3.0:
            bits.append(f"amount is ~{ctx['ratio']:.0f}x this user's usual")
        if ctx["hour"] < 6 or ctx["hour"] > 23:
            bits.append(f"unusual hour ({int(ctx['hour'])}:00)")
        if ctx["velocity"] >= 3:
            bits.append(f"{int(ctx['velocity'])} payments in the last hour")
        detail = "; ".join(bits) if bits else "unusual combination of amount/time/frequency"
        return RiskAssessment(
            decision=Decision.STEP_UP, anomaly=True, score=round(score, 4),
            reason=f"unusual pattern — {detail} (risk score {score:.3f})",
        )
