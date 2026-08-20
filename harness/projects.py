"""harness/projects.py — gestione progetti: workspace persistenti su disco.

Ogni progetto = cartella metadata del harness con:
- workspace/   → artefatti prodotti dagli agenti (codice, docs, ecc.)
- chat.json    → conversazione persistente (messaggi user/assistant)
- runs/        → storico run Elysium (report JSON)

Due tipi di progetto:
- NORMALE: workspace creato dal harness (projects/{slug}/workspace).
- ATTACH: collegato a una CARTELLA ESISTENTE dell'utente (es. una repo).
  Il workspace è la cartella utente in-place; il metadata (chat/runs) resta
  isolato nel harness. IL DELETE NON TOCCA MAI la cartella utente.

Struttura:
  {ROOT}/{progetto}/workspace/     (normale)  |  {PATH_UTENTE} (attach)
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
    path: str                      # dir metadata (chat.json, runs/)
    workspace: str | None = None   # dir file; se None → path/workspace (normale)
    attached: bool = False         # True = workspace è una cartella esterna utente
    source_path: str | None = None # path originale della cartella esterna

    @property
    def files_dir(self) -> str:
        if self.workspace:
            return self.workspace
        return os.path.join(self.path, "workspace")

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
            out.append(self._from_meta(pid, meta))
        out.sort(key=lambda p: p.created_at, reverse=True)
        return out

    def _from_meta(self, pid: str, meta: dict) -> Project:
        return Project(
            id=pid,
            name=meta.get("name", pid),
            created_at=meta.get("created_at", 0),
            path=meta.get("path", os.path.join(self.root, pid)),
            workspace=meta.get("workspace"),
            attached=bool(meta.get("attached", False)),
            source_path=meta.get("source_path"),
        )

    def get(self, project_id: str) -> Optional[Project]:
        idx = self._index()
        meta = idx.get(project_id)
        if not meta:
            return None
        return self._from_meta(project_id, meta)

    def create(self, name: str) -> Project:
        pid = _safe_slug(name)
        base = pid
        n = 2
        idx = self._index()
        while pid in idx:
            pid = f"{base}-{n}"
            n += 1
        path = os.path.join(self.root, pid)
        os.makedirs(os.path.join(path, "workspace"), exist_ok=True)
        os.makedirs(os.path.join(path, "runs"), exist_ok=True)
        proj = Project(id=pid, name=name, created_at=time.time(),
                       path=path, workspace=None, attached=False)
        idx[pid] = {"name": name, "created_at": proj.created_at, "path": path,
                    "attached": False}
        self._save_index(idx)
        self._write_chat(proj, [])
        return proj

    def attach(self, name: str, folder_path: str) -> tuple[Project, Optional[str]]:
        """Collega il progetto a una CARTELLA ESISTENTE dell'utente (in-place).

        Il workspace è la cartella data; i metadata (chat/runs) restano isolati
        nel harness. Ritorna (project, None) oppure (None, errore) se il path
        non esiste o non è una directory.
        """
        folder_path = os.path.abspath(os.path.expanduser(folder_path))
        if not os.path.isdir(folder_path):
            return None, f"cartella non trovata o non è una directory: {folder_path}"
        # non permettere di collegare la root stessa o una sottocartella del harness
        root_norm = os.path.normcase(os.path.abspath(self.root))
        folder_norm = os.path.normcase(folder_path)
        if folder_norm == root_norm or folder_norm.startswith(root_norm + os.sep):
            return None, "non puoi collegare la cartella interna del harness"

        pid = _safe_slug(name)
        base = pid
        n = 2
        idx = self._index()
        while pid in idx:
            pid = f"{base}-{n}"
            n += 1
        path = os.path.join(self.root, pid)  # metadata isolato nel harness
        os.makedirs(path, exist_ok=True)
        os.makedirs(os.path.join(path, "runs"), exist_ok=True)
        proj = Project(id=pid, name=name, created_at=time.time(),
                       path=path, workspace=folder_path, attached=True,
                       source_path=folder_path)
        idx[pid] = {"name": name, "created_at": proj.created_at, "path": path,
                    "workspace": folder_path, "attached": True,
                    "source_path": folder_path}
        self._save_index(idx)
        self._write_chat(proj, [])
        return proj, None

    def delete(self, project_id: str) -> bool:
        idx = self._index()
        if project_id not in idx:
            return False
        import shutil
        meta = idx[project_id]
        # IMPORTANTE: se attachato, NON rimuovere mai la cartella utente
        if meta.get("attached"):
            # rimuovi solo il metadata del harness
            if os.path.isdir(meta.get("path", "")) and \
               os.path.normcase(os.path.abspath(meta["path"])).startswith(
                   os.path.normcase(self.root) + os.sep):
                shutil.rmtree(meta["path"], ignore_errors=True)
        else:
            shutil.rmtree(meta.get("path", ""), ignore_errors=True)
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
    # esclusi dal browser workspace: cache/artefatti di build
    EXCLUDED_PARTS = ("__pycache__", ".git", "node_modules", ".venv", ".pytest_cache",
                      ".idea", ".vscode", "dist", "build")

    def _ignore(self, rel: str) -> bool:
        parts = rel.replace("\\", "/").split("/")
        return any(p in self.EXCLUDED_PARTS for p in parts)

    def list_files(self, project: Project) -> list[dict]:
        out = []
        base = project.files_dir
        if not os.path.isdir(base):
            return out
        for dirpath, dirs, filenames in os.walk(base):
            # pota le dir escluse durante la walk (evita di scendere in .git/.venv)
            dirs[:] = [d for d in dirs if d not in self.EXCLUDED_PARTS]
            for fn in sorted(filenames):
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, base)
                if self._ignore(rel):
                    continue
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
