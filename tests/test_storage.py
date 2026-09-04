"""Phase 6A/6B: policies and the audit log persist in the database."""
import json

from sqlalchemy import select

from firewall.models import (
    AuthorizationRequest,
    Decision,
    DecisionRecord,
    EngineResult,
    UserPolicy,
)
from firewall.storage import (
    DbPolicyStore,
    PendingStore,
    SqlAuditLog,
    audit_table,
    make_engine,
)


def test_policy_roundtrip(tmp_path):
    url = f"sqlite:///{tmp_path / 'aura.db'}"
    store = DbPolicyStore(make_engine(url))

    store.set("u1", UserPolicy(per_txn_cap="5000.00", monthly_cap="1000.00",
                               merchant_allowlist=["BigBasket"]))

    got = store.get("u1")
    assert got is not None
    assert str(got.per_txn_cap) == "5000.00"
    assert str(got.monthly_cap) == "1000.00"
    assert got.merchant_allowlist == ["BigBasket"]


def test_unknown_user_returns_none(tmp_path):
    store = DbPolicyStore(make_engine(f"sqlite:///{tmp_path / 'aura.db'}"))
    assert store.get("nobody") is None


def test_persists_across_new_store_instance(tmp_path):
    # Simulate a restart: a fresh store on the same file must see the data.
    url = f"sqlite:///{tmp_path / 'aura.db'}"
    DbPolicyStore(make_engine(url)).set("u1", UserPolicy(monthly_cap="2500.00"))

    reopened = DbPolicyStore(make_engine(url))
    got = reopened.get("u1")
    assert got is not None
    assert str(got.monthly_cap) == "2500.00"


def test_set_updates_existing(tmp_path):
    url = f"sqlite:///{tmp_path / 'aura.db'}"
    store = DbPolicyStore(make_engine(url))
    store.set("u1", UserPolicy(per_txn_cap="1000.00"))
    store.set("u1", UserPolicy(per_txn_cap="9000.00"))
    assert str(store.get("u1").per_txn_cap) == "9000.00"


# --- Phase 6B: SQL audit log ----------------------------------------------

def _rec(rid, amount, user="u1", decision=Decision.ALLOW):
    return DecisionRecord(
        request_id=rid, user_id=user, amount_paise=amount, decision=decision,
        deterministic_result=EngineResult(decision=decision, reasons=["r"]),
        reasons=["r"], executed=(decision is Decision.ALLOW),
    )


def _seeded_log(tmp_path):
    log = SqlAuditLog(make_engine(f"sqlite:///{tmp_path / 'aura.db'}"))
    log.append(_rec("req_1", 10000))
    log.append(_rec("req_2", 20000))
    log.append(_rec("req_3", 30000, decision=Decision.BLOCK))
    return log


def test_sql_audit_chain_verifies(tmp_path):
    log = _seeded_log(tmp_path)
    valid, err = log.verify_chain()
    assert valid is True and err is None
    # Links populated correctly.
    entries = log.read_all()
    assert entries[0]["prev_hash"] == "0" * 64
    assert entries[1]["prev_hash"] == entries[0]["entry_hash"]


def test_sql_audit_persists_across_restart(tmp_path):
    url = f"sqlite:///{tmp_path / 'aura.db'}"
    SqlAuditLog(make_engine(url)).append(_rec("req_1", 10000))
    reopened = SqlAuditLog(make_engine(url))
    assert len(reopened.read_all()) == 1
    valid, _ = reopened.verify_chain()
    assert valid is True


def test_sql_audit_tamper_detected(tmp_path):
    url = f"sqlite:///{tmp_path / 'aura.db'}"
    log = _seeded_log(tmp_path)
    engine = make_engine(url)
    # Tamper: rewrite the amount inside a stored row's JSON.
    with engine.begin() as conn:
        row = conn.execute(
            select(audit_table.c.seq, audit_table.c.entry_json).order_by(audit_table.c.seq)
        ).first()
        d = json.loads(row.entry_json)
        d["amount_paise"] = 99999999
        conn.execute(
            audit_table.update().where(audit_table.c.seq == row.seq)
            .values(entry_json=json.dumps(d, sort_keys=True, separators=(",", ":")))
        )
    valid, err = SqlAuditLog(engine).verify_chain()
    assert valid is False
    assert "hash mismatch" in err


def test_sql_audit_spend_and_velocity(tmp_path):
    from datetime import datetime, timedelta, timezone
    log = _seeded_log(tmp_path)  # req_1 (10000) + req_2 (20000) executed; req_3 blocked
    since = datetime.now(timezone.utc) - timedelta(days=1)
    assert log.total_spent_paise("u1", since) == 30000
    assert log.txn_count("u1", since) == 2


# --- Phase 6C: pending step-ups -------------------------------------------

def _pending_req(rid="req_x"):
    r = AuthorizationRequest(
        agent_id="a1", user_id="u1", amount_rupees="750.00",
        merchant="MysteryMart", category="groceries", user_intent="snacks",
    )
    r.request_id = rid
    return r


def test_pending_put_pop_roundtrip(tmp_path):
    store = PendingStore(make_engine(f"sqlite:///{tmp_path / 'aura.db'}"))
    store.put(_pending_req("req_x"))
    got = store.pop("req_x")
    assert got is not None
    assert got.request_id == "req_x"
    assert got.amount_paise == 75000
    assert got.merchant == "MysteryMart"


def test_pending_pop_removes(tmp_path):
    store = PendingStore(make_engine(f"sqlite:///{tmp_path / 'aura.db'}"))
    store.put(_pending_req("req_x"))
    assert store.pop("req_x") is not None
    assert store.pop("req_x") is None  # gone after first pop


def test_pending_unknown_returns_none(tmp_path):
    store = PendingStore(make_engine(f"sqlite:///{tmp_path / 'aura.db'}"))
    assert store.pop("nope") is None


def test_pending_survives_restart(tmp_path):
    url = f"sqlite:///{tmp_path / 'aura.db'}"
    PendingStore(make_engine(url)).put(_pending_req("req_x"))
    # Fresh store on the same DB (simulated restart) still has it.
    reopened = PendingStore(make_engine(url))
    got = reopened.pop("req_x")
    assert got is not None and got.request_id == "req_x"
