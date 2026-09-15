"""harness/execution.py — execution runner: comandi nei workspace di progetto.

Runner subprocess ASINCRONO usato dall'harness per eseguire comandi reali
(test, build, git) dentro il workspace di un progetto. Sicurezza a livelli:

1. FORMA argv (lista): mai `shell=True` nel percorso principale → niente
   injection via metacaratteri.
2. ALLOWLIST eseguibili: solo tool di sviluppo (git, python, pytest, node...).
   I binari shell (cmd, powershell, bash, wscript...) sono sempre bloccati,
   anche se qualcuno li aggiunge all'allowlist.
3. TIMEOUT con kill + reaping, come sandbox/runner.py.
4. Nessun glob variabile d'ambiente: i comandi sono costruiti dal caller.

Stile coerente con sandbox/runner.py (RunResult/as_dict) e harness/projects.py
(controllo path traversal con normcase/normpath).
"""
from __future__ import annotations

import asyncio
import os
import shutil
import time
from dataclasses import dataclass, field
from typing import Optional, Sequence

if os.name == "nt":
    _CREATE_NO_WINDOW = 0x08000000
else:
    _CREATE_NO_WINDOW = 0

# tool di sviluppo ammessi di default (basename dell'eseguibile, minuscolo)
DEFAULT_ALLOWED = frozenset({
    "git", "python", "pip", "pytest", "node", "npm", "npx",
    "ruff", "mypy", "black", "eslint", "tsc",
})

# binari che consentono di aggirare l'allowlist eseguendo altro codice:
# bloccati SEMPRE, a prescindere dall'allowlist del caller.
_BLOCKED_ALWAYS = frozenset({
    "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
    "bash", "sh", "zsh", "dash", "ksh", "wscript", "wscript.exe",
    "cscript", "cscript.exe", "mshta", "mshta.exe", "rundll32",
    "rundll32.exe", "regsvr32", "regsvr32.exe", "certutil", "certutil.exe",
})

# cap sull'output conservato nei report (caratteri)
_MAX_OUTPUT_CHARS = 200_000

# codici di ritorno convenzionali per errori lato runner (non del processo)
RC_NOT_ALLOWED = 126
RC_NOT_FOUND = 127
RC_TIMEOUT = -9


@dataclass
class ExecResult:
    """Esito di un comando eseguito nel workspace."""

    argv: list[str] = field(default_factory=list)
    exit_code: int = -1
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    duration_s: float = 0.0
    cwd: str = ""

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out

    def as_dict(self) -> dict:
        return {
            "argv": self.argv,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "timed_out": self.timed_out,
            "duration_s": round(self.duration_s, 4),
            "cwd": self.cwd,
            "ok": self.ok,
        }


def _basename(executable: str) -> str:
    return os.path.splitext(os.path.basename(executable))[0].lower()


def _validate_workspace(cwd: str) -> Optional[ExecResult]:
    """Il workspace deve esistere ed essere una directory (niente cwd inventati)."""
    if not cwd or not os.path.isdir(cwd):
        return ExecResult(
            exit_code=RC_NOT_FOUND,
            stderr=f"workspace non trovato o non è una directory: {cwd}",
        )
    return None


def check_allowed(argv: Sequence[str], allowed: frozenset) -> Optional[str]:
    """Ritorna None se argv[0] è ammesso, altrimenti il motivo del rifiuto."""
    if not argv or not argv[0].strip():
        return "argv vuoto: serve almeno un eseguibile"
    base = _basename(argv[0])
    if base in _BLOCKED_ALWAYS:
        return f"eseguibile bloccato sempre: {argv[0]}"
    if base not in allowed:
        return f"eseguibile non in allowlist: {argv[0]}"
    return None


async def run_command(
    argv: Sequence[str],
    cwd: str,
    timeout: float = 120,
    allowed: Optional[frozenset] = None,
) -> ExecResult:
    """Esegue `argv` (forma lista, niente shell) dentro `cwd` con timeout.

    Ritorna SEMPRE un ExecResult: i rifiuti di policy (allowlist, workspace
    mancante) arrivano come risultato con exit_code 126/127, non come
    eccezione — così il caller del loop li può mettere nel report.
    """
    started = time.perf_counter()
    argv = [str(a) for a in argv]
    allowed = allowed if allowed is not None else DEFAULT_ALLOWED

    ws_err = _validate_workspace(cwd)
    if ws_err is not None:
        ws_err.argv = argv
        ws_err.duration_s = time.perf_counter() - started
        return ws_err

    reason = check_allowed(argv, allowed)
    if reason is not None:
        return ExecResult(argv=argv, exit_code=RC_NOT_ALLOWED, stderr=reason,
                          duration_s=time.perf_counter() - started, cwd=cwd)

    # risolve l'eseguibile sul PATH (git → C:\Program Files\Git\cmd\git.exe);
    # se non risolve e non è già un path, rifiuta senza tentare la shell.
    executable = shutil.which(argv[0]) or (
        argv[0] if os.path.isfile(argv[0]) else None
    )
    if executable is None:
        return ExecResult(argv=argv, exit_code=RC_NOT_FOUND,
                          stderr=f"eseguibile non trovato: {argv[0]}",
                          duration_s=time.perf_counter() - started, cwd=cwd)

    proc = await asyncio.create_subprocess_exec(
        executable, *argv[1:],
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=_CREATE_NO_WINDOW if os.name == "nt" else 0,
    )

    result = ExecResult(argv=argv, cwd=cwd)
    try:
        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(), timeout=timeout)
            result.exit_code = proc.returncode if proc.returncode is not None else -1
        except asyncio.TimeoutError:
            result.timed_out = True
            result.exit_code = RC_TIMEOUT
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            stdout_b, stderr_b = await proc.communicate()
            result.stderr = f"timeout dopo {timeout}s: processo killato"
    finally:
        result.duration_s = time.perf_counter() - started
        result.stdout = _cap((stdout_b or b"").decode("utf-8", errors="replace"))
        captured_err = (stderr_b or b"").decode("utf-8", errors="replace")
        if captured_err:
            result.stderr = (result.stderr + "\n" + captured_err).strip()
        result.stderr = _cap(result.stderr)

    return result


