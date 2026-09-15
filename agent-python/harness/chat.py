"""harness/chat.py — agente chat per progetto: risposta diretta o loop Elysium.

L'agente ha una conversazione persistente per progetto. Su ogni messaggio:
1. decide() applica il 4-Band Filter (engine/state.py):
   - tier 1 → risposta diretta (LLM, streaming)
   - tier 2+ → se il goal è esplicito, attiva il loop multi-agente (orchestrator)
2. La risposta viene salvata in chat.json con metadati (report del loop se eseguito).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from engine.state import detect_tier
from harness.run_state import RunRegistry
from harness.orchestrator import SYSTEM_PROMPT, run_harness
from harness.projects import Project, ProjectStore

log = logging.getLogger(__name__)

# Goal che attivano il loop multi-agente per default (tier 2+).
# Il rilevamento è automatico: tier = detect_tier(goal).
# L'utente può forzare con prefissi espliciti.
FORCE_LOOP_HINTS = ("attiva elysium", "elysium", "swarmloop", "fai il loop",
                    "usa gli agenti", "multi-agente", "decomp")


def wants_loop(goal: str) -> bool:
    tier = detect_tier(goal)
    if tier >= 2:
        return True
    low = goal.lower()
    return any(h in low for h in FORCE_LOOP_HINTS)


def build_messages(chat: list[dict], system: str = SYSTEM_PROMPT,
                   max_history: int = 12) -> list[dict]:
    """Conversione cronologia in messaggi per l'LLM (ultimi N, esclusi report)."""
    out: list[dict] = [{"role": "system", "content": system}]
    for msg in chat[-max_history:]:
        content = msg.get("content", "")
        meta = msg.get("meta") or {}
        if meta.get("run_report"):
            # il report del loop viene compresso in una nota di contesto
            r = meta["run_report"]
            content += (f"\n\n[stato loop precedente] status={r.get('final_status')} "
                        f"first_pass={r.get('first_pass_rate')} "
                        f"qualità={r.get('avg_quality')} task={r.get('n_tasks')} "
                        f"file={[f.get('path') for f in r.get('files_written', [])]}")
        out.append({"role": msg.get("role", "user"), "content": content})
    return out


_run_registry = RunRegistry()


class ChatAgent:
    """Assistente conversazionale per un progetto."""

    def __init__(self, llm, project: Project, store: ProjectStore,
                 max_concurrent: int = 8, max_retries: int = 2,
                 git_enabled: bool = True, execution_enabled: bool = True):
        self._llm = llm
        self.project = project
        self.store = store
        self.max_concurrent = max_concurrent
        self.max_retries = max_retries
        self.git_enabled = git_enabled
        self.execution_enabled = execution_enabled

    async def respond_stream(self, user_text: str):
        """Processa un messaggio utente; yield eventi di progresso e risposta.

        Eventi:
          {"type": "loop", "goal":..., "tier":...}   → loop attivato
          {"type": "report", "report": {...}}        → report loop
          {"type": "chunk", "text": ...}             → chunk streaming (risposta diretta)
          {"type": "done", "final": {...}}           → fine
        """
        self.store.append_message(self.project, "user", user_text)

        if wants_loop(user_text):
            # attiva il loop multi-agente Elysium
            yield {"type": "loop", "goal": user_text, "tier": detect_tier(user_text)}
            try:
                run_id = uuid.uuid4().hex[:8]
                cancel_event = _run_registry.register(self.project.pid, run_id).cancel_event
                report = await run_harness(
                    llm=self._llm, goal=user_text, project=self.project,
                    store=self.store, max_concurrent=self.max_concurrent,
                    max_retries=self.max_retries,
                    git_enabled=self.git_enabled,
                    execution_enabled=self.execution_enabled,
                    cancel_event=cancel_event,
                )
                report["run_id"] = run_id
                _run_registry.forget(self.project.pid, run_id)
                self.store.append_message(
                    self.project, "assistant",
                    _format_report(report),
                    meta={"run_report": report},
                )
                yield {"type": "report", "report": report}
                yield {"type": "done", "final": {"kind": "loop", "report": report}}
                return
            except Exception as exc:  # noqa: BLE001
                log.exception("loop fallito per %r", user_text)
                yield {"type": "error", "detail": str(exc)}
                yield {"type": "done", "final": {"kind": "error", "detail": str(exc)}}
                return

        # risposta diretta (tier 1) — streaming
        chat = self.store.read_chat(self.project)
        messages = build_messages(chat)
        full = ""
        try:
            async for piece in self._llm.stream(messages):
                full += piece
                yield {"type": "chunk", "text": piece}
        except Exception as exc:  # noqa: BLE001
            log.exception("chat diretta fallita")
            yield {"type": "error", "detail": str(exc)}
        self.store.append_message(self.project, "assistant", full)
        yield {"type": "done", "final": {"kind": "chat", "content": full}}


def _format_report(r: dict) -> str:
    return (f"## ✅ {r.get('goal', '')}\n"
            f"- Agenti: {r.get('n_tasks', 0)} | first-pass {int((r.get('first_pass_rate') or 0) * 100)}% "
            f"| qualità {r.get('avg_quality', 0)}/10\n"
            f"- Task passati: {r.get('n_passed', 0)}/{r.get('n_tasks', 0)} "
            f"| stato: {r.get('final_status')}\n"
            f"- File: {', '.join(f.get('path', '') for f in r.get('files_written', [])) or '(nessuno)'}\n"
            f"- Token (stima): {r.get('tokens_estimate', 0)}")
