"""sandbox/runner.py — esecuzione sicura di codice Python.

Risolve il collo di bottiglia SWE-bench: senza sandbox le patch non si verificano.
v1 = subprocess + timeout + tmpdir isolato (Docker opzionale in v2).
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import time
from dataclasses import dataclass, field

if os.name == "nt":
    _CREATE_NO_WINDOW = 0x08000000
else:
    _CREATE_NO_WINDOW = 0


@dataclass
class RunResult:
    stdout: str = ""
    stderr: str = ""
    returncode: int = -1
    timed_out: bool = False
    duration_s: float = 0.0
    workdir: str = ""

    def as_dict(self) -> dict:
        return {
            "stdout": self.stdout,
            "stderr": self.stderr,
            "returncode": self.returncode,
            "timed_out": self.timed_out,
            "duration_s": round(self.duration_s, 4),
            "workdir": self.workdir,
        }


async def run_code(
    code: str,
    timeout: float = 60,
    cwd: str | None = None,
    extra_args: list[str] | None = None,
) -> RunResult:
    """Esegue `code` in un subprocess Python con tmpdir isolato e timeout.

    Su timeout il processo viene killato e timed_out=True.
    """
    created_tmp = False
    if cwd is None:
        cwd = tempfile.mkdtemp(prefix="sandbox_")
        created_tmp = True

    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        code,
        *(extra_args or []),
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=_CREATE_NO_WINDOW if os.name == "nt" else 0,
    )

    t0 = time.perf_counter()
    result = RunResult(workdir=cwd)
    try:
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            result.returncode = proc.returncode or 0
        except asyncio.TimeoutError:
            result.timed_out = True
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            stdout_b, stderr_b = await proc.communicate()
            result.returncode = proc.returncode if proc.returncode is not None else -9
    finally:
        result.duration_s = time.perf_counter() - t0
        result.stdout = stdout_b.decode("utf-8", errors="replace")
        result.stderr = stderr_b.decode("utf-8", errors="replace")

    if created_tmp:
        import shutil
        shutil.rmtree(cwd, ignore_errors=True)

    return result
