"""harness/run_state.py — registro di stato delle run (v0.16).

Stati: pending | running | paused | cancelled | completed | partial | failed
Registrazione cooperativa: l'orchestratore registra la run prima dello scatter
e il registry espone un asyncio.Event di cancellazione consultabile dal loop.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Dict, Optional


@dataclass
class RunState:
    status: str = "pending"
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    pause_event: asyncio.Event = field(default_factory=asyncio.Event)

    def __post_init__(self) -> None:
        self.pause_event.set()  # non in pausa di default


class RunRegistry:
    """Registro in-memory delle run attive, per progetto."""

    def __init__(self) -> None:
        self._runs: Dict[str, Dict[str, RunState]] = {}

    def register(self, pid: str, run_id: str) -> RunState:
        st = RunState(status="running")
        self._runs.setdefault(pid, {})[run_id] = st
        return st

    def cancel(self, pid: str, run_id: str) -> bool:
        st = self._runs.get(pid, {}).get(run_id)
        if st is None:
            return False
        st.status = "cancelled"
        st.cancel_event.set()
        return True

    def pause(self, pid: str, run_id: str) -> bool:
        st = self._runs.get(pid, {}).get(run_id)
        if st is None or st.status not in ("running", "pending"):
            return False
        st.status = "paused"
        st.pause_event.clear()
        return True

    def resume(self, pid: str, run_id: str) -> bool:
        st = self._runs.get(pid, {}).get(run_id)
        if st is None or st.status != "paused":
            return False
        st.status = "running"
        st.pause_event.set()
        return True

    def state(self, pid: str, run_id: str) -> dict:
        st = self._runs.get(pid, {}).get(run_id)
        if st is None:
            # run completate vive solo su disco (runs/{id}.json)
            return {"status": "unknown"}
        return {
            "status": st.status,
            "cancelled": st.cancel_event.is_set(),
            "paused": not st.pause_event.is_set(),
        }

    def forget(self, pid: str, run_id: str) -> None:
        self._runs.get(pid, {}).pop(run_id, None)
