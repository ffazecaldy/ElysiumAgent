---
name: elysium-bench-operations
description: "Run Elysium-Bench benchmarks correctly — avoid recursive cascade, pipe deadlocks, and subprocess hangs. Critical operational knowledge for executing the multi-domain self-improvement benchmark on Hermes Agent."
version: 1.7.1
tags: [elysium-bench, benchmark, subprocess, debugging, elysium-swarmloop, windows, humaneval, swebench, mbpp, bigcodebench, taskbench]
---

# Elysium-Bench Operations

How to run the Elysium-Bench multi-domain self-improvement benchmark without hitting the critical pitfalls discovered in production.

## Critical Rules (violating = hang/crash)

### 1. Hermes path MUST be absolute for UI server

When running benchmarks from the UI server (uvicorn), the subprocess does NOT have `hermes` in PATH. Use absolute path:

```python
cmd = [
    r"C:\Users\Admin\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe",
    "chat", "-q", prompt_content,
    "--skills", "elysium-swarmloop",
    "-Q", "--yolo", "--accept-hooks", "--source", "tool",
]
```

Detection: all tasks complete in <10 min with scores ~50 → hermes not found, running baseline-only.

### 2. Run UI server from HERMES VENV Python

```bash
# ❌ WRONG — system python, can't import elysium_bench, hermes path issues
python -m uvicorn ...

# ✅ RIGHT — hermes venv python, has all deps
/c/Users/Admin/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe \
    -m uvicorn elysium_bench.ui_server:app --host 127.0.0.1 --port 8080
```

### 3. openai version pinned to hermes-agent compatibility

hermes-agent 0.19.0 requires openai==2.24.0. Upgrading to 2.47.0 breaks `from openai import OpenAI`.

```bash
/c/Users/Admin/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe \
    -m pip install openai==2.24.0
```

### 2. Redirect stdout/stderr to files (NOT capture_output)

```python
# ❌ WRONG — pipe deadlock:
result = subprocess.run(cmd, capture_output=True, text=True, timeout=660)

# ✅ RIGHT — file redirect:
with open("stdout.txt", "w") as out, open("stderr.txt", "w") as err:
    result = subprocess.run(cmd, stdout=out, stderr=err, text=True, timeout=660)
```

### 3. Workspace cleanup handles .git permissions (Windows)

```python
if workspace.exists():
    os.system(f'rmdir /S /Q "{workspace}" 2>nul')
    if workspace.exists():
        shutil.rmtree(workspace, ignore_errors=True)
```

### 4. force_baseline must return after running baseline

```python
if force_baseline:
    result = self._run_baseline(workspace, timeout)
    result["mode"] = "baseline"
    return result  # ← CRITICAL: don't continue to Hermes CLI
```

### 5. After code changes: clear cache, restart server

```bash
find elysium_bench -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null
python -m uvicorn elysium_bench.ui_server:app --host 127.0.0.1 --port 8080 &
```

### 6. typing_extensions in Hermes venv

```bash
python -m pip install --upgrade typing_extensions
```

## Benchmark Execution

### From terminal

```bash
cd Elysium-Bench
python -m elysium_bench.cli run --category logical_deduction
```

### Web UI (from dev branch)

```bash
cd Elysium-Bench && git checkout dev
python -m uvicorn elysium_bench.ui_server:app --host 127.0.0.1 --port 8080
```

### Expected Timing & Scores

#### SUPER LUNGO (10 categories, 2-3 loops + Re-Test)

| Skill version | Loop 1 | Re-Test | Code Avg | Timeouts | Durata | Skill Size |
|:--------------|:------:|:-------:|:--------:|:--------:|:------:|:----------:|
| v0.7.2 (180s) | 77.3 | 47.0 | 72.7 | 3 | 55.7 min | 1430 |
| v0.8.0 (300s) | 77.8 | 77.0 | 73.7 | 3 | 70.4 min | 1358 |
| **v0.8.1 (450s)** | **84.0** | **81.7** | **75.3** | **0** | **60.7 min** | **1358** |
| v0.11.2 (450s) | 72.4 | 75.8 | 73.0† | 0 | 107 min | 965 |

*† v0.11.2 BenchmarkRunner integration bug: full benchmark gave 36.3 code avg (correctness=0.0 — pytest not finding test files). Isolated test of single task with same TaskExecutor+ScoringEngine gives 73.0/100 — confirmed the SKILL works, the BenchmarkRunner has a workspace/test-copy bug. Fixed in dev branch `fe76732`.*
*See `references/v0112-isolated-test-verification.md` for the exact reproduction.*

