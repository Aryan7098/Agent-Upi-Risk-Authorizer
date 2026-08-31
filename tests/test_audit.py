"""Phase 3: the audit log is tamper-evident (Failure mode #4)."""
import json

from firewall.audit import AuditLog
from firewall.models import Decision, DecisionRecord, EngineResult


def _record(request_id: str, amount: int, decision=Decision.ALLOW) -> DecisionRecord:
    return DecisionRecord(
        request_id=request_id,
        user_id="u1",
        amount_paise=amount,
        decision=decision,
        deterministic_result=EngineResult(decision=decision, reasons=["r"]),
        reasons=["r"],
        executed=(decision is Decision.ALLOW),
    )


def _seed(path) -> AuditLog:
    log = AuditLog(path)
    log.append(_record("req_1", 10000))
    log.append(_record("req_2", 20000))
    log.append(_record("req_3", 30000, Decision.BLOCK))
    return log


def test_intact_chain_verifies(tmp_path):
    log = _seed(tmp_path / "a.jsonl")
    valid, error = log.verify_chain()
    assert valid is True
    assert error is None


def test_chain_links_are_populated(tmp_path):
    log = _seed(tmp_path / "a.jsonl")
    entries = log.read_all()
    assert entries[0]["prev_hash"] == "0" * 64          # genesis
    assert entries[1]["prev_hash"] == entries[0]["entry_hash"]
    assert entries[2]["prev_hash"] == entries[1]["entry_hash"]


def test_edit_is_detected(tmp_path):
    p = tmp_path / "a.jsonl"
    log = _seed(p)
    lines = p.read_text(encoding="utf-8").splitlines()
    entry = json.loads(lines[1])
    entry["amount_paise"] = 99999999  # tamper with the amount, keep old hash
    lines[1] = json.dumps(entry, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")

    valid, error = log.verify_chain()
    assert valid is False
    assert "hash mismatch" in error


def test_delete_is_detected(tmp_path):
    p = tmp_path / "a.jsonl"
    log = _seed(p)
    lines = p.read_text(encoding="utf-8").splitlines()
    del lines[1]  # remove the middle entry
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")

    valid, error = log.verify_chain()
    assert valid is False
    assert "broken chain link" in error


def test_spend_and_velocity_queries(tmp_path):
    from datetime import datetime, timedelta, timezone

    log = AuditLog(tmp_path / "a.jsonl")
    log.append(_record("req_1", 10000))                    # executed
    log.append(_record("req_2", 25000))                    # executed
    log.append(_record("req_3", 50000, Decision.BLOCK))    # not executed

    since = datetime.now(timezone.utc) - timedelta(days=1)
    assert log.total_spent_paise("u1", since) == 35000     # only executed count
    assert log.txn_count("u1", since) == 2
    assert log.total_spent_paise("other", since) == 0
