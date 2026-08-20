"""scripts/e2e_real.py — Task 10: dimostra il valore su 3 problemi reali.

Ogni problema: workspace con baseline + test (correttezza E performance),
il Gauntlet (builder/critic + barra reale) deve battere la barra.
Report JSON salvati in results/<problema>.json — nessun numero inventato:
tutto misurabile a mano rieseguendo le barre.

Provider: OpenAI-compatible. Default OpenRouter (deepseek economico) perché
il provider opencode-go del piano è in quota esaurita (R1). Override via env.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bar.pytest_bar import PytestBar  # noqa: E402
from engine.gauntlet import Gauntlet, STATUS_AWAITING_APPROVAL  # noqa: E402
from llm.client import LLMClient  # noqa: E402

RESULTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "results")


def _openrouter_key() -> str:
    for p in [r'C:/Users/Admin/.local/share/opencode/auth.json']:
        try:
            d = json.load(open(p, encoding='utf-8'))
            e = d.get('openrouter') or {}
            if e.get('key'):
                return e['key']
        except Exception:
            continue
    return os.environ.get('OPENROUTER_API_KEY', '')


def _llm() -> LLMClient:
    key = _openrouter_key()
    base = os.environ.get("OPTIMIZE_ENGINE_BASE_URL", "https://openrouter.ai/api/v1")
    model = os.environ.get("OPTIMIZE_ENGINE_MODEL", "deepseek/deepseek-chat-v3-0324")
    return LLMClient(base_url=base, api_key=key, model=model, timeout_s=180, max_retries=2)


def _write(ws: str, name: str, content: str) -> str:
    os.makedirs(ws, exist_ok=True)
    path = os.path.join(ws, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path


# ── Problema 1: sort naive O(n²) → ottimizzato (PerfBar via test con soglia) ──
PROB1_WS = "prob1_sort"
PROB1_TEST = '''import time
import solution


def test_sort_corretto():
    data = list(range(3000, 0, -1))
    assert solution.sort(data) == sorted(data)


def test_sort_veloce():
    data = list(range(15000, 0, -1))
    t0 = time.perf_counter()
    solution.sort(data)
    dt = time.perf_counter() - t0
    assert dt < 1.5, f"troppo lento: {dt:.3f}s"
'''
PROB1_GOAL = "ottimizza l'algoritmo di ordinamento: la versione corrente è O(n^2) (bubble sort), rendila almeno O(n log n) mantenendo l'interfaccia sort(list) -> list"

# ── Problema 2: ricerca duplicati O(n²) → O(n) ──────────────────────────────
PROB2_WS = "prob2_duplicati"
PROB2_TEST = '''import time
import solution


def test_duplicati_corretti():
    assert sorted(solution.find_duplicates([1, 2, 3, 2, 4, 3, 3])) == [2, 3]
    assert solution.find_duplicates([1, 2, 3]) == []


def test_duplicati_veloci():
    data = list(range(40000)) + [7, 7, 7]
    t0 = time.perf_counter()
    solution.find_duplicates(data)
    dt = time.perf_counter() - t0
    assert dt < 0.8, f"troppo lento: {dt:.3f}s (aspettavi O(n) o meglio)"
'''
PROB2_GOAL = "ottimizza l'algoritmo di ricerca duplicati: la versione corrente è O(n^2) con doppio loop, rendila O(n) con una hash table mantenendo l'interfaccia find_duplicates(list) -> list"

# ── Problema 3: analisi dati lenta (conteggi) → ottimizzata ─────────────────
PROB3_WS = "prob3_analisi"
PROB3_TEST = '''import time
import solution


def test_analisi_corretta():
    rows = [("a", 1), ("b", 2), ("a", 3)]
    out = solution.totals_by_key(rows)
    assert out["a"] == 4 and out["b"] == 2


def test_analisi_veloce():
    rows = [(f"k{i % 500}", i) for i in range(60000)]
    t0 = time.perf_counter()
    solution.totals_by_key(rows)
    dt = time.perf_counter() - t0
    assert dt < 1.0, f"troppo lento: {dt:.3f}s (usa un dict, non liste)"
'''
PROB3_GOAL = "ottimizza il calcolo dei totali per chiave: la versione corrente scandisce la lista per ogni chiave (O(n*k)), rendila O(n) con un dict mantenendo l'interfaccia totals_by_key(list of (chiave, valore)) -> dict"

PROBLEMS = [
    {"name": PROB1_WS, "goal": PROB1_GOAL, "test": PROB1_TEST,
     "baseline": "sorted_naive", "bench_cmd": "sort(15000 elementi)"},
    {"name": PROB2_WS, "goal": PROB2_GOAL, "test": PROB2_TEST,
     "baseline": "doppio loop O(n^2)", "bench_cmd": "find_duplicates(40000+3)"},
    {"name": PROB3_WS, "goal": PROB3_GOAL, "test": PROB3_TEST,
     "baseline": "scansione O(n*k)", "bench_cmd": "totals_by_key(60000 righe)"},
]


async def _approver(task, store, run_id, event):
    while not task.done():
        if store.get(run_id, {}).get("status") == STATUS_AWAITING_APPROVAL:
            event.set()
        await asyncio.sleep(0.02)


async def run_problem(p: dict, llm: LLMClient) -> dict:
    ws = os.path.join(".sandbox", "e2e", p["name"])
    _write(ws, "test_solution.py", p["test"])

    store: dict = {}
    event = asyncio.Event()
    bar = PytestBar(rootdir=ws)
    g = Gauntlet(
        llm=llm, bar=bar, max_rounds=3,
        bar_desc="PytestBar: correttezza + soglia tempo",
        status_store=store, workspace_root=ws,
    )
    task = asyncio.create_task(
        g.run(goal=p["goal"], workspace=ws, run_id=p["name"], approval_event=event))
    await _approver(task, store, p["name"], event)
    report = await asyncio.wait_for(task, timeout=600)

    report["goal"] = p["goal"]
    report["workspace"] = ws
    report["bar"] = "pytest (correttezza + soglia tempo)"
    report["baseline"] = p["baseline"]
    report["bench_cmd"] = p["bench_cmd"]
    return report


async def main() -> int:
    os.makedirs(RESULTS_DIR, exist_ok=True)
    llm = _llm()
    if not _openrouter_key():
        print("ERRORE: nessuna key OpenRouter trovata nel pool")
        return 2

    summary = []
    for p in PROBLEMS:
        print(f"\n=== PROBLEMA: {p['name']} ===")
        try:
            report = await run_problem(p, llm)
            out = os.path.join(RESULTS_DIR, f"{p['name']}.json")
            with open(out, "w", encoding="utf-8") as f:
                json.dump(report, f, indent=2, ensure_ascii=False)
            print(f"  bar_beaten={report.get('bar_beaten')} rounds={report.get('rounds')} "
                  f"tokens={report.get('tokens_used')} -> {out}")
            summary.append({"name": p["name"], "bar_beaten": report.get("bar_beaten"),
                            "rounds": report.get("rounds"), "tokens": report.get("tokens_used")})
        except Exception as e:  # noqa: BLE001
            print(f"  FALLITO: {type(e).__name__}: {str(e)[:200]}")
            summary.append({"name": p["name"], "error": str(e)[:200]})

    with open(os.path.join(RESULTS_DIR, "_summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print("\n=== SUMMARY ===")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
