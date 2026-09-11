"""tests/test_v016_execution_git.py — B-tests v0.16: execution runner + git service.

Deterministic coverage (no network, no real LLM):
- GitService: ensure_repo / checkpoint / rollback_paths / rollback_all / has_changes
- ProjectRunner.run_verification: python detection, failing tests, timeout,
  unsupported project, disabled flag
- HarnessRun integration: git checkpointing + execution verification +
  selective task rollback + cancellation

All subprocess/pytest work runs against tmp_path workspaces.
"""
import asyncio
import os
import re
import subprocess

import pytest

from harness.execution import ProjectRunner
from harness.git_service import GitService
from harness.orchestrator import HarnessRun
from harness.projects import ProjectStore

LONG_TIMEOUT = 120
SLOW_TIMEOUT = 60


# ──────────────────────────────────────────────────────────────
# Helper: deterministic git identity (env overrides any config)
# ──────────────────────────────────────────────────────────────
@pytest.fixture
def git_env(monkeypatch):
    monkeypatch.setenv("GIT_AUTHOR_NAME", "Elysium Test")
    monkeypatch.setenv("GIT_AUTHOR_EMAIL", "test@elysium.local")
    monkeypatch.setenv("GIT_COMMITTER_NAME", "Elysium Test")
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", "test@elysium.local")


def git_log_oneline(workspace: str) -> str:
    """Run `git log --oneline` in a workspace; return stdout (may be empty)."""
    out = subprocess.run(
        ["git", "-C", workspace, "log", "--oneline"],
        capture_output=True, text=True, errors="replace", timeout=30,
    )
    return out.stdout if out.returncode == 0 else ""


def make_py_project(workspace: str, test_body: str = "def test_ok():\n    assert True\n",
                    filename: str = "test_x.py") -> None:
    """Create a minimal pytest project inside a workspace dir."""
    os.makedirs(os.path.join(workspace, "tests"), exist_ok=True)
    with open(os.path.join(workspace, "pytest.ini"), "w", encoding="utf-8") as f:
        f.write("[pytest]\n")
    with open(os.path.join(workspace, "tests", filename), "w", encoding="utf-8") as f:
        f.write(test_body)


