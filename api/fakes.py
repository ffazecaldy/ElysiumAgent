"""api/fakes.py — oggetti fake deterministici per i test (modalità test).

MAI rete, MAI subprocess reali. Separati da tests/ perché il package `tests`
può entrare in conflitto di namespace con altri venv.
"""
from __future__ import annotations


class FakeLLM:
    def __init__(self, content: str = "```python\ndef solve():\n    return 42\n```"):
        self.content = content
        self.i = 0

    async def complete(self, messages, **k):
        self.i += 1
        return {"choices": [{"message": {"content": self.content}}]}


class FakeBar:
    """Barra fake deterministica: vince dopo `lose_for` round (default: vince subito)."""

    def __init__(self, lose_for: int = 0, always_lose: bool = False):
        self.n = 0
        self.lose_for = lose_for
        self.always_lose = always_lose

    def evaluate(self, workspace):
        self.n += 1
        win = not self.always_lose and self.n > self.lose_for
        return {
            "win": win,
            "passed": 1 if win else 0,
            "failed": 0 if win else 1,
            "detail": f"fake round {self.n}",
            "n": self.n,
        }