#### v0.11.2 vs v0.8.1 — 5-category subset (same tasks)

| Categoria | v0.8.1 L1 | v0.11.2 L1 | Δ |
|:----------|:---------:|:----------:|:-:|
| api_development | 75.0 | 73.0† | -2 |
| bug_fixing | 79.0 | 79.0† | 0 |
| algorithm | 72.0 | — | — |
| logical_deduction | 100 | 100 | 0 |
| code_review | 100 | 100 | 0 |
| **MEDIA (code)** | **75.3** | **73.0†** | **-2.3** |

*† Isolated test score, not full benchmark*

### HumanEval vs Elysium-Bench — When the skill adds value

| Benchmark | Task complexity | Skill benefit | Why |
|:----------|:---------------:|:-------------:|:----|
| HumanEval (164 tasks) | Atomic (1 function) | **0%** | DeepSeek V4 solves all 20 solo |
| MBPP (257 tasks) | Atomic (1 function) | **N/A** | Function name mismatch, not representative |
| Elysium-Bench (100 tasks) | Multi-file features | **+18 pts** | Orchestration matters |
| SWE-bench Lite (300 tasks) | Real GitHub bugs | Pred only (80%) | Needs file access |

### MBPP Specific Issues

MBPP prompts don't specify function names (unlike HumanEval). Hermes invents names that don't match tests:
- Prompt: "Write a function to sort a given matrix..."
- Hermes generates: `def sort_matrix_by_row_sum(...)`
- Test asserts: `sort_matrix(...)` → ❌ FAIL

**Fix**: extract function name from first test assertion:
```python
func_name = re.match(r"assert\s+(\w+)\(", tests[0]).group(1)
prompt = f"...The function must be named '{func_name}'..."
```

Also, Hermes with skill may return unified diff format instead of code blocks:
```python
# Extract from diff: take all + lines (skip +++ header)
plus_lines = [l[1:] for l in text.split("\n") if l.startswith("+") and not l.startswith("+++")]
code = "\n".join(plus_lines)
```

### Scoring Engine Fixes (22 July 2026)

| Fix | Impact |
|:----|:-------|
| rubric.yaml for data_analysis (10 tasks) | 58 → 100 (+42 pts) |
| MathScoringEngine code execution | stdout vs text matching, kills floor effect |
| PlanScoringEngine artifact validation | Dockerfile/YAML structure in ANY file, not just filename |
| reference.txt for text tasks (36 files) | Kills ceiling effect on logical/security/code_review/docs |
| task_type in task.yaml (27 files) | Explicit type selection, not category-name-based |

### External Benchmarks

**HumanEval** (openai/human-eval) — 164 Python coding tasks, pass@1 metric.
- `sys.path.insert(0, r"C:\Users\Admin\human-eval")` — editable install fails on this env
- Each task: prompt → function body → pytest validation
- Binary pass/fail — no ceiling/floor effects, no keyword matching
- **Windows adapter** replaces `signal.setitimer()` with subprocess (see `scripts/humaneval_bench.py`)
- **Result (v0.11.2): 100% pass@1** on 20-task sample WITH skill, **100% WITHOUT skill** (DeepSeek V4 base)
- HumanEval tasks are too simple to measure skill value — both configs hit ceiling
- DeepSeek V4 solves all 20 atomically — subagent overhead adds no value here
- For meaningful skill measurement, use complex multi-file tasks (Elysium-Bench) or SWE-bench

**SWE-bench Lite** (princeton-nlp/SWE-bench_Lite) — 300 real GitHub issues, patch generation.
- Dataset: `datasets.load_dataset('princeton-nlp/SWE-bench_Lite', split='test')` — 300 instances
- Requires: `pip install datasets swebench` (click conflict: downgrade to 8.1.7 after, then reinstall hermes-agent)
- **Full evaluation requires Docker + Linux.** SWE-bench harness uses Unix `resource` module and `signal.setitimer()` — won't run on Windows.
- **v0.11.2 result**: 8/10 patches generated (80%) in 47 min. Django tasks faster (60-530s) than astropy (64-355s). 2 tasks failed: no diff output, text-only analysis.
- **Prediction format**: `{instance_id: patch_diff}` saved as JSON. Evaluable on any Linux machine with `python -m swebench.harness.run_evaluation --predictions_path file.json`
- **Patch quality**: 2 tasks failed: astropy-7746 (text analysis, no diff format) and one django task. astropy tasks produce text descriptions, not diffs — codebase too large for context.
- **Scripts**: `scripts/swebench_predict.py` (Elysium-Swarmloop), `scripts/swebench_test.py` (Elysium-Swarmloop)
- **Key finding**: SWE-bench requires access to repo files. LLM-only (issue text → patch) produces plausible but non-applicable patches. For real SWE-bench scores, need file-level context or Docker environment.
*† HumanEval pass@1 with v0.11.2: see `references/humaneval-results.md`*

