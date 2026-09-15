"""engine/decompose.py — decomposizione del goal via LLM + validazione strutturale.

Il MODELLO propone (è il lavoro intellettuale: la decomposizione), PYTHON valida
(Phase 2e). Mai decomposizione hardcoded. Validazione deterministica:
- output JSON valido con id/description/files/interface_contract
- nessun conflitto di file tra task
- count <= available_slots
"""
from __future__ import annotations

import json
import re
from typing import Any, Protocol

DECOMPOSE_PROMPT = """Sei il modulo di decomposizione di un motore di ottimizzazione codice.
Goal: {goal}
Slot disponibili: {available_slots}

Suddividi il goal in task atomici e indipendenti (al massimo {available_slots}),
ognuno con file DISGIUNTI (nessun file condiviso tra task).

Rispondi SOLO con JSON valido, array di oggetti:
[{{"id": "t1", "description": "...", "files": ["path.py"], "interface_contract": "firma pubblica chiamata dagli altri task (o null)"}}]
"""


class DecompositionError(Exception):
    """Validazione strutturale fallita (conflitto file, over-slot, JSON invalido)."""


class LLMProtocol(Protocol):
    async def complete(self, messages: list[dict], max_tokens: int | None = None) -> dict: ...


async def decompose(goal: str, llm: LLMProtocol, available_slots: int) -> list[dict]:
    """Chiede al modello la decomposizione e la valida deterministicamente."""
    prompt = DECOMPOSE_PROMPT.format(goal=goal, available_slots=available_slots)
    resp = await llm.complete([{"role": "user", "content": prompt}], max_tokens=4000)
    content = resp["choices"][0]["message"]["content"]

    # estrai il blocco JSON (il modello può racchiuderlo in markdown ```json ... ```)
    m = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", content, re.DOTALL)
    raw = m.group(1) if m else content
    # trova il primo '[' e l'ultimo ']' (robusto a testo attorno)
    start, end = raw.find("["), raw.rfind("]")
    if start == -1 or end == -1:
        raise DecompositionError(f"nessun array JSON nell'output: {content[:200]}")
    try:
        tasks = json.loads(raw[start : end + 1])
    except json.JSONDecodeError as exc:
        raise DecompositionError(f"JSON invalido: {exc}") from exc

    if not isinstance(tasks, list) or not tasks:
        raise DecompositionError("decomposizione vuota o non array")

    # validazione struttura
    seen_files: dict[str, str] = {}
    for t in tasks:
        if not all(k in t for k in ("id", "description", "files")):
            raise DecompositionError("task mancante di campi obbligatori (id/description/files)")
        for f in t.get("files", []) or []:
            if f in seen_files:
                raise DecompositionError(
                    f"conflitto file '{f}' tra {seen_files[f]} e {t['id']} (Phase 2e)")
            seen_files[f] = t["id"]

    if len(tasks) > available_slots:
        raise DecompositionError(
            f"{len(tasks)} task > {available_slots} slot disponibili (Phase 2e)")

    return tasks
