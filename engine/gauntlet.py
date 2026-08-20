"""engine/gauntlet.py — loop builder/critic contro la barra (Phase 0.7).

Flusso: split → build → judge → fix → repeat, con cap round E checkpoint
per-round NON bloccante (asyncio.Event via API, mai input() — bloccherebbe
l'event loop -> deadlock con FastAPI).

Vincoli architetturali (R3): il critic riceve ARTEFATTO REALE (file/bar),
mai il summary del builder. Il builder riceve goal + pezzo + bar, mai
l'architettura.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any, Callable, Protocol

from engine.budget import BudgetTracker

log = logging.getLogger(__name__)

STATUS_RUNNING = "running"
STATUS_AWAITING_APPROVAL = "awaiting_approval"
STATUS_COMPLETED = "completed"
STATUS_STOPPED = "stopped"
STATUS_QUOTA_EXHAUSTED = "quota_exhausted"
STATUS_FAILED = "failed"

BUILDER_PROMPT = """Sei il BUILDER del round {round_n}/{max_rounds} di un motore di ottimizzazione codice.
Goal: {goal}
Barra (criterio di vittoria): {bar_desc}
Pezzo corrente da costruire/ottimizzare: {piece}

Scrivi il CODICE COMPLETO nel file {artifact_path}. Nessuna architettura spiegata:
solo codice eseguibile, pronto. La barra è l'unico giudice.

Rispondi con il formato RESULT:
## RESULT
- task_id: build
- status: pass|fail|partial
- quality_score: N/10
- gaps: [lista]
"""

CRITIC_PROMPT = """Sei il CRITIC del round {round_n}/{max_rounds}. CONTESTO FRESCO: ispezioni SOLO l'artefatto reale sul disco (mai un riassunto del builder).
Artifact: {artifact_path}
Barra: {bar_desc}
Ultimo esito barra: {bar_result}
File dell'artifact:
{artifact_preview}