### User Preferences

- **Conciso, niente spiegazioni lunghe.** Se chiede "ora" o "finito" vuole solo uno stato.
- **Tabelle, non paragrafi.** I dati parlano meglio delle parole.
- **Azione, non descrizione.** Mai "creerò un file" — fallo e basta.
- **Skill lean: niente storico versioni dentro SKILL.md.** Release notes solo su GitHub Release — il contesto è budget. Applica a ogni skill che mantieni per questo utente.

### Git branches

- `main`: scoring fixes only
- `dev`: UI server + scoring fixes (merged)

## Pitfalls

### ❌ Invariant benchmark scores = scorer bug
See `references/scorer-falsification-patterns.md` for full audit procedure.

### ❌ Timeout from data, not intuition
Set timeout to `max(real_task_durations) * 1.5`. Measured max: 353s → optimal 450s.

### ❌ pip installing SWE-bench corrupts click → hermes broken

SWE-bench/datasets depends on `click>=8.1` which auto-upgrades click to 8.4.2. Hermes-agent requires click==8.1.7. After `pip install datasets swebench`, `hermes chat` fails with `AttributeError: module 'click' has no attribute 'command'`.

**Fix:** `pip install click==8.1.7 --force-reinstall` in hermes venv. Then reinstall hermes-agent: `pip install hermes-agent --upgrade`.
**Detection:** `hermes --version` works but `hermes chat -q "test" -Q` tracebacks. All benchmark tasks return in 1s (hermes crashes before processing).

### ❌ HumanEval multiprocessing on Windows

HumanEval's `check_correctness` uses `multiprocessing.Manager()` which on Windows requires `if __name__ == "__main__":` guard. Without it: `RuntimeError: An attempt has been made to start a new process...`.

Also `signal.setitimer()` is Unix-only. **Fix:** Replace with subprocess-based execution (tempfile + timeout). See `scripts/humaneval_bench.py`.

### ❌ SWE-bench evaluation requires Linux — blocked on Windows

SWE-bench harness uses Unix `resource` module and `signal.setitimer()` which don't exist on Windows. Even with Docker running, the evaluation scripts themselves crash with `ModuleNotFoundError: No module named 'resource'`. The `swebench.harness` import chain touches `prepare_images.py` → `import resource` on every import.

**Workaround:** Generate predictions on Windows, evaluate on Linux. The prediction JSON format is platform-independent. Use `swebench_predict.py` to generate `{instance_id: patch}` JSON, then run on any Linux machine with:
```bash
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path swebench_predictions.json \
  --run_id elysium-v0.11.2
```

**Key insight for Elysium skill:** SWE-bench tasks need file-level repo context. Without seeing the actual code, Hermes produces text descriptions instead of diffs (astropy tasks) or plausible but non-applicable patches (django tasks). For real SWE-bench scores, the skill would need to read repo files before generating patches.

### ❌ DeepSeek V4 hits ceiling on HumanEval (AND MBPP beats skill)

Both WITH and WITHOUT skill score 100% on HumanEval 20-task sample. MBPP: WITHOUT skill 95% beats WITH skill 85%. Single-function tasks are too simple — any modern LLM solves them. The skill adds overhead (subagents, quality gates) that **hurts** performance on atomic tasks. **Use Elysium-Bench (complex multi-file) or BigCodeBench (multi-line) for skill measurement.** HumanEval is only useful for baseline LLM capability, not skill evaluation.

Rule: if prompt contains exactly 1 `def` keyword → Tier 1 Fast-Path (no skill load).

### ❌ MBPP: function name mismatch kills scores + Hermes diff format

MBPP prompts don't specify function names (unlike HumanEval). Hermes invents names that don't match test assertions. Also, when using `--skills elysium-swarmloop`, Hermes may return unified diff format instead of code blocks.