async def run_python(
    code: str,
    cwd: str,
    timeout: float = 120,
    python: str = "python",
) -> ExecResult:
    """Comodità: esegue codice Python nel workspace (python -c)."""
    return await run_command([python, "-c", code], cwd=cwd, timeout=timeout)


def _cap(text: str, limit: int = _MAX_OUTPUT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n...[output troncato a {limit} caratteri]"


# ── v0.16 facade: ProjectRunner ───────────────────────────────


# ── project-kind detection ────────────────────────────────────────

_DETECTION = (
    # (kind, marker file, argv template)
    ("python", "pytest.ini", (["python", "-m", "pytest", "-q"],)),
    ("python", "pyproject.toml", (["python", "-m", "pytest", "-q"],)),
    ("python", "setup.py", (["python", "-m", "pytest", "-q"],)),
    ("node", "package.json", (["npm", "test", "--silent"],)),
    ("rust", "Cargo.toml", (["cargo", "test", "--quiet"],)),
    ("go", "go.mod", (["go", "test", "./..."],)),
)


def detect_project(workspace: str) -> Optional[tuple[str, list[str]]]:
    """Rileva il tipo di progetto. Ritorna (kind, argv) o None.

    Multi-marker: il primo marker file trovato vince (ordinamento stabile).
    Se nessun marker noto esiste → None ("verification unavailable").
    """
    for kind, marker, argvs in _DETECTION:
        if os.path.isfile(os.path.join(workspace, marker)):
            return kind, list(argvs[0])
    # fallback: cartella tests/ con test_*.py → pytest
    tests_dir = os.path.join(workspace, "tests")
    if os.path.isdir(tests_dir) and any(
        f.startswith("test_") and f.endswith(".py") for f in os.listdir(tests_dir)
    ):
        return "python", ["python", "-m", "pytest", "-q"]
    return None


class ProjectRunner:
    """Esegue la verifica di un progetto nel suo workspace.

    Contratto v0.16 (dizionario, chiavi stabili):
        detected     bool   — progetto supportato rilevato
        kind         str    — python|node|rust|go|"" (quando non rilevato)
        command      list   — argv eseguito ([] se skipped)
        success      bool   — True iff rc==0 e non timeout (True se skipped)
        returncode   int    — exit code del subprocess (0 se skipped)
        duration     float  — secondi
        stdout/stderr str   — output catturato (cap alle dimensioni)
        timed_out    bool
        skipped      bool   — verification non eseguita
        skip_reason  str    — motivo (disabled / unsupported / workspace missing)
    """

    def run_verification(
        self,
        workspace: str,
        timeout_s: float = 120.0,
        enabled: bool = True,
    ) -> dict:
        if not enabled:
            return self._skipped("execution disabled by configuration")
        if not workspace or not os.path.isdir(workspace):
            return self._skipped("workspace not found")

        detected = detect_project(workspace)
        if detected is None:
            return self._skipped("no supported project type detected")

        kind, argv = detected
        # python lanciato sempre con l'interprete corrente del venv
        if argv and argv[0] == "python":
            import sys

            argv = [sys.executable] + argv[1:]

        result = run_command_sync(argv, workspace, timeout=timeout_s)
        return {
            "detected": True,
            "kind": kind,
            "command": argv,
            "success": result.exit_code == 0 and not result.timed_out,
            "returncode": result.exit_code,
            "duration": round(result.duration_s, 3),
            "stdout": result.stdout,
            "stderr": result.stderr,
            "timed_out": result.timed_out,
            "skipped": False,
            "skip_reason": "",
        }

    # ── helpers ───────────────────────────────────────────────

    @staticmethod
    def _skipped(reason: str) -> dict:
        return {
            "detected": False,
            "kind": "",
            "command": [],
            "success": True,  # skipped ≠ failed (preserva il flusso retry)
            "returncode": 0,
            "duration": 0.0,
            "stdout": "",
            "stderr": "",
            "timed_out": False,
            "skipped": True,
            "skip_reason": reason,
        }


def run_command_sync(argv: list[str], cwd: str, timeout: float):
    """Bridge sincrono: esegue run_command nel loop asyncio corrente (o uno nuovo)."""
    import asyncio

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        # chiamato da codice async: esegue in un thread per non bloccare il loop
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(
                asyncio.run, run_command(argv, cwd, timeout=timeout)
            ).result()
    return asyncio.run(run_command(argv, cwd, timeout=timeout))
