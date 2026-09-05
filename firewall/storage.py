"""Persistence layer.

Local dev runs on a zero-config SQLite file; production points `DATABASE_URL` at
Postgres (e.g. Neon/Supabase) with no code change. Everything is kept behind
small store classes so the rest of the app doesn't know which database is used.

Phase 6A: the policy store. The audit log (6B) and pending step-ups (6C) get
their own tables in the same database.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
from datetime import datetime, timezone

from sqlalchemy import (
    Column,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    create_engine,
    select,
)
from sqlalchemy.engine import Engine

from firewall.audit import _AuditBase, _canonical
from firewall.models import AuthorizationRequest, UserPolicy

metadata = MetaData()

policies_table = Table(
    "policies",
    metadata,
    Column("user_id", String, primary_key=True),
    Column("policy_json", Text, nullable=False),
)

# Audit entries. `seq` gives append order; `entry_json` holds the full canonical
# record (the same bytes the file backend writes) so hashing/verification are
# identical. The flat columns exist for fast indexed spend/velocity lookups.
audit_table = Table(
    "audit_entries",
    metadata,
    Column("seq", Integer, primary_key=True, autoincrement=True),
    Column("request_id", String),
    Column("user_id", String, index=True),
    Column("executed", Integer),  # 0 / 1
    Column("amount_paise", Integer),
    Column("timestamp", String, index=True),
    Column("entry_hash", String),
    Column("prev_hash", String),
    Column("entry_json", Text, nullable=False),
)

# API keys let a real agent authenticate to POST /authorize as its owner. Only a
# SHA-256 hash of the key is stored — the plaintext key is shown once at creation
# and never persisted, so a leaked database cannot be used to call the firewall.
api_keys_table = Table(
    "api_keys",
    metadata,
    Column("id", String, primary_key=True),
    Column("user_id", String, index=True),
    Column("name", String),
    Column("prefix", String),        # first chars, safe to display (aura_sk_ab12…)
    Column("key_hash", String, index=True),
    Column("created_at", String),
    Column("last_used_at", String),
)

# Payments held awaiting human step-up confirmation. Persisted so a held payment
# survives a restart and can still be confirmed later.
pending_table = Table(
    "pending_step_ups",
    metadata,
    Column("request_id", String, primary_key=True),
    Column("request_json", Text, nullable=False),
    Column("created_at", String),
)

# Idempotency records: a client that retries /authorize with the same
# Idempotency-Key gets back the ORIGINAL verdict instead of a second screening —
# so a network retry can never execute the same payment twice. Scoped per user so
# two accounts can reuse the same key string without colliding.
idempotency_table = Table(
    "idempotency",
    metadata,
    Column("scope", String, primary_key=True),   # f"{user_id}\x00{idempotency_key}"
    Column("user_id", String, index=True),
    Column("response_json", Text, nullable=False),
    Column("created_at", String),
)


def make_engine(url: str | None = None) -> Engine:
    """Create a SQLAlchemy engine. Defaults to a local SQLite file; override with
    DATABASE_URL. Managed hosts (Render/Neon/Heroku) hand out `postgres://` or
    `postgresql://` URLs — normalize both to the psycopg (v3) driver."""
    url = url or os.getenv("DATABASE_URL", "sqlite:///./aura.db")
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    return create_engine(url, connect_args=connect_args, future=True)


def init_db(engine: Engine) -> None:
    """Create all tables if they don't exist."""
    metadata.create_all(engine)


class DbPolicyStore:
    """Per-user policies persisted as JSON. Survives restarts."""

    def __init__(self, engine: Engine):
        self.engine = engine
        init_db(engine)

    def get(self, user_id: str) -> UserPolicy | None:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(policies_table.c.policy_json).where(
                    policies_table.c.user_id == user_id
                )
            ).first()
        if row is None:
            return None
        return UserPolicy(**json.loads(row[0]))

    def set(self, user_id: str, policy: UserPolicy) -> None:
        payload = json.dumps(policy.model_dump(mode="json"))
        with self.engine.begin() as conn:
            exists = conn.execute(
                select(policies_table.c.user_id).where(
                    policies_table.c.user_id == user_id
                )
            ).first()
            if exists:
                conn.execute(
                    policies_table.update()
                    .where(policies_table.c.user_id == user_id)
                    .values(policy_json=payload)
                )
            else:
                conn.execute(
                    policies_table.insert().values(user_id=user_id, policy_json=payload)
                )

    def delete(self, user_id: str) -> bool:
        """Remove a user's policy (reverts them to the default). Returns True if
        a row was deleted."""
        with self.engine.begin() as conn:
            result = conn.execute(
                policies_table.delete().where(policies_table.c.user_id == user_id)
            )
        return bool(result.rowcount)


