"""harness/git_service.py — operazioni git sui workspace di progetto.

Wrapper git ASINCRONO sicuro usato dall'harness per versionare il lavoro
dei loop multi-agente. Vincoli di sicurezza:

1. Forma argv (niente shell) + allowlist di SUBCOMANDI git permessi.
   I subcomandi con side effect esterni (push, pull, fetch) o distruttivi
   (clean, reset, rebase) sono bloccati; il resto (status/add/commit/log/
   diff/branch) è permesso.
2. Si lavora solo su repo esistenti o inizializzati con `ensure_repo`
   (init esplicito): mai `git init` implicito su input non fidato, e mai
   su workspace attaccati a cartelle utente senza chiamarlo a voce.
3. Identità commit esplicita (`-c user.name/-c user.email`) così i commit
   funzionano anche senza config globale git.
4. Messaggi di commit sanitizzati (prima riga, no newline di controllo).
"""
from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Optional, Sequence

from harness.execution import (
    RC_NOT_ALLOWED,
    RC_NOT_FOUND,
    ExecResult,
    _validate_workspace,
    run_command,
    run_command_sync,
)

# subcomandi git permessi (operazioni locali sicure)
ALLOWED_SUBCOMMANDS = frozenset({
    "status", "add", "commit", "log", "diff", "branch", "checkout",
    "switch", "restore", "stash", "show", "rev-parse", "init",
})

# subcomandi git con side effect fuori dal repo o distruttivi: mai permessi
BLOCKED_SUBCOMMANDS = frozenset({
    "push", "pull", "fetch", "remote", "clean", "reset", "rebase",
    "merge", "cherry-pick", "revert", "am", "apply", "config",
    "submodule", "worktree", "filter-branch",
})

GIT_EXE = "git"

# identità esplicita: i commit funzionano anche senza config globale git
_COMMITTER_NAME = "Elysium Agent"
_COMMITTER_EMAIL = "elysium@local"


def _identity_args() -> list[str]:
    return [
        "-c", f"user.name={_COMMITTER_NAME}",
        "-c", f"user.email={_COMMITTER_EMAIL}",
    ]


@dataclass
class GitResult:
    """Esito di un'operazione git di alto livello."""

    ok: bool
    action: str
    argv: list[str] = field(default_factory=list)
    exit_code: int = -1
    stdout: str = ""
    stderr: str = ""
    detail: str = ""
    data: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "ok": self.ok,
            "action": self.action,
            "argv": self.argv,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "detail": self.detail,
            "data": self.data,
        }


def _sanitize_message(message: str) -> str:
    """Prima riga del messaggio, senza caratteri di controllo."""
    first_line = (message or "").strip().splitlines()[0] if message.strip() else ""
    return re.sub(r"[\x00-\x1f\x7f]", " ", first_line).strip()


def _parse_log(stdout: str) -> list[dict]:
    """Parso l'output di `git log --format=%H%x1f%h%x1f%an%x1f%at%x1f%s`."""
    out = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\x1f")
        if len(parts) != 5:
            continue
        out.append({
            "hash": parts[0],
            "short": parts[1],
            "author": parts[2],
            "ts": int(parts[3]) if parts[3].isdigit() else 0,
            "subject": parts[4],
        })
    return out


async def git(argv: Sequence[str], cwd: str,
              timeout: float = 60) -> ExecResult:
    """Esegue git con la allowlist generale (uso libero dal caller)."""
    return await run_command([GIT_EXE, *argv], cwd=cwd, timeout=timeout)


