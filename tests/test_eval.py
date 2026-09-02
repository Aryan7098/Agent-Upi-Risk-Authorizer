"""Phase 5: unit-test the evaluation metrics logic (not a live run)."""
from eval.dataset import build_dataset
from eval.run import _metrics
from firewall.models import Decision


def _p(id, label, expected, predicted, amount_paise=50000):
    return {
        "id": id, "label": label,
        "expected": expected, "predicted": predicted,
        "amount_paise": amount_paise,
        "correct": expected == predicted, "reasons": [],
    }


def test_dataset_has_all_classes_and_valid_labels():
    cases = build_dataset()
    assert len(cases) >= 40
    labels = {c.label for c in cases}
    for expected in {"clean", "over-limit", "daily-cap", "velocity-abuse",
                     "denylist", "unknown-merchant", "intent-mismatch",
                     "prompt-injection"}:
        assert expected in labels
    # Every expected decision is a valid Decision.
    for c in cases:
        assert c.expected in (Decision.ALLOW, Decision.STEP_UP, Decision.BLOCK)


def test_metrics_perfect():
    preds = [
        _p("a", "clean", "ALLOW", "ALLOW"),
        _p("b", "over-limit", "BLOCK", "BLOCK"),
        _p("c", "unknown", "STEP_UP", "STEP_UP"),
    ]
    m = _metrics(preds, use_llm=True)
    assert m["accuracy"] == 1.0
    assert m["false_positive_rate"] == 0.0
    assert m["unsafe_allows"] == []
    assert m["still_gets_wrong"] == []


def test_metrics_detects_unsafe_allow():
    # A BLOCK-worthy payment wrongly allowed = the dangerous error.
    preds = [
        _p("clean1", "clean", "ALLOW", "ALLOW"),
        _p("attack", "intent-mismatch", "BLOCK", "ALLOW", amount_paise=150000),
    ]
    m = _metrics(preds, use_llm=False)
    assert len(m["unsafe_allows"]) == 1
    assert m["unsafe_allows"][0]["id"] == "attack"
    # The mistake is flagged UNSAFE.
    assert any(w["severity"] == "UNSAFE" for w in m["still_gets_wrong"])


def test_metrics_false_positive_cost():
    # A legit ALLOW payment wrongly stopped -> counts toward FP rate and cost.
    preds = [
        _p("legit-big", "clean", "ALLOW", "STEP_UP", amount_paise=5000000),  # ₹50000
        _p("legit-ok", "clean", "ALLOW", "ALLOW"),
    ]
    m = _metrics(preds, use_llm=True)
    assert m["false_positive_rate"] == 0.5
    assert m["false_positive_cost_rupees"] == 50000.0
    # Over-caution is a "safe" miss, not UNSAFE.
    assert all(w["severity"] == "safe" for w in m["still_gets_wrong"])
