"""Phase 2 checkpoint tests: a request flows agent -> firewall -> decision ->
audit log -> rail, for both an ALLOW and a BLOCK case.

The rail is mocked so tests never hit live Razorpay; a separate live-rail proof
was done manually in Phase 0/1.
"""
import json

import pytest
from fastapi.testclient import TestClient

import api.main as main
from firewall.models import Decision
from firewall.rail import OrderResult, RailError
from firewall.storage import DbPolicyStore, PendingStore, SqlAuditLog, make_engine


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Isolate audit log + per-user policy + pending step-ups in one temp database.
    eng = make_engine(f"sqlite:///{tmp_path / 'aura_test.db'}")
    monkeypatch.setattr(main, "audit", SqlAuditLog(eng))
    monkeypatch.setattr(main, "policy_store", DbPolicyStore(eng))
    monkeypatch.setattr(main, "pending_store", PendingStore(eng))
    # These tests focus on rules/step-up, not ML or the LLM; disable both so they
    # stay deterministic and never hit the network. Those layers have their own
    # dedicated tests.
    monkeypatch.setattr(main, "risk_model", None)
    monkeypatch.setattr(main, "judge", None)
    return TestClient(main.app)


def _fake_order(**kwargs):
    return OrderResult(
        order_id="order_TEST123",
        amount=kwargs.get("amount", 0),
        currency=kwargs.get("currency", "INR"),
        status="created",
        raw={},
    )


def _base_request(amount_rupees: str) -> dict:
    return {
        "agent_id": "agent_1",
        "user_id": "user_1",
        "amount_rupees": amount_rupees,
        "merchant": "BigBasket",
        "category": "groceries",
        "user_intent": "buy groceries under 2000",
        "agent_reason": "weekly grocery order",
    }


def test_allow_under_cap_executes_rail(client, monkeypatch):
    calls = {}

    def fake_create_order(**kwargs):
        calls.update(kwargs)
        return _fake_order(**kwargs)

    monkeypatch.setattr(main.rail, "create_order", fake_create_order)

    # Default per_txn_cap is ₹2000; ₹500.34 is under it -> ALLOW.
    resp = client.post("/authorize", json=_base_request("500.34"))
    assert resp.status_code == 200
    body = resp.json()
    assert body["decision"] == Decision.ALLOW.value
    assert body["executed"] is True
    assert body["order_id"] == "order_TEST123"
    assert body["amount_rupees"] == "500.34"
    # Rail was called with the exact integer paise (no float error).
    assert calls["amount"] == 50034

    # Audit entry was written.
    entries = main.audit.read_all()
    assert len(entries) == 1
    assert entries[0]["decision"] == "ALLOW"
    assert entries[0]["order_id"] == "order_TEST123"


def test_block_over_cap_does_not_touch_rail(client, monkeypatch):
    def must_not_call(**kwargs):
        raise AssertionError("rail must NOT be called on a BLOCK")

    monkeypatch.setattr(main.rail, "create_order", must_not_call)

    # ₹5000 > default cap ₹2000 -> BLOCK.
    resp = client.post("/authorize", json=_base_request("5000.00"))
    assert resp.status_code == 200
    body = resp.json()
    assert body["decision"] == Decision.BLOCK.value
    assert body["executed"] is False
    assert body["order_id"] is None
    assert any("exceeds per-transaction cap" in r for r in body["reasons"])

    entries = main.audit.read_all()
    assert len(entries) == 1
    assert entries[0]["decision"] == "BLOCK"


def test_negative_amount_rejected_by_validation(client):
    resp = client.post("/authorize", json=_base_request("-100.00"))
    assert resp.status_code == 422  # must be > 0


def test_too_many_decimal_places_rejected(client):
    # ₹500.345 is finer than paise -> rejected, never silently rounded.
    resp = client.post("/authorize", json=_base_request("500.345"))
    assert resp.status_code == 422


def test_rail_failure_is_recorded_not_silently_allowed(client, monkeypatch):
    def failing_order(**kwargs):
        raise RailError("simulated rail outage")

    monkeypatch.setattr(main.rail, "create_order", failing_order)

    resp = client.post("/authorize", json=_base_request("500.00"))
    assert resp.status_code == 200
    body = resp.json()
    # Decision was ALLOW, but execution failed and is recorded honestly.
    assert body["decision"] == "ALLOW"
    assert body["executed"] is False
    assert "simulated rail outage" in body["execution_error"]


