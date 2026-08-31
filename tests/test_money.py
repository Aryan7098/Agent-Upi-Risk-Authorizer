"""Money conversion unit tests — exactness and float-safety."""
import pytest

from firewall.money import format_rupees, paise_to_rupees, rupees_to_paise


def test_basic_conversion():
    assert rupees_to_paise("500.34") == 50034
    assert rupees_to_paise("500") == 50000
    assert rupees_to_paise("0.01") == 1
    assert rupees_to_paise("2000.00") == 200000


def test_clean_float_literal_stays_exact():
    # A literal float 500.34 has repr "500.34", so it converts exactly to 50034.
    assert rupees_to_paise(500.34) == 50034


def test_dirty_arithmetic_float_is_rejected_not_rounded():
    # 0.10 + 0.20 == 0.30000000000000004 in float. We REFUSE it rather than
    # silently rounding money. (This is why the API contract takes strings.)
    with pytest.raises(ValueError):
        rupees_to_paise(0.10 + 0.20)


def test_more_than_two_decimals_rejected():
    with pytest.raises(ValueError):
        rupees_to_paise("500.345")


def test_junk_rejected():
    with pytest.raises(ValueError):
        rupees_to_paise("not-money")


def test_round_trip():
    assert paise_to_rupees(50034) == __import__("decimal").Decimal("500.34")
    assert format_rupees(50034) == "₹500.34"
    assert format_rupees(200000) == "₹2000.00"
