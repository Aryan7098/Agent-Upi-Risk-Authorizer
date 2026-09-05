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
    ApiKeyStore,
    DbPolicyStore,
    IdempotencyStore,
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


def test_delete_user_reseals_and_keeps_chain_valid(tmp_path):
    url = f"sqlite:///{tmp_path / 'aura.db'}"
    log = SqlAuditLog(make_engine(url))
    log.append(_rec("a1", 10000, user="alice"))
    log.append(_rec("b1", 20000, user="bob"))
    log.append(_rec("a2", 30000, user="alice"))
    log.append(_rec("b2", 40000, user="bob"))

    removed = log.delete_user_and_reseal("alice")
    assert removed == 2

    remaining = log.read_all()
    assert [e["request_id"] for e in remaining] == ["b1", "b2"]
    # Chain is re-sealed: still verifies, and links are contiguous again.
    valid, err = log.verify_chain()
    assert valid is True and err is None
    assert remaining[0]["prev_hash"] == "0" * 64
    assert remaining[1]["prev_hash"] == remaining[0]["entry_hash"]


def test_policy_and_pending_delete(tmp_path):
    url = f"sqlite:///{tmp_path / 'aura.db'}"
    engine = make_engine(url)
    policies = DbPolicyStore(engine)
    policies.set("alice", UserPolicy(per_txn_cap="500.00"))
    assert policies.delete("alice") is True
    assert policies.get("alice") is None

    pending = PendingStore(engine)
    r = _pending_req("p1")
    r.user_id = "alice"
    pending.put(r)
    assert pending.delete_user("alice") == 1
    assert pending.list_all() == []


# --- API keys -------------------------------------------------------------

def test_api_key_create_returns_plaintext_once_and_resolves(tmp_path):
    store = ApiKeyStore(make_engine(f"sqlite:///{tmp_path / 'aura.db'}"))
    made = store.create("alice", "shopping agent")
    assert made["key"].startswith("aura_sk_test_")   # test-mode prefix
    assert made["prefix"] == made["key"][:16]
    # The presented plaintext resolves to its owner.
    assert store.resolve(made["key"]) == "alice"
    # resolve_meta exposes the key id too (for per-key rate limiting).
    meta = store.resolve_meta(made["key"])
    assert meta["user_id"] == "alice"
    assert meta["id"] == made["id"]
    # The listing never leaks the plaintext, only masked metadata.
    listed = store.list_for("alice")
    assert len(listed) == 1
    assert "key" not in listed[0]
    assert listed[0]["prefix"] == made["prefix"]
    # last_used_at is recorded on a successful resolve.
    assert listed[0]["last_used_at"] is not None


def test_api_key_only_hash_is_stored(tmp_path):
    from firewall.storage import api_keys_table
    engine = make_engine(f"sqlite:///{tmp_path / 'aura.db'}")
    store = ApiKeyStore(engine)
    made = store.create("alice")
    with engine.connect() as conn:
        row = conn.execute(select(api_keys_table.c.key_hash)).first()
    # The raw key must not be recoverable from the database.
    assert row[0] != made["key"]
    assert len(row[0]) == 64  # sha256 hex


def test_api_key_unknown_and_revoked_do_not_resolve(tmp_path):
    store = ApiKeyStore(make_engine(f"sqlite:///{tmp_path / 'aura.db'}"))
    made = store.create("alice")
    assert store.resolve("aura_sk_not_a_real_key") is None
    # Revoke scoped to owner: bob cannot revoke alice's key.
    assert store.delete(made["id"], "bob") is False
    assert store.resolve(made["key"]) == "alice"
    assert store.delete(made["id"], "alice") is True
    assert store.resolve(made["key"]) is None


def test_api_key_delete_user(tmp_path):
    store = ApiKeyStore(make_engine(f"sqlite:///{tmp_path / 'aura.db'}"))
    store.create("alice")
    store.create("alice")
    store.create("bob")
    assert store.delete_user("alice") == 2
    assert store.list_for("alice") == []
    assert len(store.list_for("bob")) == 1


# --- Idempotency ----------------------------------------------------------

def test_idempotency_first_write_wins_and_scopes_per_user(tmp_path):
    store = IdempotencyStore(make_engine(f"sqlite:///{tmp_path / 'aura.db'}"))
    assert store.get("alice", "k1") is None

    store.put("alice", "k1", {"decision": "ALLOW", "request_id": "req_1"})
    # A repeat with the same key replays the original; a later put never overwrites.
    store.put("alice", "k1", {"decision": "BLOCK", "request_id": "req_2"})
    assert store.get("alice", "k1")["request_id"] == "req_1"

    # Same key string, different user -> independent record.
    assert store.get("bob", "k1") is None
    store.put("bob", "k1", {"decision": "STEP_UP", "request_id": "req_3"})
    assert store.get("bob", "k1")["request_id"] == "req_3"

    assert store.delete_user("alice") == 1
    assert store.get("alice", "k1") is None
    assert store.get("bob", "k1") is not None


def test_idempotency_scope_is_nul_free_and_collision_safe():
    # The scope is a DB primary key: it must never contain a NUL byte (Postgres
    # text columns reject 0x00) and must uniquely separate (user_id, key) pairs
    # even when either value contains the ':' separator character.
    scope = IdempotencyStore._scope
    assert "\x00" not in scope("alice", "k1")
    # Ambiguous-looking pairs must still produce distinct scopes.
    assert scope("a", "b:c") != scope("a:b", "c")
    assert scope("1:x", "y") != scope("1", "x:y")


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
