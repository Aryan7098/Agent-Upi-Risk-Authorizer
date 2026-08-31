"""Central configuration and secret loading.

Secrets come from a git-ignored `.env` file (see `.env.example`). Nothing in
here ever prints a full secret.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# Load .env once, at import time. Values already in the real environment win.
load_dotenv(override=False)


@dataclass(frozen=True)
class RazorpayConfig:
    key_id: str | None
    key_secret: str | None

    @property
    def is_configured(self) -> bool:
        return bool(self.key_id and self.key_secret)


def get_razorpay_config() -> RazorpayConfig:
    return RazorpayConfig(
        key_id=os.getenv("RAZORPAY_KEY_ID"),
        key_secret=os.getenv("RAZORPAY_KEY_SECRET"),
    )


def masked(secret: str | None) -> str:
    """Render a secret safely for logs: keep a short prefix, hide the rest."""
    if not secret:
        return "<unset>"
    if len(secret) <= 8:
        return "****"
    return f"{secret[:6]}…{'*' * 4}"
