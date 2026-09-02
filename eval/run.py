"""Evaluation runner.

Pushes the labeled dataset through the full firewall (rules + ML risk + LLM)
and reports: confusion matrix, per-class precision/recall/F1, overall accuracy,
false-positive rate AND false-positive cost (legit payments wrongly stopped),
UNSAFE allows (bad payments wrongly allowed — the dangerous errors), and an
explicit "still gets wrong" list.

Run:
  python -m eval.run              # full pipeline (uses LLM keys from .env)
  python -m eval.run --no-llm     # rules + ML only (fast, offline)

Outputs a human summary to stdout and machine-readable JSON to eval/report.json.
"""
from __future__ import annotations

import argparse
import json
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import firewall.config  # noqa: F401 — loads .env
from eval.dataset import build_dataset
from firewall.audit import AuditLog
from firewall.combiner import combine
from firewall.llm import build_judge_from_env
from firewall.models import (
    AuthorizationRequest,
    Decision,
    DecisionRecord,
    EngineResult,
    UserPolicy,
    new_request_id,
)
from firewall.money import rupees_to_paise
from firewall.policy import DeterministicPolicyEngine
from firewall.risk import RiskModel

DECISIONS = [Decision.ALLOW, Decision.STEP_UP, Decision.BLOCK]


def _seed_history(audit: AuditLog, user_id: str, history: list | None) -> None:
    if not history:
        return
    now = datetime.now(timezone.utc)
    for h in history:
        rec = DecisionRecord(
            request_id=new_request_id(),
            user_id=user_id,
            amount_paise=rupees_to_paise(h["amount_rupees"]),
            decision=Decision.ALLOW,
            deterministic_result=EngineResult(decision=Decision.ALLOW, reasons=["seed"]),
            executed=True,
            timestamp=(now - timedelta(minutes=h["minutes_ago"])).isoformat(),
        )
        audit.append(rec)


def run(use_llm: bool = True) -> dict:
    cases = build_dataset()
    tmp = Path(tempfile.mkdtemp(prefix="aura_eval_")) / "audit.jsonl"
    audit = AuditLog(tmp)
    engine = DeterministicPolicyEngine()
    risk = RiskModel()
    judge = build_judge_from_env() if use_llm else None

    predictions = []
    for i, c in enumerate(cases):
        user_id = f"eval_{i}"
        policy = UserPolicy(**(c.policy or {}))
        _seed_history(audit, user_id, c.history)

        req = AuthorizationRequest(
            agent_id="eval", user_id=user_id, amount_rupees=c.amount_rupees,
            merchant=c.merchant, category=c.category, user_intent=c.user_intent,
            agent_reason=c.agent_reason, notes=c.notes,
        )
        det = engine.evaluate(req, policy, history=audit)
        combined = combine(det, judge, req, policy, risk=risk, history=audit)

        predictions.append({
            "id": c.id, "label": c.label,
            "expected": c.expected.value, "predicted": combined.decision.value,
            "amount_paise": req.amount_paise,
            "correct": combined.decision is c.expected,
            "reasons": combined.reasons,
        })

    return _metrics(predictions, use_llm=(judge is not None))


