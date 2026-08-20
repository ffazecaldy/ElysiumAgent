"""api/routes.py — endpoint REST + background loop del Gauntlet.

Macchina a stati:
  pending_confirmation → running → awaiting_approval → running
  → completed | stopped | quota_exhausted | failed

Check-in per-round NON bloccante: il Gauntlet attende su asyncio.Event che
viene settato SOLO via POST /runs/{id}/continue (mai input(), mai auto-advance).
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api import factory
from api.store import store
from engine.state import is_tier1_fast_path

log = logging.getLogger(__name__)

router = APIRouter(prefix="/runs")


class RunRequest(BaseModel):
    goal: str = Field(min_length=1)
    bar: str = Field(default="pytest", pattern="^(pytest|perf)$")
    max_rounds: int = Field(default=3, ge=1, le=10)


@router.post("")
async def create_run(req: RunRequest):
    tier = factory.detect_tier_for(req.goal)
    estimate = factory.estimate_tokens_for(req.goal, req.max_rounds)
    run = store.create(
        goal=req.goal,
        bar=req.bar,
        max_rounds=req.max_rounds,
        estimate_tokens=estimate,
        tier=tier,
    )
    # Phase 0.7a: stima token PRIMA di qualunque dispatch
    return {"id": run.id, "status": run.status, "estimate_tokens": estimate,
            "tier": tier, "max_rounds": run.max_rounds}


async def _run_background(run_id: str) -> None:
    """Task asincrono che esegue il Gauntlet e aggiorna lo store."""
    run = store.get(run_id)
    if run is None:
        return
    workspace = factory.run_workspace(run_id)
    adapter = store.adapter_for(run)
    g = factory.build_gauntlet(
        goal=run.goal, bar=run.bar, max_rounds=run.max_rounds,
        workspace=workspace, status_store=adapter,
        approval_event=run.approval_event, stop_event=run.stop_event,
    )
    try:
        report = await g.run(goal=run.goal, workspace=workspace, run_id=run_id,
                             approval_event=run.approval_event,
                             stop_event=run.stop_event)
        await store.set_status(run_id, run.status, report)
    except Exception as exc:  # noqa: BLE001
        name = type(exc).__name__
        status = "quota_exhausted" if name == "QuotaExhaustedError" else "failed"
        run.exception = f"{name}: {exc}"
        await store.set_status(run_id, status, {"error": str(exc)})
        log.exception("run %s failed", run_id)


@router.post("/{run_id}/confirm")
async def confirm_run(run_id: str):
    run = store.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run non trovato")

    # Tier 1 fast-path (A2): niente loop, eseguo direttamente
    if is_tier1_fast_path(run.tier):
        report = {"run_id": run_id, "goal": run.goal, "bar_beaten": True,
                  "rounds": 0, "budget_hit": False, "stopped": False,
                  "rounds_detail": [], "tokens_used": 0,
                  "fast_path": True,
                  "note": "tier 1: esecuzione diretta senza loop"}
        await store.set_status(run_id, "completed", report)
        return {"id": run_id, "status": "completed", "fast_path": True}

    if run.status != "pending_confirmation":
        raise HTTPException(status_code=409, detail=f"stato attuale: {run.status}")

    await store.set_status(run_id, "running")
    asyncio.create_task(_run_background(run_id))
    return {"id": run_id, "status": "running"}


@router.post("/{run_id}/continue")
async def continue_run(run_id: str):
    run = store.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run non trovato")
    if run.status not in ("awaiting_approval", "running"):
        raise HTTPException(status_code=409, detail=f"stato attuale: {run.status}")
    run.stop_event.clear()
    run.approval_event.set()   # sblocca il check-in per-round (Phase 0.7c)
    if run.status == "awaiting_approval":
        await store.set_status(run_id, "running")
    return {"id": run_id, "status": run.status}


@router.post("/{run_id}/stop")
async def stop_run(run_id: str):
    run = store.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run non trovato")
    if run.status not in ("running", "awaiting_approval", "pending_confirmation"):
        raise HTTPException(status_code=409, detail=f"stato attuale: {run.status}")
    run.stop_event.set()        # il loop esce pulito a fine round
    if run.status == "awaiting_approval":
        run.approval_event.set()  # sblocca l'attesa per far arrivare il loop a stop
        await store.set_status(run_id, "stopped")
    else:
        await store.set_status(run_id, "running")
    return {"id": run_id, "status": "stopping"}


@router.get("/{run_id}")
async def get_run(run_id: str):
    run = store.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run non trovato")
    return run.snapshot()


@router.get("/{run_id}/events")
async def get_events(run_id: str):
    """Coda eventi per il progress live (polling UI, ~2s)."""
    run = store.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run non trovato")
    snap = run.snapshot()
    return {
        "id": run_id,
        "status": snap["status"],
        "events": snap["events"],
        "last_update": snap["last_update"],
        "estimate_tokens": snap["estimate_tokens"],
        "tokens_used": snap["tokens_used"],
    }


@router.get("")
async def list_runs():
    # run recenti per localStorage: id, goal, status, tier
    return {"runs": [
        {"id": r.id, "goal": r.goal, "status": r.status, "tier": r.tier,
         "created_at": r.created_at}
        for r in store.all()
    ], "total": len(store.all())}