async def _safe_git(argv: Sequence[str], cwd: str,
                    timeout: float = 60) -> ExecResult:
    """Esegue git validando il SUBCOMANDO contro l'allowlist del servizio.

    Ritorna un ExecResult con exit_code 126 se il subcomando è bloccato:
    mai eccezioni per scelte di policy.
    """
    if not argv:
        return ExecResult(argv=[GIT_EXE], exit_code=RC_NOT_ALLOWED,
                          stderr="nessun subcomando git fornito", cwd=cwd)
    sub = str(argv[0]).strip().lower()
    if sub in BLOCKED_SUBCOMMANDS:
        return ExecResult(argv=[GIT_EXE, *argv], exit_code=RC_NOT_ALLOWED,
                          stderr=f"subcomando git bloccato: {sub}", cwd=cwd)
    if sub not in ALLOWED_SUBCOMMANDS:
        return ExecResult(argv=[GIT_EXE, *argv], exit_code=RC_NOT_ALLOWED,
                          stderr=f"subcomando git non in allowlist: {sub}",
                          cwd=cwd)
    return await run_command([GIT_EXE, *argv], cwd=cwd, timeout=timeout)


async def ensure_repo(workspace: str) -> GitResult:
    """Garantisce che il workspace sia una repo git (init locale, niente remote).

    Non tocca mai cartelle utente attaccate: chiama questo SOLO su workspace
    di proprietà del harness.
    """
    ws_err = _validate_workspace(workspace)
    if ws_err is not None:
        return GitResult(ok=False, action="ensure_repo",
                         argv=[], exit_code=ws_err.exit_code,
                         stderr=ws_err.stderr)
    already = await run_command([GIT_EXE, "rev-parse", "--is-inside-work-tree"],
                                cwd=workspace, timeout=15)
    if already.ok and already.stdout.strip() == "true":
        return GitResult(ok=True, action="ensure_repo",
                         argv=already.argv, exit_code=0,
                         detail="repository già inizializzata")
    res = await run_command([GIT_EXE, "init"], cwd=workspace, timeout=30)
    return GitResult(ok=res.ok, action="ensure_repo", argv=res.argv,
                     exit_code=res.exit_code, stdout=res.stdout,
                     stderr=res.stderr,
                     detail="repository inizializzata" if res.ok else "init fallito")


async def commit_workspace(workspace: str, message: str,
                           timeout: float = 60) -> GitResult:
    """Stage all + commit con identità esplicita.

    Ritorna ok=False (senza eccezioni) se non ci sono cambiamenti da
    committare — caso normale dopo un loop che non ha toccato nulla.
    """
    ws_err = _validate_workspace(workspace)
    if ws_err is not None:
        return GitResult(ok=False, action="commit",
                         argv=[], exit_code=ws_err.exit_code,
                         stderr=ws_err.stderr)
    msg = _sanitize_message(message)
    if not msg:
        return GitResult(ok=False, action="commit", argv=[],
                         exit_code=RC_NOT_ALLOWED,
                         stderr="messaggio di commit vuoto")

    add = await _safe_git(["add", "-A", "."], cwd=workspace, timeout=timeout)
    if not add.ok:
        return GitResult(ok=False, action="commit", argv=add.argv,
                         exit_code=add.exit_code, stdout=add.stdout,
                         stderr=add.stderr, detail="git add fallito")

    commit = await _safe_git(
        ["commit", "-m", msg] , cwd=workspace, timeout=timeout)
    # senza identità configurata git esce 128: ritenta con identità esplicita
    if not commit.ok and "identity" in (commit.stderr or "").lower():
        commit = await run_command(
            [GIT_EXE, *_identity_args(), "commit", "-m", msg],
            cwd=workspace, timeout=timeout)

    if not commit.ok:
        nothing = "no changes added to commit" in (commit.stdout or "") or \
            "nothing to commit" in (commit.stdout or "")
        return GitResult(ok=False, action="commit", argv=commit.argv,
                         exit_code=commit.exit_code, stdout=commit.stdout,
                         stderr=commit.stderr,
                         detail="nessun cambiamento da committare" if nothing
                         else "commit fallito")

    sha = await _safe_git(["rev-parse", "HEAD"], cwd=workspace, timeout=15)
    return GitResult(ok=True, action="commit", argv=commit.argv,
                     exit_code=0, stdout=commit.stdout, stderr=commit.stderr,
                     detail=msg,
                     data={"commit": sha.stdout.strip() if sha.ok else None})


