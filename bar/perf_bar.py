"""bar/perf_bar.py — barra esterna: runtime (perf_counter) + memoria (tracemalloc).

Misura N esecuzioni per versione e usa la MEDIANA (mai un singolo campione:
in ambiente condiviso/virtualizzato una misura singola è rumore). La barra
deve essere difendibile.
"""
from __future__ import annotations

import json
import statistics
import subprocess
import sys
import textwrap
from typing import Optional

# wrapper che esegue lo script sotto tracemalloc e stampa JSON con durata e picco memoria
_WRAPPER = textwrap.dedent("""
    import json, time, tracemalloc, sys, runpy
    tracemalloc.start()
    t0 = time.perf_counter()
    runpy.run_path(sys.argv[1], run_name="__main__")
    dt = time.perf_counter() - t0
    # prende più campioni di picco: tracemalloc.get_traced_memory() -> (current, peak)
    _, peak = tracemalloc.get_traced_memory()
    print(json.dumps({"duration_s": dt, "peak_mem_b": peak, "rc": 0}))
""")


class PerfBar:
    def __init__(self, target_runtime_s: float = 0.5, iterations: int = 5):
        self.target_runtime_s = target_runtime_s
        self.iterations = iterations

    def _run_once(self, script: str):
        cmd = [sys.executable, "-c", _WRAPPER, script]
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        for line in proc.stdout.splitlines():
            try:
                data = json.loads(line)
                if isinstance(data, dict) and "duration_s" in data:
                    return data
            except json.JSONDecodeError:
                continue
        return {"duration_s": float("inf"), "peak_mem_b": None, "rc": proc.returncode}

    def evaluate(self, baseline_script: str, candidate_script: str) -> dict:
        """Esegue entrambi N volte, ritorna mediana di runtime + picco memoria."""
        b_runs, c_runs = [], []
        b_mem, c_mem = [], []
        for _ in range(self.iterations):
            b_runs.append(self._run_once(baseline_script))
            c_runs.append(self._run_once(candidate_script))

        def _median(xs, key):
            vals = [x.get(key) for x in xs if x.get(key) is not None and x.get(key) != float("inf")]
            return statistics.median(vals) if vals else None

        b = _median(b_runs, "duration_s")
        c = _median(c_runs, "duration_s")
        bm = _median(b_runs, "peak_mem_b")
        cm = _median(c_runs, "peak_mem_b")

        win = c is not None and b is not None and c < b
        speedup = (b / c) if (b and c) else None

        return {
            "baseline": b,          # mediana baseline sec
            "candidate": c,         # mediana candidate sec
            "win": win,
            "speedup_x": round(speedup, 3) if speedup else None,
            "target_runtime_s": self.target_runtime_s,
            "n_runs": self.iterations,
            "mem_baseline_b": bm,
            "mem_candidate_b": cm,
        }
