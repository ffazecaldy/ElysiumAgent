"""harness/projects.py — gestione progetti: workspace persistenti su disco.

Ogni progetto = cartella con:
- files/          → artefatti prodotti dagli agenti (codice, docs, ecc.)
- chat.json       → conversazione persistente (messaggi user/assistant)
- runs/           → storico run Elysium (report JSON)

Struttura:
  {ROOT}/{progetto}/files/
  {ROOT}/{progetto}/chat.json
  {ROOT}/{progetto}/runs/{run_id}.json
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

ROOT = os.environ.get(
    "ELYSIUM_AGENT_HOME",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "projects"),
)


def _safe_slug(name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", name.strip().lower()).strip("-")
    return slug or f"progetto-{uuid.uuid4().hex[:6]}"


@dataclass
class Project:
    id: str
    name: str
    created_at: float
    path: str

    @property
    def files_dir(self) -> str:
        return os.path.join(self.path, "files")

    @property
    def chat_path(self) -> str:
        return os.path.join(self.path, "chat.json")

    @property
    def runs_dir(self) -> str:
        return os.path.join(self.path, "runs")


class ProjectStore:
    def __init__(self, root: str | None = None):
        self.root = root or ROOT
        os.makedirs(self.root, exist_ok=True)

    def _index(self) -> dict:
        idx_path = os.path.join(self.root, "_index.json")
        if os.path.exists(idx_path):
            with open(idx_path, "r", encoding="utf-8") as f:
                return json.load(f)
        return {}

    def _save_index(self, idx: dict) -> None:
        with open(os.path.join(self.root, "_index.json"), "w", encoding="utf-8") as f:
            json.dump(idx, f, indent=2)

    def list(self) -> list[Project]:
        idx = self._index()
        out = []
        for pid, meta in idx.items():
            out.append(Project(
                id=pid, name=meta.get("name", pid),
                created_at=meta.get("created_at", 0),
                path=meta.get("path", os.path.join(self.root, pid)),
            ))
        out.sort(key=lambda p: p.created_at, reverse=True)
        return out

    def get(self, project_id: str) -> Optional[Project]:
        idx = self._index()
        meta = idx.get(project_id)
        if not meta:
            return None
        return Project(
            id=project_id, name=meta.get("name", project_id),
            created_at=meta.get("created_at", 0),
            path=meta.get("path", os.path.join(self.root, project_id)),
        )

    def create(self, name: str) -> Project:
        pid = _safe_slug(name)
        base = pid
        n = 2
        idx = self._index()
        while pid in idx:
            pid = f"{base}-{n}"
            n += 1
        path = os.path.join(self.root, pid)
        os.makedirs(os.path.join(path, "files"), exist_ok=True)
        os.makedirs(os.path.join(path, "runs"), exist_ok=True)
        proj = Project(id=pid, name=name, created_at=time.time(), path=path)
        idx[pid] = {"name": name, "created_at": proj.created_at, "path": path}
        self._save_index(idx)
        self._write_chat(proj, [])
        return proj

    def delete(self, project_id: str) -> bool:
        idx = self._index()
        if project_id not in idx:
            return False
        import shutil
        shutil.rmtree(idx[project_id]["path"], ignore_errors=True)
        del idx[project_id]
        self._save_index(idx)
        return True

    # ── chat ────────────────────────────────────────────────
    def read_chat(self, project: Project) -> list[dict]:
        if os.path.exists(project.chat_path):
            try:
                with open(project.chat_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, OSError):
                return []
        return []

    def _write_chat(self, project: Project, messages: list[dict]) -> None:
        with open(project.chat_path, "w", encoding="utf-8") as f:
            json.dump(messages, f, ensure_ascii=False, indent=2)

    def append_message(self, project: Project, role: str, content: str,
                       meta: Optional[dict] = None) -> dict:
        msg = {"role": role, "content": content, "ts": time.time()}
        if meta:
            msg["meta"] = meta
        chat = self.read_chat(project)
        chat.append(msg)
        self._write_chat(project, chat)
        return msg

    # ── files ───────────────────────────────────────────────
    def list_files(self, project: Project) -> list[dict]:
        out = []
        base = project.files_dir
        if not os.path.isdir(base):
            return out
        for dirpath, _dirs, filenames in os.walk(base):
            for fn in sorted(filenames):
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, base)
                try:
                    stat = os.stat(full)
                except OSError:
                    continue
                out.append({"path": rel, "bytes": stat.st_size,
                            "modified": stat.st_mtime})
        return out

    def read_file(self, project: Project, rel: str, limit_chars: int = 8000) -> dict:
        full = os.path.normpath(os.path.join(project.files_dir, rel))
        if not full.startswith(os.path.normpath(project.files_dir) + os.sep) and \
           full != os.path.normpath(project.files_dir):
            return {"error": "path fuori dal workspace", "ok": False}
        if not os.path.isfile(full):
            return {"error": f"file non trovato: {rel}", "ok": False}
        with open(full, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
        truncated = len(text) > limit_chars
        return {"path": rel, "content": text[:limit_chars],
                "truncated": truncated, "ok": True}

    def write_file(self, project: Project, rel: str, content: str) -> dict:
        full = os.path.normpath(os.path.join(project.files_dir, rel))
        base = os.path.normpath(project.files_dir)
        if not (full.startswith(base + os.sep) or full == base):
            return {"error": "path fuori dal workspace", "ok": False}
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(content)
        return {"path": rel, "bytes": len(content), "ok": True}

    # ── runs ────────────────────────────────────────────────
    def save_run(self, project: Project, run: dict) -> str:
        run_id = run.get("run_id") or uuid.uuid4().hex[:8]
        os.makedirs(project.runs_dir, exist_ok=True)
        with open(os.path.join(project.runs_dir, f"{run_id}.json"), "w", encoding="utf-8") as f:
            json.dump(run, f, ensure_ascii=False, indent=2)
        return run_id

    def list_runs(self, project: Project) -> list[dict]:
        out = []
        if os.path.isdir(project.runs_dir):
            for fn in sorted(os.listdir(project.runs_dir)):
                if not fn.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(project.runs_dir, fn), "r", encoding="utf-8") as f:
                        run = json.load(f)
                    out.append({"id": fn[:-5], "goal": run.get("goal"),
                                "ts": run.get("started_at"),
                                "first_pass_rate": run.get("first_pass_rate"),
                                "quality": run.get("avg_quality"),
                                "n_tasks": len(run.get("tasks", []))})
                except (json.JSONDecodeError, OSError):
                    continue
        out.sort(key=lambda r: r.get("ts", 0), reverse=True)
        return out