async def status(workspace: str, timeout: float = 30) -> GitResult:
    """`git status --porcelain` + branch corrente, in forme pythoniche."""
    ws_err = _validate_workspace(workspace)
    if ws_err is not None:
        return GitResult(ok=False, action="status",
                         argv=[], exit_code=ws_err.exit_code,
                         stderr=ws_err.stderr)
    inside = await run_command(
        [GIT_EXE, "rev-parse", "--is-inside-work-tree"],
        cwd=workspace, timeout=15)
    if not (inside.ok and inside.stdout.strip() == "true"):
        return GitResult(ok=False, action="status", argv=inside.argv,
                         exit_code=RC_NOT_FOUND,
                         stderr="il workspace non è una repository git",
                         data={"dirty": False, "branch": None, "entries": []})

    st = await _safe_git(["status", "--porcelain"], cwd=workspace,
                         timeout=timeout)
    br = await _safe_git(["rev-parse", "--abbrev-ref", "HEAD"],
                         cwd=workspace, timeout=15)
    entries = []
    for line in (st.stdout or "").splitlines():
        line = line.rstrip("\n")
        if len(line) >= 4:
            entries.append({"status": line[:2], "path": line[3:].strip()})
    return GitResult(ok=st.ok, action="status", argv=st.argv,
                     exit_code=st.exit_code, stdout=st.stdout,
                     stderr=st.stderr,
                     data={"dirty": bool(entries), "branch":
                           br.stdout.strip() if br.ok else None,
                           "entries": entries})


async def log(workspace: str, limit: int = 20,
              timeout: float = 30) -> GitResult:
    """Storico commit in forme pythoniche (hash, autore, ts, subject)."""
    ws_err = _validate_workspace(workspace)
    if ws_err is not None:
        return GitResult(ok=False, action="log",
                         argv=[], exit_code=ws_err.exit_code,
                         stderr=ws_err.stderr)
    limit = max(1, min(int(limit), 200))
    fmt = "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s"
    res = await _safe_git(["log", "-n", str(limit), fmt],
                          cwd=workspace, timeout=timeout)
    commits = _parse_log(res.stdout or "")
    if not res.ok:
        return GitResult(ok=False, action="log", argv=res.argv,
                         exit_code=res.exit_code, stdout=res.stdout,
                         stderr=res.stderr,
                         detail="nessuno storico (repo senza commit?)"
                         if "does not have any commits" in (res.stderr or "")
                         else "git log fallito",
                         data={"commits": []})
    return GitResult(ok=True, action="log", argv=res.argv, exit_code=0,
                     data={"commits": commits})


async def diff(workspace: str, timeout: float = 30) -> GitResult:
    """`git diff` (working tree vs index) — sola lettura."""
    ws_err = _validate_workspace(workspace)
    if ws_err is not None:
        return GitResult(ok=False, action="diff",
                         argv=[], exit_code=ws_err.exit_code,
                         stderr=ws_err.stderr)
    res = await _safe_git(["diff"], cwd=workspace, timeout=timeout)
    return GitResult(ok=res.ok, action="diff", argv=res.argv,
                     exit_code=res.exit_code, stdout=res.stdout,
                     stderr=res.stderr,
                     data={"has_changes": bool((res.stdout or "").strip())})


# ── v0.16 facade: GitService ─────────────────────────────────
import sys as _sys
_low = _sys.modules[__name__]  # self-alias: _low._sanitize_message etc.



