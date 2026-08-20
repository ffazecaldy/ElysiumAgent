"""Test rapido nucleo harness con FakeLLM (senza rete)."""
import asyncio
import tempfile
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from harness.projects import ProjectStore
from harness.orchestrator import run_harness

FAKE_DECOMP = json.dumps([
    {"id": "t1", "description": "scrivi utils.py", "files": ["utils.py"], "interface_contract": None},
    {"id": "t2", "description": "scrivi main.py che usa utils", "files": ["main.py"], "interface_contract": "usa utils.helper()"},
])


class FakeLLM:
    def __init__(self):
        self.i = 0

    async def complete(self, messages, max_tokens=None):
        self.i += 1
        if self.i == 1:  # decompose
            content = "```json\n" + FAKE_DECOMP + "\n```"
        else:
            tid = "t1" if self.i == 2 else "t2"
            content = f"""## RESULT
- task_id: {tid}
- status: pass
- quality_score: 8/10

## FILES
### FILE: {('utils.py' if tid=='t1' else 'main.py')}
```python
def helper(x):
    return x + 1
```"""
        return {"choices": [{"message": {"content": content}}]}


async def main():
    store = ProjectStore(root=tempfile.mkdtemp())
    p = store.create("prova")
    report = await run_harness(FakeLLM(), "refactor sistema auth con API e test", p, store)
    print(json.dumps(report, indent=1, ensure_ascii=False))
    print("FILES:", store.list_files(p))


if __name__ == "__main__":
    asyncio.run(main())
