"""Tamper-evident audit log — append-only, hash-chained.

Each entry stores `prev_hash` (the previous entry's hash) and
`entry_hash = sha256(canonical(entry_without_entry_hash))`. Any edit, insert, or
delete breaks the chain and is caught by `verify_chain()`.

This module is also the system's spend/velocity source of truth: daily/monthly
caps and velocity rules are computed by summing/counting *executed* entries for a
user within a time window.
"""
from __future__ import annotations

import hashlib
import json
import threading
from datetime import datetime
from pathlib import Path

from firewall.models import DecisionRecord

GENESIS_HASH = "0" * 64


def _canonical(obj: dict) -> str:
    """Deterministic JSON for hashing: sorted keys, tight separators, unicode kept."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _hash_entry(entry: dict) -> str:
    core = {k: v for k, v in entry.items() if k != "entry_hash"}
    return hashlib.sha256(_canonical(core).encode("utf-8")).hexdigest()


class AuditLog:
    def __init__(self, path: str | Path = "audit_log.jsonl") -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    # --- writing -------------------------------------------------------------

    def _last_hash(self) -> str:
        entries = self.read_all()
        if not entries:
            return GENESIS_HASH
        return entries[-1].get("entry_hash") or GENESIS_HASH

    def append(self, record: DecisionRecord) -> DecisionRecord:
        """Append one record, linking it into the hash chain. Mutates and
        returns the record with `prev_hash`/`entry_hash` set."""
        with self._lock:
            record.prev_hash = self._last_hash()
            record.entry_hash = None
            entry = record.model_dump(mode="json")
            record.entry_hash = _hash_entry(entry)
            entry["entry_hash"] = record.entry_hash
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(_canonical(entry) + "\n")
        return record

    # --- reading -------------------------------------------------------------

    def read_all(self) -> list[dict]:
        if not self.path.exists():
            return []
        with open(self.path, "r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    # --- integrity -----------------------------------------------------------

    def verify_chain(self) -> tuple[bool, str | None]:
        """Return (is_valid, error). Detects any edit/insert/delete by
        recomputing each entry hash and checking the prev_hash linkage."""
        prev = GENESIS_HASH
        for i, entry in enumerate(self.read_all()):
            expected = _hash_entry(entry)
            if entry.get("entry_hash") != expected:
                return False, f"entry {i} ({entry.get('request_id')}): content hash mismatch (tampered)"
            if entry.get("prev_hash") != prev:
                return False, f"entry {i} ({entry.get('request_id')}): broken chain link (insert/delete/reorder)"
            prev = entry["entry_hash"]
        return True, None

    # --- spend / velocity queries -------------------------------------------

    def total_spent_paise(self, user_id: str, since: datetime) -> int:
        """Sum of executed spend for a user at or after `since` (paise)."""
        total = 0
        for e in self.read_all():
            if e.get("user_id") == user_id and e.get("executed") and self._at_or_after(e, since):
                total += int(e.get("amount_paise", 0))
        return total

    def txn_count(self, user_id: str, since: datetime) -> int:
        """Count of executed transactions for a user at or after `since`."""
        count = 0
        for e in self.read_all():
            if e.get("user_id") == user_id and e.get("executed") and self._at_or_after(e, since):
                count += 1
        return count

    def mean_amount_paise(self, user_id: str) -> float | None:
        """Mean of a user's executed payment amounts (paise); None if no history.
        Used by the ML risk layer to personalize per user."""
        vals = [
            int(e.get("amount_paise", 0))
            for e in self.read_all()
            if e.get("user_id") == user_id and e.get("executed")
        ]
        return (sum(vals) / len(vals)) if vals else None

    @staticmethod
    def _at_or_after(entry: dict, since: datetime) -> bool:
        ts = entry.get("timestamp")
        if not ts:
            return False
        try:
            return datetime.fromisoformat(ts) >= since
        except ValueError:
            return False
