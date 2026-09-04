"""Persistence layer.

Local dev runs on a zero-config SQLite file; production points `DATABASE_URL` at
Postgres (e.g. Neon/Supabase) with no code change. Everything is kept behind
small store classes so the rest of the app doesn't know which database is used.

Phase 6A: the policy store. The audit log (6B) and pending step-ups (6C) get
their own tables in the same database.
"""
from __future__ import annotations

import json
import os

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

# Payments held awaiting human step-up confirmation. Persisted so a held payment
# survives a restart and can still be confirmed later.
pending_table = Table(
    "pending_step_ups",
    metadata,
    Column("request_id", String, primary_key=True),
    Column("request_json", Text, nullable=False),
    Column("created_at", String),
)


def make_engine(url: str | None = None) -> Engine:
    """Create a SQLAlchemy engine. Defaults to a local SQLite file; override with
    DATABASE_URL (e.g. postgresql+psycopg://... in production)."""
    url = url or os.getenv("DATABASE_URL", "sqlite:///./aura.db")
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
            conn.execute(
                audit_table.insert().values(
                    request_id=entry.get("request_id"),
                    user_id=entry.get("user_id"),
                    executed=1 if entry.get("executed") else 0,
                    amount_paise=int(entry.get("amount_paise", 0)),
                    timestamp=entry.get("timestamp"),
                    entry_hash=entry.get("entry_hash"),
                    prev_hash=entry.get("prev_hash"),
                    entry_json=_canonical(entry),
                )
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