class SqlAuditLog(_AuditBase):
    """Database-backed audit log. Same hash chain + queries as the file backend;
    only storage differs. Reads entries in append order (`seq`)."""

    def __init__(self, engine: Engine):
        super().__init__()
        self.engine = engine
        init_db(engine)

    def _read_raw(self) -> list[dict]:
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(audit_table.c.entry_json).order_by(audit_table.c.seq)
            ).all()
        return [json.loads(r[0]) for r in rows]

    def _write_entry(self, entry: dict) -> None:
        with self.engine.begin() as conn:
            conn.execute(self._insert_values(entry))

    def _replace_all(self, entries: list[dict]) -> None:
        with self.engine.begin() as conn:
            conn.execute(audit_table.delete())
            for entry in entries:
                conn.execute(self._insert_values(entry))

    @staticmethod
    def _insert_values(entry: dict):
        return audit_table.insert().values(
            request_id=entry.get("request_id"),
            user_id=entry.get("user_id"),
            executed=1 if entry.get("executed") else 0,
            amount_paise=int(entry.get("amount_paise", 0)),
            timestamp=entry.get("timestamp"),
            entry_hash=entry.get("entry_hash"),
            prev_hash=entry.get("prev_hash"),
            entry_json=_canonical(entry),
        )


class PendingStore:
    """Held step-up payments, persisted so they survive a restart."""

    def __init__(self, engine: Engine):
        self.engine = engine
        init_db(engine)

    def put(self, request: AuthorizationRequest) -> None:
        payload = json.dumps(request.model_dump(mode="json"))
        with self.engine.begin() as conn:
            conn.execute(
                pending_table.delete().where(
                    pending_table.c.request_id == request.request_id
                )
            )
            conn.execute(
                pending_table.insert().values(
                    request_id=request.request_id,
                    request_json=payload,
                    created_at=request.timestamp,
                )
            )

    def pop(self, request_id: str) -> AuthorizationRequest | None:
        """Return and remove the held request, or None if not found."""
        with self.engine.begin() as conn:
            row = conn.execute(
                select(pending_table.c.request_json).where(
                    pending_table.c.request_id == request_id
                )
            ).first()
            if row is None:
                return None
            conn.execute(
                pending_table.delete().where(pending_table.c.request_id == request_id)
            )
        return AuthorizationRequest(**json.loads(row[0]))

    def list_all(self) -> list[AuthorizationRequest]:
        """All currently-held requests (most recent first)."""
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(pending_table.c.request_json).order_by(
                    pending_table.c.created_at.desc()
                )
            ).all()
        return [AuthorizationRequest(**json.loads(r[0])) for r in rows]

    def delete_user(self, user_id: str) -> int:
        """Drop all held step-ups belonging to a user. Returns how many."""
        removed = 0
        with self.engine.begin() as conn:
            rows = conn.execute(
                select(pending_table.c.request_id, pending_table.c.request_json)
            ).all()
            for request_id, request_json in rows:
                try:
                    if json.loads(request_json).get("user_id") == user_id:
                        conn.execute(
                            pending_table.delete().where(
                                pending_table.c.request_id == request_id
                            )
                        )
                        removed += 1
                except (ValueError, TypeError):
                    continue
        return removed


# Plaintext keys look like: aura_sk_test_<43 url-safe chars>. The `test_` segment
# mirrors how Stripe/Razorpay name test-mode keys — this integration is test mode
# only. The prefix shown in the UI is the first 16 characters (the label plus a
# few random chars), enough to recognize a key without exposing it.
KEY_PREFIX = "aura_sk_test_"
PREFIX_DISPLAY_LEN = 16


