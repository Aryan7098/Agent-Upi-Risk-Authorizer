"""Payment rail — Razorpay TEST MODE ONLY.

This is the only module that touches real Razorpay APIs. The confirmed-working
money action for this project is `client.order.create(...)`; we treat creating a
test-mode order as "executing the money action". The interface is deliberately
small so it can later extend to capture / RazorpayX test payouts without the
rest of the firewall caring how the rail works.

No real funds ever move — test keys only.
"""
from __future__ import annotations

from dataclasses import dataclass

import razorpay

from firewall.config import RazorpayConfig, get_razorpay_config


class RailError(RuntimeError):
    """Raised when the rail is misconfigured or the Razorpay call fails."""


@dataclass(frozen=True)
class OrderResult:
    """Outcome of executing the money action on the rail."""

    order_id: str
    amount: int          # paise
    currency: str
    status: str          # e.g. "created"
    raw: dict            # full Razorpay response, for the audit trail


class RazorpayRail:
    """Thin wrapper over the Razorpay SDK, test mode only.

    The SDK client is created lazily so the rest of the app (and `/health`)
    works even when keys are absent — money actions simply fail loudly if you
    try to execute one without configured test keys.
    """

    def __init__(self, config: RazorpayConfig | None = None) -> None:
        self._config = config or get_razorpay_config()
        self._client: razorpay.Client | None = None

    @property
    def is_configured(self) -> bool:
        return self._config.is_configured

    def _get_client(self) -> razorpay.Client:
        if not self._config.is_configured:
            raise RailError(
                "Razorpay test keys are not configured. Set RAZORPAY_KEY_ID and "
                "RAZORPAY_KEY_SECRET in .env (see .env.example)."
            )
        if self._client is None:
            self._client = razorpay.Client(
                auth=(self._config.key_id, self._config.key_secret)
            )
        return self._client

    def create_order(
        self,
        amount: int,
        currency: str = "INR",
        receipt: str | None = None,
        notes: dict | None = None,
    ) -> OrderResult:
        """Execute the money action: create a Razorpay test-mode order.

        `amount` is in paise (integer), per the project-wide convention.
        """
        if amount <= 0:
            raise RailError(f"amount must be a positive integer in paise, got {amount!r}")

        client = self._get_client()
        payload: dict = {"amount": int(amount), "currency": currency}
        if receipt is not None:
            payload["receipt"] = receipt
        if notes:
            payload["notes"] = notes

        try:
            resp = client.order.create(data=payload)
        except Exception as exc:  # razorpay raises various error types
            raise RailError(f"Razorpay order.create failed: {exc}") from exc

        return OrderResult(
            order_id=resp["id"],
            amount=resp["amount"],
            currency=resp["currency"],
            status=resp["status"],
            raw=resp,
        )
