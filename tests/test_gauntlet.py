import asyncio

import pytest

from engine.budget import BudgetTracker, estimate_tokens
from engine.gauntlet import Gauntlet, STATUS_AWAITING_APPROVAL


class FakeLLM:
    def __init__(self):
        self.i = 0

    async def complete(self, messages, **k):
        self.i += 1
        return {"choices": [{"message": {"content":
            f"```python\n# builder output {self.i}\ndef solve():\n    return {self.i}\n```"}}]}


class FakeBar:
    """Perde fino a win_at round, poi vince."""
    def __init__(self, win_at=2, always_lose=False):
        self.n = 0
        self.win_at = win_at
        self.always_lose = always_lose

    def evaluate(self, workspace):
        self.n += 1
        win = (not self.always_lose) and (self.n >= self.win_at)
        return {"win": win, "passed": 1, "failed": 0 if win else 1,
                "detail": f"round {self.n}", "n": self.n}


async def _driver_approver(task, store, run_id, event, tick=0.01):
    """Approva automaticamente i checkpoint (come POST /runs/{id}/continue)."""
    while not task.done():
        if store.get(run_id, {}).get("status") == STATUS_AWAITING_APPROVAL:
            event.set()
        await asyncio.sleep(tick)


async def test_round_vince_contro_barra(tmp_path):
    workspace = str(tmp_path)
    store = {}
    event = asyncio.Event()
    g = Gauntlet(llm=FakeLLM(), bar=FakeBar(win_at=2), max_rounds=3, status_store=store)
    task = asyncio.create_task(g.run("ottimizza sort", workspace, "r1", event))
    await _driver_approver(task, store, "r1", event)
    report = await asyncio.wait_for(task, timeout=5)
    assert report["bar_beaten"] is True
    assert report["rounds"] == 2


async def test_checkpoint_attende_evento_senza_bloccare(tmp_path):
    # FakeBar perde sempre; approval_event MAI settato -> run esce in awaiting_approval
    workspace = str(tmp_path)
    store = {}
    g = Gauntlet(llm=FakeLLM(), bar=FakeBar(always_lose=True), max_rounds=3, status_store=store)
    task = asyncio.create_task(g.run("x", workspace, "r1", asyncio.Event()))
    await asyncio.sleep(0.3)  # dà tempo al round 1 di finire
    assert store["r1"]["status"] == "awaiting_approval", store
    assert not task.done()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_cap_round_ferma(tmp_path):
    # max_rounds=2 e la barra perde sempre -> budget_hit dopo 2 round
    workspace = str(tmp_path)
    store = {}
    event = asyncio.Event()
    g = Gauntlet(llm=FakeLLM(), bar=FakeBar(always_lose=True), max_rounds=2, status_store=store)
    task = asyncio.create_task(g.run("x", workspace, "r2", event))
    await _driver_approver(task, store, "r2", event)
    report = await asyncio.wait_for(task, timeout=5)
    assert report["budget_hit"] is True
    assert report["rounds"] == 2


def test_estimate_tokens():
    est = estimate_tokens(subagents=10, rounds=3, summary_cap_tokens=1000)
    assert est == 30000


def test_budget_tracker_cap():
    bt = BudgetTracker(round_cap=3, summary_cap_tokens=1000)
    bt.add_tokens(1000)
    assert bt.tokens_used == 1000
    assert bt.hit() is False
    bt.add_tokens(2500)
    assert bt.hit() is True
