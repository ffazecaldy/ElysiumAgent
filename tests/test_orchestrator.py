"""Test del harness/orchestrator.py — loop multi-agente.

Copre:
- parse_files_block: estrazione del blocco ## FILES (caso normale e vuoto)
- run_harness end-to-end con LLM fake: decompose -> scatter -> gate -> file su disco
- retry automatico sotto soglia di qualità
- qualità sotto soglia NON passa anche se produce file
"""
import asyncio

import pytest

from harness.orchestrator import parse_files_block, run_harness, HarnessRun
from harness.projects import ProjectStore

TXT = """## RESULT\n- task_id: t1\n- status: pass\n- quality_score: 8/10\n\n## FILES\n### FILE: app/mod.py\n```python\nx = 1\n```\n### FILE: app/t.py\n```\ny = 2\n```"""


def test_parse_files_block_estrazione():
    files = parse_files_block(TXT)
    assert len(files) == 2
    assert files[0]["path"] == "app/mod.py" and "x = 1" in files[0]["content"]


def test_parse_files_block_vuoto():
    assert parse_files_block("nessun file") == []


class FakeLLM:
    def __init__(self, decomp, worker):
        self.i = 0
        self.decomp = decomp
        self.worker = worker

    async def complete(self, messages, max_tokens=None):
        self.i += 1
        if self.i == 1:
            return {"choices": [{"message": {"content": "```json\n" + self.decomp + "\n```"}}]}
        return {"choices": [{"message": {"content": self.worker}}]}


DECOMP = '[{"id":"t1","description":"scrivi a.py","files":["a.py"],"interface_contract":null},{"id":"t2","description":"scrivi b.py","files":["b.py"],"interface_contract":null}]'


async def test_run_harness_completo(tmp_path):
    s = ProjectStore(root=str(tmp_path))
    p = s.create("p")
    worker = """## RESULT\n- task_id: t\n- status: pass\n- quality_score: 8/10\n\n## FILES\n### FILE: a.py\n```python\nA=1\n```\n### FILE: b.py\n```python\nB=2\n```"""
    llm = FakeLLM(DECOMP, worker)
    rep = await run_harness(llm, "refactor sistema auth con API e test", p, s, max_retries=2)
    assert rep["final_status"] == "completed"
    assert rep["n_tasks"] == 2 and rep["n_passed"] == 2
    assert rep["first_pass_rate"] == 1.0
    assert any(f["path"] == "a.py" for f in s.list_files(p))


async def test_run_harness_retry_sotto_soglia(tmp_path):
    s = ProjectStore(root=str(tmp_path))
    p = s.create("p2")

    class RetryLLM:
        def __init__(self):
            self.i = 0

        async def complete(self, messages, max_tokens=None):
            self.i += 1
            if self.i == 1:
                return {"choices": [{"message": {"content": "```json\n" + DECOMP + "\n```"}}]}
            if self.i == 2:  # primo worker sotto soglia
                return {"choices": [{"message": {"content": "## RESULT\n- task_id: t1\n- status: fail\n- quality_score: 3/10\n- gaps: [implementa davvero]\n\n## FILES\n### FILE: a.py\n```python\nx=1\n```"}}]}
            return {"choices": [{"message": {"content": "## RESULT\n- task_id: t1\n- status: pass\n- quality_score: 8/10\n\n## FILES\n### FILE: a.py\n```python\nX=1\n```"}}]}

    rep = await run_harness(RetryLLM(), "goal multi-file", p, s, max_retries=2)
    assert rep["n_tasks"] == 2
    # almeno un task ha avuto retry: attempts>1
    assert any(t["attempts"] > 1 for t in rep["tasks"])


async def test_parse_quality_score_sotto_soglia_non_passa(tmp_path):
    # score 3/10 < threshold 7 -> status fail anche se produce file
    s = ProjectStore(root=str(tmp_path))
    p = s.create("p3")

    class LowLLM:
        def __init__(self):
            self.i = 0

        async def complete(self, messages, max_tokens=None):
            self.i += 1
            if self.i == 1:
                return {"choices": [{"message": {"content": "```json\n" + DECOMP + "\n```"}}]}
            return {"choices": [{"message": {"content": "## RESULT\n- task_id: t\n- status: fail\n- quality_score: 3/10\n\n## FILES\n### FILE: a.py\n```python\nX=1\n```"}}]}

    rep = await run_harness(LowLLM(), "goal", p, s, max_retries=1)
    assert any(t["status"] == "fail" for t in rep["tasks"])