**Fix — function name:** Extract from first test assertion:
```python
func_name = re.match(r"assert\s+(\w+)\(", tests[0]).group(1)
full_prompt = f"...The function must be named '{func_name}'..."
```

**Fix — diff extraction:** Try code block first, then diff as fallback:
```python
m = re.search(r"```python\s*\n(.*?)```", text, re.DOTALL)
if m: code = m.group(1)
else:
    plus_lines = [l[1:] for l in text.split("\n") if l.startswith("+") and not l.startswith("+++")]
    code = "\n".join(plus_lines)
```

Result: 10% → 85% on MBPP after both fixes.

### ❌ BenchmarkRunner integration bug (v0.11.2 vs isolated test)

When the BenchmarkRunner runs ALL tasks (T01-T10 per category, 100 total), code task scores drop from ~73 to ~35 with correctness=0.0. Isolated test of single task with same code path gives 73/100.

**Confirmed fix (dev branch `fe76732`):**
- `hermes_interface.py`: absolute hermes path + `force_baseline` returns immediately
- `harness.py`: workspace cleanup uses `os.system('rmdir /S /Q')` before `shutil.rmtree`
- `ui_server.py` started with hermes venv python for correct dependency resolution

After fix, BenchmarkRunner produces 73/100 for T01_api_development — matching isolated test.

**Verification:** test each task in isolation first. Compare with full benchmark. If scores diverge, the runner has a bug, not the skill.

### ❌ pip installing SWE-bench corrupts click → hermes broken

SWE-bench/datasets depends on `click>=8.1` which auto-upgrades click to 8.4.2. Hermes-agent requires click==8.1.7. After `pip install datasets swebench`, `hermes chat` fails with `AttributeError: module 'click' has no attribute 'command'`.

**Fix:** `pip install click==8.1.7 --force-reinstall` in hermes venv. Then reinstall hermes-agent: `pip install hermes-agent --upgrade`.
**Detection:** `hermes --version` works but `hermes chat -q "test" -Q` tracebacks. All benchmark tasks return in 1s (hermes crashes before processing).

### ❌ HumanEval multiprocessing on Windows

HumanEval's `check_correctness` uses `multiprocessing.Manager()` which on Windows requires `if __name__ == "__main__":` guard. Without it: `RuntimeError: An attempt has been made to start a new process...`.

Also `signal.setitimer()` is Unix-only. **Fix:** Replace with subprocess-based execution (tempfile + timeout). See `scripts/humaneval_bench.py`.

### ❌ SWE-bench evaluation requires Linux — blocked on Windows

SWE-bench harness uses Unix `resource` module and `signal.setitimer()` which don't exist on Windows. Even with Docker running, the evaluation scripts themselves crash with `ModuleNotFoundError: No module named 'resource'`. The `swebench.harness` import chain touches `prepare_images.py` → `import resource` on every import.

**Workaround:** Generate predictions on Windows, evaluate on Linux. The prediction JSON format is platform-independent. Use `swebench_predict.py` to generate `{instance_id: patch}` JSON, then run on any Linux machine with:
```bash
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path swebench_predictions.json \
  --run_id elysium-v0.11.2
```

**Key insight for Elysium skill:** SWE-bench tasks need file-level repo context. Without seeing the actual code, Hermes produces text descriptions instead of diffs (astropy tasks) or plausible but non-applicable patches (django tasks). For real SWE-bench scores, the skill would need to read repo files before generating patches.

### ❌ DeepSeek V4 hits ceiling on HumanEval (AND MBPP beats skill)

Both WITH and WITHOUT skill score 100% on HumanEval 20-task sample. MBPP: WITHOUT skill 95% beats WITH skill 85%. Single-function tasks are too simple — any modern LLM solves them. The skill adds overhead (subagents, quality gates) that **hurts** performance on atomic tasks. **Use Elysium-Bench (complex multi-file) or BigCodeBench (multi-line) for skill measurement.** HumanEval is only useful for baseline LLM capability, not skill evaluation.

Rule: if prompt contains exactly 1 `def` keyword → Tier 1 Fast-Path (no skill load).

### ❌ BenchmarkRunner integration bug (v0.11.2 vs isolated test)

When the BenchmarkRunner runs ALL tasks (T01-T10 per category, 100 total), code task scores drop from ~73 to ~35 with correctness=0.0. Isolated test of single task with same code path gives 73/100.

