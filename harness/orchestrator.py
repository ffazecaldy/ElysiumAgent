"""harness/orchestrator.py — cuore dell'harness: l'agente coordinatore.

Flusso (Elysium v0.15):
1. L'utente manda un goal nel progetto.
2. `decide()`: band filter (engine/state.py) → tier 1 = risposta diretta,
   tier 2+ = attiva il loop multi-agente (decompose → scatter → quality → retry).
3. Il loop scrive i file nel workspace del progetto e produce un report.
4. La chat conserva la conversazione; l'utente può iterare ("fai tu" / correzioni).

La decomposizione è lavoro INTELLETTUALE del modello (mai hardcoded):
decompose LLM → validate deterministic (no file conflicts, slots) → scatter.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import uuid
from typing import Any, Optional

from engine.decompose import decompose, DecompositionError
from engine.quality_gate import apply_penalties
from engine.result_parser import parse_result
from engine.state import BAND_KEYWORDS, band_filter, detect_tier, tier_to_threshold
from engine.security_shield import scan as security_scan
from harness.git_service import GitService
from harness.projects import Project, ProjectStore
from harness.execution import ProjectRunner

log = logging.getLogger(__name__)

# soglia quality per accettare un task senza retry (Phase 3 / Quality Matrix)
DEFAULT_THRESHOLD = 7.0


SYSTEM_PROMPT = """Sei Elysium Agent, un harness multi-agente che lavora su progetti software.
Lavori dentro un workspace di progetto (files/) e coordini agenti subalterni.

COME LAVORI:
- Tier 1 (task atomico: typo, rename, 1 file): rispondi direttamente, nessun loop.
- Tier 2-4 (feature, refactor, sistema multi-file): ATTIVA IL LOOP multi-agente:
  decomponi il goal, lancia N agenti in parallelo, valida ogni risultato con un
  quality gate, ritenta i task sotto soglia, poi assembla e fai il report.
- Se il goal è ambiguo nei dettagli architetturali (DB, auth, frontend), chiedi
  max 1 domanda mirata PRIMA di decomporre.

STILE:
- Risposte in italiano, concise, orientate all'azione.
- Nessuna genericità: ogni affermazione misurabile deve avere il numero.
- Dopo ogni run riporti: first-pass rate, qualità media, task passati/ritentati,
  file scritti, token consumati.

FORMATO REPORT FINALE (dopo un loop):
## ✅ [goal]
- Agenti: N dispatciati | first-pass XX% | qualità X.Y/10
- Task: passati X | ritentati Y | file: [elenco]
- Token: N
"""

WORKER_PROMPT = """Sei uno dei {total} agenti paralleli dell'harness Elysium, che lavora sul goal:
{goal}

Il tuo compito (task): {description}
File tuoi (esclusivi, non toccare altri): {files}
Threshold: {threshold}/10

ISTRUZIONI:
1. Implementa COMPLETAMENTE il tuo pezzo (niente stub/TODO).
2. Scrivi il codice/artefatto per intero nel campo FILES qui sotto.
3. Auto-valuta onestamente.
4. Se {iteration} > 1 e stai ritentando: correggi SUI gap indicati.

RISPOSTA — formato ESATTO:
## RESULT
- task_id: {task_id}
- status: pass|fail
- quality_score: N/10
- gaps: [elenco diretto]

## FILES
### FILE: percorso/relativo.py
```python
<codice completo>
```
(ripeti il blocco per ogni file da scrivere)
"""


# ──────────────────────────────────────────────────────────────
# Parsing del blocco ## FILES (output del worker)
# ──────────────────────────────────────────────────────────────
_FILE_BLOCK_RE = re.compile(r"### FILE:\s*([^\n]+)\n```[^\n]*\n(.*?)```", re.DOTALL)


def parse_files_block(text: str) -> list[dict]:
    """Estrae i file dal blocco ## FILES prodotto dal worker."""
    files = []
    for m in _FILE_BLOCK_RE.finditer(text):
        rel = m.group(1).strip().strip("`").strip('"').strip("'")
        files.append({"path": rel, "content": m.group(2)})
    return files


