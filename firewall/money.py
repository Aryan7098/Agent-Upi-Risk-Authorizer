"""Money conversion — the single source of truth for rupees <-> paise.

Rules (money-critical, keep simple and exact):
- Users speak **rupees** with up to 2 decimal places (e.g. "500.34").
- Internally and on the Razorpay rail, everything is an **integer number of
  paise** (₹500.34 = 50034 paise).
- Never use `float`. Parse via `Decimal(str(value))` so "500.34" is exact and
  never becomes 500.3399999...
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation

_PAISE = Decimal("0.01")


def to_decimal_rupees(value) -> Decimal:
    """Coerce any incoming amount (str / int / Decimal) to a Decimal via its
    string form, so float imprecision never enters the pipeline."""
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError(f"invalid money amount: {value!r}")


def rupees_to_paise(value) -> int:
    """Convert rupees to an exact integer number of paise.

    Rejects amounts with more than 2 decimal places. Does not enforce
    positivity — callers (Pydantic models) decide whether zero/negative is
    allowed in their context.
    """
    d = to_decimal_rupees(value)
    if d != d.quantize(_PAISE):
        raise ValueError(
            f"amount {d} has more than 2 decimal places (paise is the smallest unit)"
        )
    return int((d * 100).to_integral_value())


def paise_to_rupees(paise: int) -> Decimal:
    return (Decimal(int(paise)) / 100).quantize(_PAISE)


def format_rupees(paise: int) -> str:
    """Human-readable rupee string for reasons/logs, e.g. '₹500.34'."""
    return f"₹{paise_to_rupees(paise)}"