def test_step_up_holds_then_confirm_executes(client, monkeypatch):
    orders = []

    def fake_create_order(**kwargs):
        orders.append(kwargs)
        return _fake_order(**kwargs)

    monkeypatch.setattr(main.rail, "create_order", fake_create_order)

    # Configure a merchant allowlist so an unknown merchant -> STEP_UP.
    client.put("/policy/user_1", json={"merchant_allowlist": ["BigBasket"]})

    req = _base_request("500.00")
    req["merchant"] = "UnknownShop"
    resp = client.post("/authorize", json=req)
    body = resp.json()
    assert body["decision"] == "STEP_UP"
    assert body["executed"] is False
    assert orders == []  # not executed while pending

    # Human confirms -> executes now.
    rid = body["request_id"]
    confirm = client.post(f"/confirm/{rid}").json()
    assert confirm["executed"] is True
    assert confirm["order_id"] == "order_TEST123"
    assert len(orders) == 1

    # Confirming again -> 404 (already resolved).
    assert client.post(f"/confirm/{rid}").status_code == 404


def test_confirm_with_remember_auto_allows_next_time(client, monkeypatch):
    monkeypatch.setattr(main.rail, "create_order", lambda **k: _fake_order(**k))

    # Allowlist set so an unknown merchant -> STEP_UP.
    client.put("/policy/user_1", json={"merchant_allowlist": ["BigBasket"]})

    req = _base_request("500.00")
    req["merchant"] = "MysteryMart"

    # 1st time: step-up.
    first = client.post("/authorize", json=req).json()
    assert first["decision"] == "STEP_UP"

    # Confirm AND remember the merchant.
    confirm = client.post(f"/confirm/{first['request_id']}?remember=true").json()
    assert confirm["executed"] is True
    assert any("added to your allowlist" in r for r in confirm["reasons"])

    # 2nd time to the same merchant: now auto-allowed, no step-up.
    second = client.post("/authorize", json=req).json()
    assert second["decision"] == "ALLOW"
    assert second["executed"] is True

    # And the merchant is on the user's stored allowlist.
    pol = client.get("/policy/user_1").json()["policy"]
    assert "MysteryMart" in pol["merchant_allowlist"]


def test_confirm_without_remember_still_asks_next_time(client, monkeypatch):
    monkeypatch.setattr(main.rail, "create_order", lambda **k: _fake_order(**k))
    client.put("/policy/user_1", json={"merchant_allowlist": ["BigBasket"]})

    req = _base_request("500.00")
    req["merchant"] = "MysteryMart"

    first = client.post("/authorize", json=req).json()
    assert first["decision"] == "STEP_UP"
    client.post(f"/confirm/{first['request_id']}")  # no remember

    # Still not remembered -> asks again.
    second = client.post("/authorize", json=req).json()
    assert second["decision"] == "STEP_UP"


def test_policy_endpoint_enforces_monthly_cap(client, monkeypatch):
    def must_not_call(**kwargs):
        raise AssertionError("rail must NOT be called when monthly cap blocks")

    # User sets their own monthly cap of ₹1000.
    put = client.put("/policy/user_1", json={"per_txn_cap": "5000.00", "monthly_cap": "1000.00"})
    assert put.status_code == 200
    assert put.json()["policy"]["monthly_cap"] == "1000.00"

    # First spend ₹800 (under cap) executes.
    monkeypatch.setattr(main.rail, "create_order",
                        lambda **k: _fake_order(**k))
    first = client.post("/authorize", json=_base_request("800.00")).json()
    assert first["decision"] == "ALLOW" and first["executed"] is True

    # Next ₹300 would push total to ₹1100 > ₹1000 -> BLOCK, rail untouched.
    monkeypatch.setattr(main.rail, "create_order", must_not_call)
    second = client.post("/authorize", json=_base_request("300.00")).json()
    assert second["decision"] == "BLOCK"
    assert any("monthly cap" in r for r in second["reasons"])


def test_audit_verify_endpoint(client, monkeypatch):
    monkeypatch.setattr(main.rail, "create_order", lambda **k: _fake_order(**k))
    client.post("/authorize", json=_base_request("500.00"))
    client.post("/authorize", json=_base_request("600.00"))
    v = client.get("/audit/verify").json()
    assert v["valid"] is True
    assert v["entries"] == 2


def test_audit_recent_endpoint(client, monkeypatch):
    monkeypatch.setattr(main.rail, "create_order", lambda **k: _fake_order(**k))
    client.post("/authorize", json=_base_request("500.00"))
    client.post("/authorize", json=_base_request("5000.00"))  # BLOCK (over cap)
    data = client.get("/audit/recent?limit=10").json()
    assert data["count"] == 2
    # Most recent first: the BLOCK is newest.
    assert data["decisions"][0]["decision"] == "BLOCK"
    assert "reasons" in data["decisions"][0]


def test_pending_endpoint_lists_held(client, monkeypatch):
    monkeypatch.setattr(main.rail, "create_order", lambda **k: _fake_order(**k))
    client.put("/policy/user_1", json={"merchant_allowlist": ["BigBasket"]})
    req = _base_request("500.00")
    req["merchant"] = "MysteryMart"
    client.post("/authorize", json=req)  # -> STEP_UP, held
    data = client.get("/pending").json()
    assert data["count"] == 1
    assert data["pending"][0]["merchant"] == "MysteryMart"
