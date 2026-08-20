"""api/store.py — store in-memory condiviso dei run + code eventi.

MAI stato solo nel task asyncio: il layer API e il Gauntlet leggono/scrivono
lo stesso store. Le code eventi servono il progress live (polling UI).
"""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field


class _SyncPayload(dict):
    """dict che propaga ogni mutazione (update/setitem) allo stato del Run."""

    def __init__(self, run: "Run"):
        super().__init__()
        self._run = run

    def __setitem__(self, key, value):  # noqa: D105
        super().__setitem__(key, value)
        self._run._sync()

    def update(self, *args, **kwargs):  # noqa: D102
        super().update(*args, **kwargs)
        self._run._sync()


@dataclass
class Run:
    id: str
    goal: str
    bar: str
    tier: int
    max_rounds: int
    estimate_tokens: int = 0
    status: str = "pending_confirmation"
    created_at: float = field(default_factory=time.time)
    events: list = field(default_factory=list)          # log progress per round
    approval_event: asyncio.Event = field(default_factory=asyncio.Event)
    stop_event: asyncio.Event = field(default_factory=asyncio.Event)
    last_update: dict = field(default_factory=dict)      # ultimo risultato round
    result: dict | None = None
    exception: str | None = None
    # payload scritto dal Gauntlet (status_store) — auto-sincronizzato
    _payload: dict = field(default_factory=dict, init=False)

    def __post_init__(self):
        self._payload = _SyncPayload(self)

    @property
    def payload(self) -> dict:
        return self._payload

    def _sync(self) -> None:
        p = self._payload
        if p.get("status"):
            self.status = p["status"]
        if p.get("last_update"):
            payload = p["last_update"]
            self.last_update = payload
            if payload and isinstance(payload, dict) and "bar_beaten" in payload:
                self.result = payload
        self.events.append({"t": time.time(), "status": self.status})

    def snapshot(self) -> dict:
        events = self.events[-50:]  # ultimi 50 eventi per il polling
        return {
            "id": self.id,
            "goal": self.goal,
            "bar": self.bar,
            "tier": self.tier,
            "max_rounds": self.max_rounds,
            "status": self.status,
            "estimate_tokens": self.estimate_tokens,
            "created_at": self.created_at,
            "last_update": self.last_update,
            "result": self.result,
            "exception": self.exception,
            "events": events,
            "tokens_used": self.result.get("tokens_used", 0) if self.result else 0,
        }


class StoreAdapter(dict):
    """dict passato al Gauntlet come status_store: mappa run_id -> payload run."""

    def __init__(self, run: Run, run_store: "RunStore"):
        super().__init__()
        self._run = run
        self._run_store = run_store
        self[run.id] = run.payload

    def setdefault(self, key, default=None):
        return self[key]


class RunStore:
    """Store condiviso: run per id + lock per la scrittura dello stato."""

    def __init__(self):
        self._runs: dict[str, Run] = {}

    def create(self, goal: str, bar: str, max_rounds: int, estimate_tokens: int, tier: int) -> Run:
        run = Run(
            id=uuid.uuid4().hex[:12],
            goal=goal,
            bar=bar,
            tier=tier,
            max_rounds=max_rounds,
            estimate_tokens=estimate_tokens,
        )
        self._runs[run.id] = run
        return run

    def get(self, run_id: str) -> Run | None:
        return self._runs.get(run_id)

    def all(self) -> list[Run]:
        return list(self._runs.values())

    def adapter_for(self, run: Run) -> StoreAdapter:
        return StoreAdapter(run, self)

    def push_event(self, run_id: str, event: dict) -> None:
        run = self._runs.get(run_id)
        if run:
            run.events.append(event)

    async def set_status(self, run_id: str, status: str, last_update: dict | None = None) -> None:
        run = self._runs.get(run_id)
        if not run:
            return
        run.status = status
        if last_update is not None:
            run.last_update = last_update
            run.result = last_update
        run.events.append({"t": time.time(), "status": status, "detail": last_update})


# store globale condiviso tra layer API e gauntlet
store = RunStore()
