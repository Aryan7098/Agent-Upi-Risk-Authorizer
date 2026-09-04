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
    MetaData,
    String,
    Table,
    Text,
    create_engine,
    select,
)
from sqlalchemy.engine import Engine

from firewall.models import UserPolicy

metadata = MetaData()

policies_table = Table(
    "policies",
    metadata,
    Column("user_id", String, primary_key=True),
    Column("policy_json", Text, nullable=False),
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