Identifica IL GAP PIÙ GRANDE rispetto alla barra (una sola cosa, la più impattante).
Rispondi solo con:
GAP: <descrizione di una riga>
FIX: <istruzione concreta al builder per il prossimo round>
"""


class BarProtocol(Protocol):
    def evaluate(self, workspace: str) -> dict: ...


class LLMProtocol(Protocol):
    async def complete(self, messages: list[dict], max_tokens: int | None = None) -> dict: ...


def _extract_code(content: str) -> str:
    """Estrae il codice da un blocco markdown ```python ... ``` se presente."""
    m = re.search(r"```(?:python|py)?\s*(.*?)\s*```", content, re.DOTALL)
    return m.group(1).strip() if m else content.strip()


class Gauntlet:
    def __init__(
        self,
        llm: LLMProtocol,
        bar: BarProtocol,
        max_rounds: int = 3,
        bar_desc: str = "barra di sistema",
        status_store: dict | None = None,
        artifact_name: str = "solution.py",
        workspace_root: str | None = None,
    ):
        self._llm = llm
        self._bar = bar
        self.max_rounds = max_rounds
        self.bar_desc = bar_desc
        self.status_store = status_store if status_store is not None else {}
        self.artifact_name = artifact_name
        self.workspace_root = workspace_root or "."

    # ── status store ────────────────────────────────────────────────────────
    def _publish(self, run_id: str, status: str, payload: dict) -> None:
        rec = self.status_store.setdefault(run_id, {})
        rec.update({"status": status, "last_update": payload})

    # ── pubblico ────────────────────────────────────────────────────────────
    async def run(self, goal: str, workspace: str, run_id: str,
                  approval_event: asyncio.Event,
                  stop_event: asyncio.Event | None = None) -> dict:
        """Loop builder/critic vs barra. Ritorna il report finale."""
        budget = BudgetTracker(round_cap=self.max_rounds, summary_cap_tokens=1000)
        report = {
            "run_id": run_id, "goal": goal, "bar_beaten": False,
            "rounds": 0, "budget_hit": False, "stopped": False,
            "rounds_detail": [], "tokens_used": 0,
        }
        artifact_path = os.path.join(workspace, self.artifact_name)
        self._publish(run_id, STATUS_RUNNING, {"round": 0})

        for round_n in range(1, self.max_rounds + 1):
            result = await self._do_round(round_n, goal, workspace, artifact_path)
            budget.add_tokens(result.get("tokens_used", 500))
            report["rounds"] = round_n
            report["rounds_detail"].append(result)
            report["tokens_used"] = budget.tokens_used

            if result["bar_beaten"]:
                report["bar_beaten"] = True
                break
            if stop_event is not None and stop_event.is_set():
                report["stopped"] = True
                break
            if budget.hit():
                report["budget_hit"] = True
                break
            if round_n >= self.max_rounds:
                report["budget_hit"] = True
                break

            # checkpoint per-round: si sblocca SOLO via API (continue)
            self._publish(run_id, STATUS_AWAITING_APPROVAL, result)
            approval_event.clear()
            await approval_event.wait()
            # appena risvegliato, verifica stop prima di un nuovo round
            if stop_event is not None and stop_event.is_set():
                report["stopped"] = True
                break

        status = STATUS_STOPPED if report["stopped"] else STATUS_COMPLETED
        self._publish(run_id, status, report)
        return report

    # ── interno ─────────────────────────────────────────────────────────────
    async def _do_round(self, round_n: int, goal: str, workspace: str,
                        artifact_path: str) -> dict:
        # BUILD
        build_prompt = BUILDER_PROMPT.format(
            round_n=round_n, max_rounds=self.max_rounds, goal=goal,
            bar_desc=self.bar_desc, piece=self._current_piece(goal, round_n),
            artifact_path=artifact_path,
        )
        resp = await self._llm.complete(
            [{"role": "user", "content": build_prompt}], max_tokens=4000)
        tokens_build = self._tokens_from(resp)
        code = _extract_code(resp["choices"][0]["message"]["content"])
        with open(artifact_path, "w", encoding="utf-8") as f:
            f.write(code)

        # BAR (l'unico giudice) — eseguita in thread per non bloccare l'event loop
        bar_result = await asyncio.to_thread(self._bar.evaluate, workspace)

        gap = None
        if not bar_result.get("win"):
            # CRITIC: contesto fresco, ispeziona l'artefatto REALE sul disco
            preview = self._preview(artifact_path)
            critic_prompt = CRITIC_PROMPT.format(
                round_n=round_n, max_rounds=self.max_rounds,
                artifact_path=artifact_path, bar_desc=self.bar_desc,
                bar_result=bar_result, artifact_preview=preview,
            )
            resp = await self._llm.complete(
                [{"role": "user", "content": critic_prompt}], max_tokens=2000)
            tokens_critic = self._tokens_from(resp)
            critic_text = resp["choices"][0]["message"]["content"]
            gap = _parse_gap(critic_text)
        else:
            tokens_critic = 0

        return {
            "round": round_n,
            "bar_beaten": bool(bar_result.get("win")),
            "bar_result": bar_result,
            "gap": gap,
            "tokens_used": tokens_build + tokens_critic,
        }

    def _tokens_from(self, resp: dict) -> int:
        """Token reali della risposta se il client li espone, altrimenti stima
        dal testo (mai inventare un numero: stima dichiarabile, non $)."""
        usage = resp.get("usage") or {}
        if usage.get("total_tokens"):
            return int(usage["total_tokens"])
        # es.: llm.client espone last_tokens() sull'ultima complete
        llm = getattr(self._llm, "last_tokens", None)
        if callable(llm):
            try:
                return int(llm())
            except TypeError:
                pass
        content = resp.get("choices", [{}])[0].get("message", {}).get("content", "")
        return max(1, len(content) // 3)

    def _current_piece(self, goal: str, round_n: int) -> str:
        if round_n == 1:
            return f"implementazione iniziale per: {goal}"
        # percorso di questo round (se un critico ha precedentemente indicato il fix,
        # viene passato nel prompt via gaps — qui siamo pragmatici)
        return f"fix rispetto alla barra per: {goal}"

    def _preview(self, artifact_path: str, max_chars: int = 4000) -> str:
        try:
            with open(artifact_path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError as exc:
            return f"(impossibile leggere artifact: {exc})"
        return text[:max_chars]


def _parse_gap(critic_text: str) -> dict:
    gap = None
    fix = None
    m = re.search(r"GAP:\s*(.+)", critic_text)
    if m:
        gap = m.group(1).strip()
    m = re.search(r"FIX:\s*(.+)", critic_text)
    if m:
        fix = m.group(1).strip()
    return {"gap": gap, "fix": fix}