class HarnessRun:
    """Un'esecuzione del loop multi-agente (tier 2+)."""

    def __init__(self, llm, goal: str, project: Project, store: ProjectStore,
                 max_concurrent: int = 8, max_retries: int = 2,
                 threshold: float = DEFAULT_THRESHOLD, run_id: Optional[str] = None,
                 git_enabled: bool = True, execution_enabled: bool = True,
                 execution_timeout_s: float = 120.0,
                 rollback_on_failure: bool = True,
                 cancel_event: Optional["asyncio.Event"] = None):
        self._llm = llm
        self.goal = goal
        self.project = project
        self.store = store
        self.max_concurrent = max_concurrent
        self.max_retries = max_retries
        self.threshold = threshold
        self.run_id = run_id or uuid.uuid4().hex[:8]
        self.tier = detect_tier(goal)
        self._written_files: list[dict] = []
        # ── v0.16: execution / git / run control ──
        self.git_enabled = git_enabled
        self.execution_enabled = execution_enabled
        self.execution_timeout_s = execution_timeout_s
        self.rollback_on_failure = rollback_on_failure
        self.cancel_event = cancel_event
        self._git: Optional[GitService] = None
        self._pre_run_sha: Optional[str] = None
        self._events: list[dict] = []

    # ── v0.16 run control ─────────────────────────────────────
    def _emit(self, etype: str, **data) -> None:
        """Registra un evento di run (usato anche da SSE via report['events'])."""
        ev = {"type": etype, "run_id": self.run_id, "ts": time.time(), **data}
        self._events.append(ev)

    def _cancelled(self) -> bool:
        return self.cancel_event is not None and self.cancel_event.is_set()

    def _workspace(self) -> str:
        return self.project.files_dir

    async def _complete(self, messages: list[dict], max_tokens: int = 4000) -> str:
        resp = await self._llm.complete(messages, max_tokens=max_tokens)
        return resp["choices"][0]["message"]["content"]

    async def run(self) -> dict:
        """Esegue il loop completo v0.16:
        decompose → scatter → write → execute/verify → retry → commit/rollback → report.
        """
        started = time.time()
        report = {
            "run_id": self.run_id,
            "goal": self.goal,
            "tier": self.tier,
            "started_at": started,
            "threshold": self.threshold,
            "tasks": [],          # stato per task
            "files_written": [],  # file prodotti nel workspace
            "first_pass_rate": None,
            "avg_quality": None,
            "final_status": "running",
            # ── v0.16 additions (additive, backward compatible) ──
            "execution": {"detected": False, "command": [], "success": False,
                          "returncode": None, "duration": 0.0, "stdout": "",
                          "stderr": "", "timed_out": False, "skipped": True,
                          "skip_reason": "not run", "results": []},
            "git": {"repository_initialized": False, "pre_run_checkpoint": None,
                    "final_commit": None, "rollback": [],
                    "rollback_scope": None},
            "run": {"status": "running", "cancelled": False,
                    "paused": False, "resumed": False},
            "events": self._events,
        }
        self._emit("run_started")

        # ── cancel gate: cancelled PRIMA di iniziare ──
        if self._cancelled():
            report["final_status"] = "cancelled"
            report["run"]["status"] = "cancelled"
            report["run"]["cancelled"] = True
            self._emit("run_cancelled")
            self.store.save_run(self.project, report)
            return report

        # ── git: ensure repo + checkpoint pre-run ──
        if self.git_enabled:
            self._git = GitService(self._workspace())
            if not self._git.is_repo():
                self._git.ensure_repo()
                report["git"]["repository_initialized"] = True
            self._pre_run_sha = self._git.checkpoint(f"pre-run {self.run_id}")
            report["git"]["pre_run_checkpoint"] = self._pre_run_sha
            self._emit("checkpoint", sha=self._pre_run_sha)

        tasks = await self._decompose()

        # scatter in parallelo con semaforo
        sem = asyncio.Semaphore(self.max_concurrent)

        async def _work(task: dict) -> dict:
            async with sem:
                if self._cancelled():
                    return {"task_id": task.get("id"), "status": "cancelled",
                            "quality_score": 0.0, "files": [], "attempts": 0,
                            "modified_paths": []}
                return await self._exec_task(task)

        results = await asyncio.gather(*[_work(t) for t in tasks])
        for task, res in zip(tasks, results):
            entry = {"task_id": task.get("id"), "status": res.get("status"),
                     "quality": res.get("quality_score"),
                     "attempts": res.get("attempts"), "gap": res.get("gap"),
                     "files": res.get("files", []),
                     # v0.16 additions
                     "retry_count": max(0, res.get("attempts", 1) - 1),
                     "modified_paths": res.get("modified_paths", []),
                     "verification": res.get("verification"),
                     }
            report["tasks"].append(entry)
            self._emit("task_completed", task_id=entry["task_id"], status=entry["status"])

        # metriche
        first_try = [t for t in report["tasks"] if t.get("attempts", 0) == 1]
        ok_first = [t for t in first_try if t.get("status") == "pass"]
        report["first_pass_rate"] = round(len(ok_first) / len(first_try), 3) if first_try else 0.0
        quals = [t.get("quality") for t in report["tasks"] if t.get("quality") is not None]
        report["avg_quality"] = round(sum(quals) / len(quals), 2) if quals else 0.0
        report["n_tasks"] = len(report["tasks"])
        n_pass = sum(1 for t in report["tasks"] if t.get("status") == "pass")
        report["n_passed"] = n_pass
        report["duration_s"] = round(time.time() - started, 1)
        report["tokens_estimate"] = sum(
            t.get("attempts", 0) * 900 for t in report["tasks"])  # stima conservativa
        report["files_written"] = self._written_files

        # ── v0.16: execution / verification della run ──
        ws = self._workspace()
        if self.execution_enabled and not self._cancelled():
            self._emit("verification_started")
            runner = ProjectRunner()
            ver = runner.run_verification(ws, timeout_s=self.execution_timeout_s, enabled=True)
            report["execution"] = ver
            self._emit("verification_result", success=ver["success"], kind=ver["kind"])
        elif self._cancelled():
            report["execution"]["skip_reason"] = "run cancelled"

        # ── v0.16: selective rollback / final commit ──
        failed_tasks = [t for t in report["tasks"] if t.get("status") == "fail"]
        cancelled = report["run"]["cancelled"]

        if self._git is not None and self._pre_run_sha:
            if failed_tasks and self.rollback_on_failure:
                # rollback SELETTIVO: ripristina solo i path dei task falliti
                for t in failed_tasks:
                    paths = t.get("modified_paths") or t.get("files") or []
                    if paths:
                        n = self._git.rollback_paths(paths, to_commit=self._pre_run_sha)
                        report["git"]["rollback"].append(
                            {"scope": "task", "task_id": t["task_id"], "paths": paths, "restored": n}
                        )
                    # il task fallito e ripristinato conta come non-passato
                    t["status"] = "rolled_back"
                report["git"]["rollback_scope"] = "task"
                self._emit("rollback", scope="task", tasks=[t["task_id"] for t in failed_tasks])
                n_pass = sum(1 for t in report["tasks"] if t.get("status") == "pass")
                report["n_passed"] = n_pass

            if report["execution"].get("success") and not cancelled and not failed_tasks:
                # verificato → commit finale coerente
                sha = self._git.commit(f"elysium run {self.run_id}: {self.goal[:60]}")
                report["git"]["final_commit"] = sha
                self._emit("run_commit", sha=sha)
            elif failed_tasks:
                # stato di verifica fallita definitiva: nessun commit finale
                report["git"]["final_commit"] = None

        # ── final status (preserva partial/cancelled) ──
        if cancelled:
            report["final_status"] = "cancelled"
            report["run"]["status"] = "cancelled"
            report["run"]["cancelled"] = True
            self._emit("run_cancelled")
        elif n_pass == len(report["tasks"]) and len(report["tasks"]) > 0:
            report["final_status"] = "completed"
            report["run"]["status"] = "completed"
            self._emit("run_completed")
        elif failed_tasks or any(t.get("status") == "rolled_back" for t in report["tasks"]):
            report["final_status"] = "partial"
            report["run"]["status"] = "partial"
        else:
            report["final_status"] = "partial"
            report["run"]["status"] = "partial"

        self.store.save_run(self.project, report)
        return report

    # ── decomposizione ───────────────────────────────────────
    async def _decompose(self) -> list[dict]:
        slots = min(self.max_concurrent * 2, 16)
        n_iteration = 0
        while True:
            n_iteration += 1
            try:
                return await decompose(self.goal, self._llm, available_slots=slots)
            except DecompositionError as exc:
                log.warning("decompose (it %d) rifiutato: %s", n_iteration, exc)
                if n_iteration >= 2:
                    # fallback: single task sul goal intero
                    return [{"id": "t1", "description": self.goal,
                             "files": [], "interface_contract": None}]

    # ── esecuzione singolo task con retry ────────────────────
    async def _exec_task(self, task: dict) -> dict:
        task_id = task.get("id", "?" )
        files = task.get("files", []) or []
        attempts = 0
        last_gap = None
        result: dict = {"task_id": task_id, "status": "fail",
                        "quality_score": 0.0, "files": [], "attempts": 0,
                        "modified_paths": [], "verification": None}

        while attempts < self.max_retries + 1:
            attempts += 1
            prompt = WORKER_PROMPT.format(
                total=8, goal=self.goal, description=task.get("description", ""),
                files=", ".join(files) if files else "(nessuno — scrivi nel root)",
                threshold=int(self.threshold), task_id=task_id, iteration=attempts,
            )
            if last_gap:
                prompt += f"\n\nGAP del tentativo precedente da chiudere: {last_gap}"
            try:
                content = await self._complete([{"role": "user", "content": prompt}], max_tokens=5000)
            except Exception as exc:  # noqa: BLE001
                log.exception("worker %s fallito", task_id)
                result["status"] = "fail"
                result["gap"] = f"errore chiamata LLM: {exc}"
                result["attempts"] = attempts
                break

            parsed = parse_result(content)
            score = parsed.get("quality_score")
            has_stubs = bool(re.search(r"\b(TODO|stub|pass\s*#|NotImplemented)", content, re.IGNORECASE))
            issues = security_scan("\n".join(f.get("content", "") for f in parse_files_block(content)))
            final_score = apply_penalties(float(score) if score is not None else 0.0,
                                          has_stubs=has_stubs, security_issues=issues)

            files_out = parse_files_block(content)
            result.update({
                "quality_score": final_score,
                "attempts": attempts,
                "status": "pass" if (final_score >= self.threshold and files_out) else
                          ("pass" if final_score >= self.threshold and not files else "fail"),
                "files": [f["path"] for f in files_out],
                "gap": (parsed.get("gaps") or [None])[0] if parsed.get("gaps") else None,
            })

            # scrivi i file (solo se supera la soglia o è l'ultimo tentativo)
            if files_out and (result["status"] == "pass" or attempts > self.max_retries):
                for f in files_out:
                    self.store.write_file(self.project, f["path"], f["content"])
                self._record_files(files_out)
                result["modified_paths"] = [f["path"] for f in files_out]

            if result["status"] == "pass":
                # verifica per-task del risultato (se execution abilitata)
                if self.execution_enabled:
                    from harness.execution import ProjectRunner
                    runner = ProjectRunner()
                    ver = runner.run_verification(
                        self._workspace(),
                        timeout_s=self.execution_timeout_s,
                        enabled=True,
                    )
                    result["verification"] = {"success": ver["success"],
                                              "kind": ver["kind"],
                                              "returncode": ver["returncode"]}
                    if not ver["success"] and attempts <= self.max_retries:
                        # verification failure → feed error al retry/fix
                        result["status"] = "fail"
                        last_gap = f"verification failed: rc={ver['returncode']} stderr={ver['stderr'][:200]}"
                else:
                    result["verification"] = None
            if result["status"] == "pass":
                break
            last_gap = (parsed.get("gaps") or [None])[0] if parsed.get("gaps") else \
                f"score {final_score:.1f} sotto soglia {self.threshold}"

        result.setdefault("modified_paths", [])
        return result

    def _record_files(self, files: list[dict]) -> None:
        for f in files:
            self._written_files.append({"path": f["path"]})


async def run_harness(llm, goal: str, project: Project, store: ProjectStore,
                      max_concurrent: int = 8, max_retries: int = 2,
                      threshold: float = DEFAULT_THRESHOLD,
                      git_enabled: bool = True, execution_enabled: bool = True,
                      execution_timeout_s: float = 120.0,
                      rollback_on_failure: bool = True,
                      cancel_event: Optional["asyncio.Event"] = None) -> dict:
    """Entry point: esegue il loop e ritorna il report."""
    h = HarnessRun(llm=llm, goal=goal, project=project, store=store,
                   max_concurrent=max_concurrent, max_retries=max_retries,
                   threshold=threshold, git_enabled=git_enabled,
                   execution_enabled=execution_enabled,
                   execution_timeout_s=execution_timeout_s,
                   rollback_on_failure=rollback_on_failure,
                   cancel_event=cancel_event)
    return await h.run()
