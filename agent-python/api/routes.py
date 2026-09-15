"""api/routes.py — endpoint REST + SSE per l'harness Elysium Agent.

Progetti, chat (SSE streaming), file del workspace, storico run.
Vedi CONTRACT.md per lo schema esatto.
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, Field

from api.client_factory import get_llm
from harness.chat import ChatAgent
from harness.projects import ProjectStore

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")
store = ProjectStore()


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1)
    allow_remote: bool = False  # v0.16 opt-in: abilita push/pull per questo progetto = Field(min_length=1)


class ProjectAttach(BaseModel):
    name: str = Field(min_length=1)
    folder_path: str = Field(min_length=1)


class ChatMessage(BaseModel):
    message: str = Field(min_length=1)


# ── progetti ───────────────────────────────────────────────────
@router.get("/projects")
async def list_projects():
    projects = store.list()
    return {"projects": [
        {"id": p.id, "name": p.name, "created_at": p.created_at,
         "attached": p.attached,
         "files_count": len(store.list_files(p))}
        for p in projects
    ]}


@router.post("/projects", status_code=201)
async def create_project(req: ProjectCreate):
    p = store.create(req.name, allow_remote=req.allow_remote)
    return {"id": p.id, "name": p.name, "created_at": p.created_at,
            "attached": False, "allow_remote": p.allow_remote}


@router.post("/projects/attach", status_code=201)
async def attach_project(req: ProjectAttach):
    """Collega un progetto a una cartella ESISTENTE dell'utente (in-place)."""
    proj, err = store.attach(req.name, req.folder_path)
    if err:
        raise HTTPException(400, err)
    return {"id": proj.id, "name": proj.name, "created_at": proj.created_at,
            "attached": True, "source_path": proj.source_path}


@router.get("/projects/{pid}")
async def get_project(pid: str):
    p = store.get(pid)
    if not p:
        raise HTTPException(404, "progetto non trovato")
    return {"id": p.id, "name": p.name, "created_at": p.created_at,
            "attached": p.attached, "source_path": p.source_path,
            "files": store.list_files(p),
            "runs": store.list_runs(p)}


@router.delete("/projects/{pid}", status_code=204)
async def delete_project(pid: str):
    if not store.delete(pid):
        raise HTTPException(404, "progetto non trovato")
    return None


# ── chat ───────────────────────────────────────────────────────
@router.get("/projects/{pid}/chat")
async def get_chat(pid: str):
    p = store.get(pid)
    if not p:
        raise HTTPException(404, "progetto non trovato")
    return {"messages": store.read_chat(p)}


@router.post("/projects/{pid}/chat")
async def chat(pid: str, req: ChatMessage):
    p = store.get(pid)
    if not p:
        raise HTTPException(404, "progetto non trovato")
    async def gen():
        try:
            llm = get_llm()
            agent = ChatAgent(llm=llm, project=p, store=store)
            async for ev in agent.respond_stream(req.message):
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except Exception as exc:  # noqa: BLE001
            log.exception("chat SSE fallita")
            yield f"data: {json.dumps({'type': 'error', 'detail': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ── file workspace ────────────────────────────────────────────
@router.get("/projects/{pid}/files")
async def list_files(pid: str):
    p = store.get(pid)
    if not p:
        raise HTTPException(404, "progetto non trovato")
    return {"files": store.list_files(p)}


@router.get("/projects/{pid}/files/{path:path}")
async def read_file(pid: str, path: str):
    p = store.get(pid)
    if not p:
        raise HTTPException(404, "progetto non trovato")
    res = store.read_file(p, path)
    if not res.get("ok"):
        raise HTTPException(404, res.get("error", "file non trovato"))
    return res


# ── run Elysium ───────────────────────────────────────────────
@router.get("/projects/{pid}/runs")
async def list_runs(pid: str):
    p = store.get(pid)
    if not p:
        raise HTTPException(404, "progetto non trovato")
    return {"runs": store.list_runs(p)}


@router.get("/projects/{pid}/runs/{run_id}")
async def get_run(pid: str, run_id: str):
    import os
    p = store.get(pid)
    if not p:
        raise HTTPException(404, "progetto non trovato")
    path = os.path.join(p.runs_dir, f"{run_id}.json")
    if not os.path.isfile(path):
        raise HTTPException(404, "run non trovato")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ── v0.16: run control (cancel / status) ──────────────────────
from harness.run_state import RunRegistry

run_registry = RunRegistry()


class RunCancel(BaseModel):
    run_id: str


@router.post("/projects/{pid}/runs/cancel")
async def cancel_run(pid: str, req: RunCancel):
    """Cancella una run in corso (cooperative cancellation)."""
    p = store.get(pid)
    if not p:
        raise HTTPException(404, "progetto non trovato")
    ok = run_registry.cancel(pid, req.run_id)
    return {"cancelled": ok, "run_id": req.run_id}


@router.get("/projects/{pid}/runs/{run_id}/status")
async def run_status(pid: str, run_id: str):
    """Stato di controllo della run (running/paused/cancelled/...)."""
    p = store.get(pid)
    if not p:
        raise HTTPException(404, "progetto non trovato")
    return {"run_id": run_id, "state": run_registry.state(pid, run_id)}