def _metrics(preds: list[dict], use_llm: bool) -> dict:
    n = len(preds)
    labels = [d.value for d in DECISIONS]

    # Confusion matrix: matrix[truth][pred]
    matrix = {t: {p: 0 for p in labels} for t in labels}
    for r in preds:
        matrix[r["expected"]][r["predicted"]] += 1

    # Per-class precision / recall / F1.
    per_class = {}
    for d in labels:
        tp = matrix[d][d]
        fp = sum(matrix[t][d] for t in labels if t != d)
        fn = sum(matrix[d][p] for p in labels if p != d)
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
        per_class[d] = {"precision": round(precision, 3), "recall": round(recall, 3),
                        "f1": round(f1, 3), "support": tp + fn}

    # Per-label (dataset class) accuracy.
    by_label: dict[str, dict] = {}
    for r in preds:
        b = by_label.setdefault(r["label"], {"total": 0, "correct": 0})
        b["total"] += 1
        b["correct"] += int(r["correct"])

    # Safety view. ALLOW is the only outcome that moves money.
    legit = [r for r in preds if r["expected"] == "ALLOW"]
    bad = [r for r in preds if r["expected"] != "ALLOW"]
    false_positives = [r for r in legit if r["predicted"] != "ALLOW"]   # legit wrongly stopped
    unsafe_allows = [r for r in bad if r["predicted"] == "ALLOW"]        # bad wrongly allowed

    fp_rate = len(false_positives) / len(legit) if legit else 0.0
    fp_cost_paise = sum(r["amount_paise"] for r in false_positives)

    mistakes = [
        {"id": r["id"], "label": r["label"], "expected": r["expected"],
         "predicted": r["predicted"],
         # A miss is "safe" if we were over-cautious (didn't allow something that
         # should pass); "UNSAFE" if we allowed something that should not pass.
         "severity": "UNSAFE" if r["predicted"] == "ALLOW" and r["expected"] != "ALLOW" else "safe"}
        for r in preds if not r["correct"]
    ]

    correct = sum(r["correct"] for r in preds)
    return {
        "used_llm": use_llm,
        "total": n,
        "accuracy": round(correct / n, 3) if n else 0.0,
        "confusion_matrix": matrix,
        "per_class": per_class,
        "by_label": by_label,
        "false_positive_rate": round(fp_rate, 3),
        "false_positive_cost_rupees": round(fp_cost_paise / 100, 2),
        "false_positives": [{"id": r["id"], "amount_rupees": r["amount_paise"] / 100} for r in false_positives],
        "unsafe_allows": [{"id": r["id"], "label": r["label"]} for r in unsafe_allows],
        "still_gets_wrong": mistakes,
        "predictions": preds,
    }


def _print_summary(m: dict) -> None:
    line = "=" * 64
    print(line)
    print("  AURA — Evaluation Report" + ("  (rules + ML + LLM)" if m["used_llm"] else "  (rules + ML only)"))
    print(line)
    print(f"  Cases: {m['total']}   Exact-match accuracy: {m['accuracy']:.1%}")
    print()
    print("  Confusion matrix (rows = ground truth, cols = predicted):")
    labels = [d.value for d in DECISIONS]
    print("            " + "".join(f"{p:>9}" for p in labels))
    for t in labels:
        print(f"    {t:>7} " + "".join(f"{m['confusion_matrix'][t][p]:>9}" for p in labels))
    print()
    print("  Per-class:            precision   recall     f1   support")
    for d in labels:
        c = m["per_class"][d]
        print(f"    {d:>8}          {c['precision']:>8.3f} {c['recall']:>8.3f} {c['f1']:>6.3f} {c['support']:>8}")
    print()
    print("  Per-class accuracy by dataset label:")
    for label, b in m["by_label"].items():
        print(f"    {label:<18} {b['correct']}/{b['total']}")
    print()
    print("  SAFETY:")
    print(f"    False-positive rate (legit payments stopped): {m['false_positive_rate']:.1%}")
    print(f"    False-positive cost (rupees wrongly blocked): ₹{m['false_positive_cost_rupees']}")
    print(f"    UNSAFE allows (bad payments let through):     {len(m['unsafe_allows'])}")
    if m["unsafe_allows"]:
        for u in m["unsafe_allows"]:
            print(f"        !! {u['id']} ({u['label']})")
    print()
    if m["still_gets_wrong"]:
        print("  STILL GETS WRONG:")
        for w in m["still_gets_wrong"]:
            print(f"    [{w['severity']:>6}] {w['id']:<14} expected {w['expected']:<8} got {w['predicted']}")
    else:
        print("  STILL GETS WRONG: (none)")
    print(line)


def main() -> None:
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # Windows console: allow ₹ etc.
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="Run the AURA evaluation harness.")
    ap.add_argument("--no-llm", action="store_true", help="rules + ML only (skip LLM)")
    args = ap.parse_args()

    report = run(use_llm=not args.no_llm)
    _print_summary(report)

    out = Path(__file__).parent / "report.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n  Machine-readable report written to {out}")


if __name__ == "__main__":
    main()