def read_ws(workspace: str, rel: str) -> str:
    with open(os.path.join(workspace, rel), "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def write_ws(workspace: str, rel: str, content: str) -> None:
    full = os.path.join(workspace, rel)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        f.write(content)


def make_store(tmp_path) -> tuple[ProjectStore, object, str]:
    """ProjectStore su tmp_path + progetto creato; ritorna (store, project, workspace)."""
    s = ProjectStore(root=str(tmp_path / "store_root"))
    p = s.create("p")
    return s, p, p.files_dir


# ──────────────────────────────────────────────────────────────
# FakeLLM patterns (copied from tests/test_orchestrator.py)
# ──────────────────────────────────────────────────────────────
class FakeLLM:
    """Sequential LLM: first call = decompose JSON, later calls = worker."""

    def __init__(self, decomp: str, worker: str):
        self.i = 0
        self.decomp = decomp
        self.worker = worker

    async def complete(self, messages, max_tokens=None):
        self.i += 1
        if self.i == 1:
            return {"choices": [{"message": {"content": "```json\n" + self.decomp + "\n```"}}]}
        return {"choices": [{"message": {"content": self.worker}}]}


class RoutedLLM:
    """Deterministic under asyncio.gather: routes by task_id in the prompt."""

    def __init__(self, decomp: str, workers: dict):
        self.decomp = decomp
        self.workers = workers

    async def complete(self, messages, max_tokens=None):
        prompt = messages[0]["content"]
        m = re.search(r"task_id:\s*(\S+)", prompt)
        if m and m.group(1) in self.workers:
            return {"choices": [{"message": {"content": self.workers[m.group(1)]}}]}
        return {"choices": [{"message": {"content": "```json\n" + self.decomp + "\n```"}}]}


WORKER_PASS = """## RESULT
- task_id: {tid}
- status: pass
- quality_score: 8/10

## FILES
### FILE: {path}
```
{content}
```
"""

WORKER_FAIL = """## RESULT
- task_id: {tid}
- status: fail
- quality_score: 2/10
- gaps: [implementazione mancante]

## FILES
### FILE: {path}
```
{content}
```
"""


# ──────────────────────────────────────────────────────────────
# GitService
# ──────────────────────────────────────────────────────────────
def test_git_ensure_repo_crea_repo_e_commit_iniziale(tmp_path, git_env):
    ws = str(tmp_path / "ws")
    os.makedirs(ws)
    write_ws(ws, "doc.txt", "hello\n")
    g = GitService(ws)
    assert g.is_repo() is False
    assert g.ensure_repo() is True
    assert g.is_repo() is True
    assert git_log_oneline(ws).strip() != ""  # initial commit presente


def test_checkpoint_restituisce_sha_valida_e_has_changes_false(tmp_path, git_env):
    s, p, ws = make_store(tmp_path)
    s.write_file(p, "f.txt", "v1")
    g = GitService(ws)
    assert g.ensure_repo() is True
    sha = g.checkpoint("pre-run")
    assert sha is not None
    assert re.fullmatch(r"[0-9a-f]{40}", sha)
    assert g.has_changes() is False


def test_task_success_preserva_file_modificati(tmp_path, git_env):
    s, p, ws = make_store(tmp_path)
    g = GitService(ws)
    g.ensure_repo()
    s.write_file(p, "app/mod.py", "x = 1\n")
    pre = g.checkpoint("pre")
    assert pre
    s.write_file(p, "app/mod.py", "x = 42\n")  # il task modifica il file
    assert read_ws(ws, os.path.join("app", "mod.py")) == "x = 42\n"


def test_rollback_selettivo_solo_percorsi_richiesti(tmp_path, git_env):
    s, p, ws = make_store(tmp_path)
    g = GitService(ws)
    g.ensure_repo()
    s.write_file(p, "a.txt", "A-old\n")
    s.write_file(p, "b.txt", "B-old\n")
    pre = g.checkpoint("pre-run")
    assert pre
    s.write_file(p, "a.txt", "A-new\n")
    s.write_file(p, "b.txt", "B-new\n")
    n = g.rollback_paths(["b.txt"], pre)
    assert n >= 1
    assert read_ws(ws, "a.txt") == "A-new\n"  # preservato
    assert read_ws(ws, "b.txt") == "B-old\n"  # ripristinato


def test_rollback_all_ripristina_intero_albero(tmp_path, git_env):
    s, p, ws = make_store(tmp_path)
    g = GitService(ws)
    g.ensure_repo()
    s.write_file(p, "a.txt", "A-old\n")
    s.write_file(p, "dir/c.txt", "C-old\n")
    pre = g.checkpoint("pre-run")
    s.write_file(p, "a.txt", "A-new\n")
    s.write_file(p, "dir/c.txt", "C-new\n")
    s.write_file(p, "d_new.txt", "brand new\n")  # file creato dopo il checkpoint
    assert g.rollback_all(pre) is True
    assert read_ws(ws, "a.txt") == "A-old\n"
    assert read_ws(ws, os.path.join("dir", "c.txt")) == "C-old\n"
    assert not os.path.exists(os.path.join(ws, "d_new.txt"))


# ──────────────────────────────────────────────────────────────
# ProjectRunner.run_verification
# ──────────────────────────────────────────────────────────────
def test_runner_detect_python_project(tmp_path):
    ws = str(tmp_path / "ws")
    os.makedirs(ws)
    make_py_project(ws)
    r = ProjectRunner().run_verification(ws, timeout_s=LONG_TIMEOUT, enabled=True)
    assert r["detected"] is True
    assert r["kind"] == "python"
    assert r["success"] is True


def test_run_verification_python_fallente(tmp_path):
    ws = str(tmp_path / "ws")
    os.makedirs(ws)
    make_py_project(ws, test_body="def test_ko():\n    assert False\n")
    r = ProjectRunner().run_verification(ws, timeout_s=LONG_TIMEOUT, enabled=True)
    assert r["detected"] is True
    assert r["success"] is False
    assert r["returncode"] != 0
    assert (r["stdout"] or "") + (r["stderr"] or "") != ""


@pytest.mark.slow
def test_run_verification_timeout(tmp_path):
    ws = str(tmp_path / "ws")
    os.makedirs(ws)
    make_py_project(
        ws, filename="test_slow.py",
        test_body="import time\n\n\ndef test_lento():\n    time.sleep(30)\n",
    )
    r = ProjectRunner().run_verification(ws, timeout_s=2, enabled=True)
    assert r["timed_out"] is True
    assert r["success"] is False


def test_run_verification_progetto_non_supportato(tmp_path):
    ws = str(tmp_path / "ws")
    os.makedirs(ws)  # dir vuota: nessun marcatore di progetto
    r = ProjectRunner().run_verification(ws, timeout_s=LONG_TIMEOUT, enabled=True)
    assert r["detected"] is False
    assert r["skipped"] is True
    assert r["success"] is True


def test_run_verification_disabled(tmp_path):
    ws = str(tmp_path / "ws")
    os.makedirs(ws)
    make_py_project(ws)
    r = ProjectRunner().run_verification(ws, timeout_s=LONG_TIMEOUT, enabled=False)
    assert r["skipped"] is True
    assert r["success"] is True
    assert "disab" in (r.get("skip_reason") or "").lower()


# ──────────────────────────────────────────────────────────────
# Integrazione orchestrator (git + execution)
# ──────────────────────────────────────────────────────────────
async def test_orchestrator_happy_path_git_ed_execution(tmp_path, git_env):
    s, p, ws = make_store(tmp_path)
    make_py_project(ws)  # workspace con vera suite pytest che passa
    decomp = '[{"id":"t1","description":"scrivi a.txt","files":["a.txt"],"interface_contract":null}]'
    worker = WORKER_PASS.format(tid="t1", path="a.txt", content="A=1")
    rep = await HarnessRun(
        llm=FakeLLM(decomp, worker), goal="goal v0.16", project=p, store=s,
        max_retries=1, git_enabled=True, execution_enabled=True,
    ).run()
    assert rep["git"]["pre_run_checkpoint"]
    assert rep["git"]["final_commit"]
    assert rep["tasks"][0]["status"] == "pass"
    assert rep["final_status"] == "completed"
    assert read_ws(ws, "a.txt").strip() == "A=1"


async def test_orchestrator_partial_con_rollback_selettivo(tmp_path, git_env):
    s, p, ws = make_store(tmp_path)
    # pre-run: test_b.py esiste e passa; il task B lo sovrascrive rompendolo
    write_ws(ws, "tests/test_b.py", "def test_b():\n    assert True\n")
    with open(os.path.join(ws, "pytest.ini"), "w", encoding="utf-8") as f:
        f.write("[pytest]\n")
    pre_b = read_ws(ws, "tests/test_b.py")
    decomp = (
        '[{"id":"t1","description":"scrivi a.txt","files":["a.txt"],"interface_contract":null},'
        '{"id":"t2","description":"scrivi tests/test_b.py","files":["tests/test_b.py"],"interface_contract":null}]'
    )
    workers = {
        "t1": WORKER_PASS.format(tid="t1", path="a.txt", content="A=1"),
        "t2": WORKER_FAIL.format(
            tid="t2", path="tests/test_b.py",
            content="def test_b():\n    assert False\n"),
    }
    rep = await HarnessRun(
        llm=RoutedLLM(decomp, workers), goal="goal con un task rotto", project=p, store=s,
        max_retries=1, git_enabled=True, execution_enabled=True,
    ).run()
    assert rep["final_status"] == "partial"
    assert read_ws(ws, "a.txt").strip() == "A=1"                       # A preservato
    assert read_ws(ws, "tests/test_b.py").strip() == pre_b.strip()             # B riportato al contenuto pre-run
    rollback_entries = rep["git"]["rollback"]
    assert isinstance(rollback_entries, list) and rollback_entries
    assert any(e.get("scope") == "task" for e in rollback_entries)


async def test_cancel_event_antes_run_annulla_subito(tmp_path, git_env):
    s, p, _ = make_store(tmp_path)
    decomp = '[{"id":"t1","description":"scrivi a.txt","files":["a.txt"],"interface_contract":null}]'
    llm = FakeLLM(decomp, WORKER_PASS.format(tid="t1", path="a.txt", content="A=1"))
    ev = asyncio.Event()
    ev.set()  # cancel PRIMA del run
    rep = await HarnessRun(
        llm=llm, goal="goal annullato", project=p, store=s,
        max_retries=1, git_enabled=True, execution_enabled=True, cancel_event=ev,
    ).run()
    assert rep["final_status"] == "cancelled"
