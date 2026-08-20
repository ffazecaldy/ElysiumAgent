"""engine/scatter.py — dispatch parallelo asincrono dei task.

asyncio.gather con semaforo max_concurrent, parse via result_parser (DRY, Task 2),
retry immediato sotto soglia (Phase 2d): il primo risultato sotto soglia viene
ritentato senza aspettare la fine del batch.
"""
from __future__ import annotations

import asyncio
from typing import Any, Protocol

from engine.result_parser import parse_result

DISPATCH_PROMPT = """Sei uno dei {total} agenti paralleli di un motore di ottimizzazione codice.
Task ID: {task_id}
Descrizione: {description}
File: {files}
Grado richiesto: implementa COMPLETAMENTE (no stub/TODO), self-verifica, correggi se sotto soglia.
Rispondi con il formato RESULT:
## RESULT
- task_id: {task_id}
- status: pass|fail|partial
- quality_score: N/10
- gaps: [lista]
- files_created: [path]
"""


class LLMProtocol(Protocol):
    async def complete(self, messages: list[dict], max_tokens: int | None = None) -> dict: ...


class ScatterEngine:
    def __init__(self, llm: LLMProtocol, max_concurrent: int = 10,
                 threshold: float = 7.0, max_retries: int = 2):
        self._llm = llm
        self.max_concurrent = max_concurrent
        self.threshold = threshold
        self.max_retries = max_retries

    async def _dispatch_one(self, task: dict) -> dict:
        prompt = DISPATCH_PROMPT.format(
            task_id=task.get("id", "?"),
            description=task.get("description", ""),
            files=", ".join(task.get("files", []) or []),
            total=task.get("_total", "?"),
        )
        attempts = 0
        while True:
            attempts += 1
            resp = await self._llm.complete([{"role": "user", "content": prompt}], max_tokens=4000)
            content = resp["choices"][0]["message"]["content"]
            result = parse_result(content)
            result["task_id"] = task.get("id", result.get("task_id"))
            result["attempts"] = attempts
            # status fail -> non ritentare a meno che il modello non dica partial sotto soglia
            if (result.get("quality_score") is not None
                    and result["quality_score"] >= self.threshold):
                return result
            if attempts > self.max_retries:
                return result  # reso così com'è: il quality gate deciderà
            # retry immediato sotto soglia (Phase 2d), con feedback
            if result.get("gaps"):
                prompt = prompt + (
                    f"\n\nFEEDBACK (tentativo {attempts}): sotto soglia ({result['quality_score']}/10). "
                    f"Gap da correggere: {', '.join(result['gaps'])}"
                )

    async def dispatch(self, tasks: list[dict]) -> list[dict]:
        sem = asyncio.Semaphore(self.max_concurrent)
        total = len(tasks)

        async def _worker(task: dict) -> dict:
            async with sem:
                return await self._dispatch_one(task)

        results = await asyncio.gather(*(_worker(t) for t in tasks))
        return list(results)
