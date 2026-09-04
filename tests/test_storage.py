"""Phase 6A: policies persist in the database across 'restarts'."""
from firewall.models import UserPolicy
from firewall.storage import DbPolicyStore, make_engine


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
