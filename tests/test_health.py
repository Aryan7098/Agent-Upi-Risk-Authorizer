"""Phase 0 checkpoint tests: the server comes up and /health responds."""
from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app)


def test_health_ok():
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    # Field is present regardless of whether keys are configured.
    assert "razorpay_configured" in body


def test_rail_requires_keys_to_execute():
    """Rail must fail loudly (never silently) when keys are absent."""
    from firewall.rail import RazorpayRail, RailError
    from firewall.config import RazorpayConfig

    unconfigured = RazorpayRail(RazorpayConfig(key_id=None, key_secret=None))
    assert unconfigured.is_configured is False
    try:
        unconfigured.create_order(amount=50000)
        assert False, "expected RailError when keys are missing"
    except RailError:
        pass