**Confirmed fix (dev branch `fe76732`):**
- `hermes_interface.py`: absolute hermes path + `force_baseline` returns immediately
- `harness.py`: workspace cleanup uses `os.system('rmdir /S /Q')` before `shutil.rmtree`
- `ui_server.py` started with hermes venv python for correct dependency resolution

After fix, BenchmarkRunner produces 73/100 for T01_api_development — matching isolated test.

If scores diverge, the runner has a bug, not the skill.

### ❌ Pushed to the fork when the user named the parent repo (or wrong push identity)

"hai fatto qui la push?" — the user gives a URL, that URL is the push target. Pushing only to the fork is wrong unless fork-only was explicit; when in doubt push BOTH parent + fork. "L'utente che pusha deve essere X" means BOTH: commit author = X AND push auth = X's token (inline URL `https://X:$TOKEN@github.com/...` — origin's embedded token may belong to someone else). Pre-check `GET /repos/{o}/{r}/collaborators/X/permission` → "write". Verify post-push via API (head sha + tags). Full procedure in `references/v0150-release-and-sync.md`.

---

**References:**
- `references/scoring-engine-audit-20260722.md` — complete scoring engine audit + fixes applied
- `references/infrastructure-audit-20260722.md` — category-by-category scoring reliability + v0.11.2 crash investigation
- `references/benchmark-v0112-results.md` — v0.11.2 full benchmark results (100 tasks, 107 min)
- `references/humaneval-results.md` — HumanEval 20-task sample: 100% with skill, 100% without (DeepSeek V4 base)
- `references/benchmark-audit-methodology.md` — scorer audit procedure
- `references/scorer-falsification-patterns.md` — falsification test recipes
- `references/ui-server-fixes-20260722.md` — hermes path, force_baseline, cleanup, typing_extensions, cache clearing
- `references/skill-sync-and-v013-v014-audit.md` — repo→Hermes skill sync procedure; v0.13.x/v0.14.0 audit (the "e2e false-green" finding); reusable skill-improvement audit checklist
- `references/v0150-release-and-sync.md` — v0.15.0 release: audit fixes implemented (case-insensitive triggers, smart checkpoints, token cost gate, conditional RTK/PR/docs), e2e Scenario 5 (224→250, false-green resolved), fork-push procedure (missing fork via API 202); v0.15.0-final: lean skill (NO in-skill version history), tag-move force push, push-identity verification (inline token URL, collaborator permission check), GitHub Release via API pitfalls (422 on short-SHA target_commitish → use "main"; --data-binary @file; releases on BOTH parent+fork)
- `scripts/humaneval_bench.py` — HumanEval benchmark runner (Windows-compatible, --no-skill flag)
- `scripts/swebench_predict.py` — SWE-bench prediction generator (Docker eval support)
- `references/elysium-agent-tier-examples.md` — ElysiumAgent (Optimize Engine): `detect_tier` keyword collisions (`api`/`module`/`small` nel testo alzano il tier — max-band-wins), ricetta verifica (esegui la funzione, non leggere le regex), catalog 12 goal verificati, barre PytestBar/PerfBar, workaround rg→grep su path OneDrive.

---

### ❌ Tier keyword nel testo del goal → alzano il tier (max-band-wins)

Obiettivo Tier 1/2 ma nel testo compare `api`, `module`, `auth`, `service`, `dashboard`, `small`, `feature` → `detect_tier` scatta su 3 o 4 (misurato: "Quick edit to update the API base URL in config.yaml" → **Tier 3**; "Refactor the parser module and add tests" → **Tier 3**). `add\s*endpoint` richiede il letterale "add endpoint" ("add a new endpoint" NON matcha). **Regola:** prima di consegnare goal/esempi classificati per tier, verifica con `./.venv/Scripts/python -c "from engine.state import detect_tier"` sul repo ElysiumAgent — mai a occhio. Esempi completi: `references/elysium-agent-tier-examples.md`.

### ❌ search_files (rg) fallisce sui path OneDrive del progetto

`rg` su `C:\Users\Admin\OneDrive - Florian Elmazi\Documenti\ProgettiAtigravity\…` → "Impossibile trovare il file specificato" (os error 2/3); `terminal` (ls/grep) e `read_file` con lo stesso path funzionano. Usare `grep -rn` via terminal (path tra virgolette) o `read_file` diretto su questi repo — non riprovare search_files.
