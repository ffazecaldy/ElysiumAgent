# UI Server Fixes — 22 July 2026 (Session 2)

## Fix 1: Absolute hermes path for subprocess

**Problem:** The UI server (`uvicorn elysium_bench.ui_server:app`) spawns `subprocess.run(["hermes", "chat", ...])`. The uvicorn process does NOT have the Hermes venv in its PATH → `FileNotFoundError` → all tasks silently fall back to baseline pytest (no LLM) → benchmark completes in 6 minutes instead of 2 hours.

**Fix in `elysium_bench/hermes_interface.py`:**

```python
cmd = [
    r"C:\Users\Admin\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe",
    "chat",
    "-q", prompt_content,
    "--skills", "elysium-swarmloop",
    "-Q",
]
```

Commit: `fe76732` on `Boschi404/Elysium-Bench` branch `dev`.

**Detection symptom:** All scores ~50-57, all loops finish in <10 min total, stdout shows "No LLM or Hermes CLI — baseline testing only" or baseline mode on every task.

## Fix 2: force_baseline must return immediately

**Problem:** `TaskExecutor.execute()` had a `force_baseline` parameter added, but the baseline result was computed then OVERWRITTEN by `_try_hermes_cli()` because there was no `return` statement.

**Fix:**
```python
if force_baseline:
    result = self._run_baseline(workspace, timeout)
    result["mode"] = "baseline"
    # ... set metadata ...
    return result  # ← MUST return here, don't continue to Hermes CLI
```

## Fix 3: Workspace cleanup handles .git permissions (Windows)

**Problem:** `shutil.rmtree(workspace)` fails with `PermissionError: [WinError 5] Accesso negato` on `.git/objects/` because some git objects are read-only on Windows.

**Fix in `elysium_bench/harness.py`:**
```python
if workspace.exists():
    import os
    # Try Windows command first (handles read-only files)
    os.system(f'rmdir /S /Q "{workspace}" 2>nul')
    if workspace.exists():
        shutil.rmtree(workspace, ignore_errors=True)  # Fallback
```

Commit: `4d1f684`.

## Fix 4: typing_extensions missing in Hermes venv

**Problem:** `from fastapi import FastAPI` fails with `ModuleNotFoundError: No module named 'typing_extensions'` in the Hermes venv.

**Fix:**
```bash
python -m pip install --upgrade typing_extensions
```

The `python` here is the Hermes venv Python (`C:\Users\Admin\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe`).

## Fix 5: Server restart after code changes

After any code change to `elysium_bench/`, restart the server AND clear `__pycache__`:

```bash
# Kill old server
kill $(lsof -ti:8080) 2>/dev/null
# Clear cache
find elysium_bench -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null
# Restart
python -m uvicorn elysium_bench.ui_server:app --host 127.0.0.1 --port 8080 &
```

## Fix 6: Branch dev has UI, main has scoring

- `dev` branch: has `ui_server.py` + all UI templates + scoring fixes (merged from main)
- `main` branch: scoring fixes only, no UI
- Always work on `dev` for UI features, merge scoring fixes from `main` into `dev`