def _hash_key(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


class ApiKeyStore:
    """Per-user API keys for authenticating an external agent to /authorize.

    Security model: the plaintext key is generated here, returned once, and never
    stored — only its SHA-256 hash is. Lookups hash the presented key and match on
    the hash, so the database never holds anything that can call the firewall."""

    def __init__(self, engine: Engine):
        self.engine = engine
        init_db(engine)

    def create(self, user_id: str, name: str = "") -> dict:
        """Mint a new key for a user. Returns a dict that INCLUDES the one-time
        plaintext `key` — surface it to the user immediately, then forget it."""
        plaintext = KEY_PREFIX + secrets.token_urlsafe(32)
        key_id = "key_" + secrets.token_hex(8)
        created = datetime.now(timezone.utc).isoformat()
        prefix = plaintext[:PREFIX_DISPLAY_LEN]
        with self.engine.begin() as conn:
            conn.execute(
                api_keys_table.insert().values(
                    id=key_id,
                    user_id=user_id,
                    name=(name or "").strip()[:60],
                    prefix=prefix,
                    key_hash=_hash_key(plaintext),
                    created_at=created,
                    last_used_at=None,
                )
            )
        return {
            "id": key_id,
            "name": (name or "").strip()[:60],
            "prefix": prefix,
            "created_at": created,
            "last_used_at": None,
            "key": plaintext,  # one-time only
        }

    def list_for(self, user_id: str) -> list[dict]:
        """Masked metadata for a user's keys (never the key itself), newest first."""
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(
                    api_keys_table.c.id,
                    api_keys_table.c.name,
                    api_keys_table.c.prefix,
                    api_keys_table.c.created_at,
                    api_keys_table.c.last_used_at,
                )
                .where(api_keys_table.c.user_id == user_id)
                .order_by(api_keys_table.c.created_at.desc())
            ).all()
        return [
            {"id": r[0], "name": r[1], "prefix": r[2],
             "created_at": r[3], "last_used_at": r[4]}
            for r in rows
        ]

    def resolve_meta(self, plaintext: str) -> dict | None:
        """Return {"id", "user_id"} for a presented key, or None if unknown.
        Records last-used on a hit so keys show recent activity. Returning the
        key id (not just the owner) lets callers rate-limit per individual key."""
        if not plaintext:
            return None
        key_hash = _hash_key(plaintext.strip())
        with self.engine.begin() as conn:
            row = conn.execute(
                select(api_keys_table.c.id, api_keys_table.c.user_id).where(
                    api_keys_table.c.key_hash == key_hash
                )
            ).first()
            if row is None:
                return None
            conn.execute(
                api_keys_table.update()
                .where(api_keys_table.c.id == row[0])
                .values(last_used_at=datetime.now(timezone.utc).isoformat())
            )
        return {"id": row[0], "user_id": row[1]}

    def resolve(self, plaintext: str) -> str | None:
        """Return just the owning user_id for a presented key, or None."""
        meta = self.resolve_meta(plaintext)
        return meta["user_id"] if meta else None

    def delete(self, key_id: str, user_id: str) -> bool:
        """Revoke a key. Scoped to its owner so one user cannot revoke another's."""
        with self.engine.begin() as conn:
            result = conn.execute(
                api_keys_table.delete().where(
                    (api_keys_table.c.id == key_id)
                    & (api_keys_table.c.user_id == user_id)
                )
            )
        return bool(result.rowcount)

    def delete_user(self, user_id: str) -> int:
        """Revoke every key a user holds (used by data erasure). Returns count."""
        with self.engine.begin() as conn:
            result = conn.execute(
                api_keys_table.delete().where(api_keys_table.c.user_id == user_id)
            )
        return int(result.rowcount or 0)


class IdempotencyStore:
    """Remembers the response to an idempotent /authorize call so a retry with the
    same Idempotency-Key returns the ORIGINAL verdict without screening (or
    executing) the payment again. Persisted, so it survives a restart."""

    def __init__(self, engine: Engine):
        self.engine = engine
        init_db(engine)

    @staticmethod
    def _scope(user_id: str, key: str) -> str:
        # Length-prefix the user id so no (user_id, key) pair can collide with
        # another, and use a printable separator — Postgres text columns reject
        # NUL (0x00) bytes, which would 500 on insert. The client key is capped.
        uid = user_id or ""
        return f"{len(uid)}:{uid}:{key[:200]}"

    def get(self, user_id: str, key: str) -> dict | None:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(idempotency_table.c.response_json).where(
                    idempotency_table.c.scope == self._scope(user_id, key)
                )
            ).first()
        return json.loads(row[0]) if row else None

    def put(self, user_id: str, key: str, response: dict) -> None:
        scope = self._scope(user_id, key)
        payload = json.dumps(response)
        created = datetime.now(timezone.utc).isoformat()
        with self.engine.begin() as conn:
            exists = conn.execute(
                select(idempotency_table.c.scope).where(
                    idempotency_table.c.scope == scope
                )
            ).first()
            if exists:
                return  # first write wins; never overwrite a recorded response
            conn.execute(
                idempotency_table.insert().values(
                    scope=scope, user_id=user_id,
                    response_json=payload, created_at=created,
                )
            )

    def delete_user(self, user_id: str) -> int:
        with self.engine.begin() as conn:
            result = conn.execute(
                idempotency_table.delete().where(
                    idempotency_table.c.user_id == user_id
                )
            )
        return int(result.rowcount or 0)
