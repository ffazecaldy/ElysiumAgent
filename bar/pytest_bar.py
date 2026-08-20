"""bar/pytest_bar.py — barra esterna: test pass + coverage target.

Decide win/loss: win = tutti i test del workspace passano.
La barra è il cuore del prodotto: nessun round si chiude senza risultato
misurabile e verificabile a mano.
"""
from __future__ import annotations

import subprocess
import sys
from typing import Optional


class PytestBar:
    def __init__(self, test_dir: str = "tests", rootdir: Optional[str] = None):
        self.test_dir = test_dir
        self.rootdir = rootdir

    def evaluate(self, workspace: str) -> dict:
        """Esegue pytest sul workspace. Ritorna {'win', 'passed', 'failed', 'detail'}."""
        cmd = [sys.executable, "-m", "pytest", workspace, "-q", "--no-header", "-p", "no:cacheprovider"]
        if self.rootdir:
            cmd += ["--rootdir", self.rootdir]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=120,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        except subprocess.TimeoutExpired:
            return {"win": False, "passed": 0, "failed": 1, "detail": "pytest timeout (120s)"}

        out = proc.stdout + proc.stderr
        passed = failed = 0
        # parsa "N passed" / "M failed" dall'output pytest
        import re
        m = re.search(r"(\d+) passed", out)
        if m:
            passed = int(m.group(1))
        m = re.search(r"(\d+) failed", out)
        if m:
            failed = int(m.group(1))
        # errore di raccolta -> niente numeri, win=False
        win = proc.returncode == 0 and failed == 0 and passed > 0
        detail = f"pytest rc={proc.returncode} | {passed} passed, {failed} failed"
        return {"win": win, "passed": passed, "failed": failed, "detail": detail}