class GitService:
    """Sincrono, stateless sul workspace: ogni metodo prende/usa il path."""

    def __init__(self, workspace: str):
        self.workspace = os.path.abspath(workspace)

    # ── repo lifecycle ────────────────────────────────────────

    def is_repo(self) -> bool:
        return os.path.isdir(os.path.join(self.workspace, ".git"))

    def ensure_repo(self) -> bool:
        """git init + initial commit se il workspace non è già un repo."""
        if self.is_repo():
            return True
        run_command_sync(["git", "init"], self.workspace, timeout=60)
        if not self.is_repo():
            return False
        # initial commit coerente (eventuale .gitignore per artifacts)
        self._write_gitignore()
        run_command_sync(["git", "add", "-A"], self.workspace, timeout=120)
        run_command_sync(
            ["git", "commit", "-m", "initial commit", "--allow-empty"],
            self.workspace,
            timeout=120,
        )
        return True

    def _write_gitignore(self) -> None:
        gi = os.path.join(self.workspace, ".gitignore")
        if not os.path.exists(gi):
            with open(gi, "w", encoding="utf-8") as f:
                f.write("__pycache__/\n*.pyc\nnode_modules/\n.venv/\n")

    # ── checkpoint / commit ───────────────────────────────────

    def checkpoint(self, label: str) -> Optional[str]:
        """Commit di checkpoint; ritorna lo SHA (o None se git fallisce)."""
        self.ensure_repo()
        run_command_sync(["git", "add", "-A"], self.workspace, timeout=120)
        res = run_command_sync(
            ["git", "commit", "-m", f"checkpoint: {label}", "--allow-empty"],
            self.workspace,
            timeout=120,
        )
        if res.exit_code != 0:
            return None
        return self._head_sha()

    def commit(self, message: str) -> Optional[str]:
        run_command_sync(["git", "add", "-A"], self.workspace, timeout=120)
        res = run_command_sync(
            ["git", "commit", "-m", _low._sanitize_message(message), "--allow-empty"],
            self.workspace,
            timeout=120,
        )
        if res.exit_code != 0:
            return None
        return self._head_sha()

    def _head_sha(self) -> Optional[str]:
        res = run_command_sync(
            ["git", "rev-parse", "HEAD"], self.workspace, timeout=30
        )
        if res.exit_code != 0:
            return None
        sha = res.stdout.strip()
        return sha if len(sha) == 40 else None

    # ── rollback ──────────────────────────────────────────────

    def rollback_paths(
        self, paths: Iterable[str], to_commit: Optional[str] = None
    ) -> int:
        """Ripristina SOLO i path indicati allo stato di `to_commit` (o HEAD).

        Se il file non esisteva al commit di riferimento viene rimosso.
        Ritorna il numero di path ripristinati con successo.
        """
        target = to_commit or "HEAD"
        restored = 0
        for p in paths:
            rel = os.path.normpath(p).replace("\\", "/")
            exists_at_target = (
                run_command_sync(
                    ["git", "cat-file", "-e", f"{target}:{rel}"],
                    self.workspace,
                    timeout=30,
                ).exit_code
                == 0
            )
            if exists_at_target:
                res = run_command_sync(
                    ["git", "checkout", target, "--", rel],
                    self.workspace,
                    timeout=30,
                )
                if res.exit_code == 0:
                    restored += 1
            else:
                res = run_command_sync(
                    ["git", "rm", "-f", "--ignore-unmatch", rel],
                    self.workspace,
                    timeout=30,
                )
                # rimozione fisica se git rm non l'ha già tolta
                abs_path = os.path.join(self.workspace, rel)
                if os.path.exists(abs_path):
                    try:
                        os.remove(abs_path)
                    except OSError:
                        continue
                if res.exit_code == 0:
                    restored += 1
        return restored

    def rollback_all(self, to_commit: Optional[str] = None) -> bool:
        """Rollback dell'INTERA run (solo condizioni globali/gravi)."""
        target = to_commit or "HEAD"
        res1 = run_command_sync(
            ["git", "reset", "--hard", target], self.workspace, timeout=60
        )
        res2 = run_command_sync(
            ["git", "clean", "-fd"], self.workspace, timeout=60
        )
        return res1.exit_code == 0 and res2.exit_code == 0

    # ── stato ─────────────────────────────────────────────────

    def has_changes(self) -> bool:
        res = run_command_sync(
            ["git", "status", "--porcelain"], self.workspace, timeout=30
        )
        return res.exit_code == 0 and res.stdout.strip() != ""
