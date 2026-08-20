import pytest

from engine.decompose import decompose, DecompositionError
from engine.scatter import ScatterEngine

FAKE_DECOMP = '''[
  {"id":"t1","description":"ottimizza partizione","files":["sort.py"],"interface_contract":null},
  {"id":"t2","description":"test benchmark","files":["test_sort.py"],"interface_contract":"chiama sort(arr) -> list"}
]'''


class FakeLLM:
    def __init__(self, response):
        self._r = response

    async def complete(self, m, **k):
        return {"choices": [{"message": {"content": self._r}}]}


async def test_decompose_valida_output_llm():
    tasks = await decompose("ottimizza quicksort", FakeLLM(FAKE_DECOMP), available_slots=5)
    assert len(tasks) == 2
    assert all("files" in t for t in tasks)


async def test_decompose_rifiuta_conflitto_file():
    conflict = FAKE_DECOMP.replace('"test_sort.py"', '"sort.py"')  # due task stesso file
    with pytest.raises(DecompositionError):
        await decompose("x", FakeLLM(conflict), available_slots=5)


async def test_decompose_rifiuta_over_slot():
    with pytest.raises(DecompositionError):
        await decompose("x", FakeLLM(FAKE_DECOMP), available_slots=1)


async def test_decompose_rifiuta_json_invalido():
    with pytest.raises(DecompositionError):
        await decompose("x", FakeLLM("questo non è json"), available_slots=5)


class FakeDispatchLLM:
    def __init__(self):
        self.calls = 0

    async def complete(self, m, **k):
        self.calls += 1
        return {"choices": [{"message": {"content":
            "## RESULT\n- task_id: t\n- status: pass\n- quality_score: 8/10"}}]}


async def test_scatter_parallelo_raccoglie_tutti():
    llm = FakeDispatchLLM()
    engine = ScatterEngine(llm, max_concurrent=5)
    results = await engine.dispatch([{"id": "t1"}, {"id": "t2"}, {"id": "t3"}])
    assert len(results) == 3
    assert all(r["status"] == "pass" for r in results)


async def test_sotto_soglia_retry_immediato():
    class FlakyLLM:  # sotto soglia la prima volta, poi sopra
        def __init__(self):
            self.calls = 0

        async def complete(self, m, **k):
            self.calls += 1
            score = "4/10" if self.calls == 1 else "8/10"
            return {"choices": [{"message": {"content":
                f"## RESULT\n- task_id: t1\n- status: pass\n- quality_score: {score}"}}]}

    llm = FlakyLLM()
    engine = ScatterEngine(llm, max_concurrent=5, threshold=7.0, max_retries=1)
    results = await engine.dispatch([{"id": "t1"}])
    assert results[0]["quality_score"] == 8.0
    assert llm.calls == 2  # retry immediato eseguito
