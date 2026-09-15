# v0.11.2 Isolated Test — BenchmarkRunner Bug Confirmation

**Date:** 23 July 2026  
**Test:** T01_api_development run through exact BenchmarkRunner code path vs full benchmark

## Isolated Test — TaskExecutor + ScoringEngine

Using the EXACT same code path as `BenchmarkRunner._run_single_task`:
- TaskExecutor with Hermes CLI (absolute path)
- force_baseline=False
- Workspace creation via temp directory
- Test files copied to workspace/workspace/tests/
- ScoringEngine with correct weights

**Result:** 73.0/100 (c:40 m:9 e:13 r:1 l:10)
- correctness=40 → pytest PASSED (7/7 tests)
- completeness=9 → code quality checks
- efficiency=13 → good performance  
- robustness=1 → try/except present but minimal
- clarity=10 → well-structured

## Full Benchmark — 100 tasks via UI

Same task T01_api_development in full benchmark run:
- correctness=0.0 → pytest FAILED
- completeness=11, efficiency=13, robustness=1, clarity=10
- Total: 35.0/100

**Root cause:** Workspace `.git` directory from previous Hermes runs blocks cleanup. New task workspace inherits stale files. Pytest runs against wrong directory or stale test files.

**Fix committed** (`fe76732` dev branch):
1. `hermes_interface.py`: absolute hermes path prevents FileNotFoundError → fallback to baseline
2. `hermes_interface.py`: force_baseline returns immediately (no Hermes override)
3. `harness.py`: workspace cleanup uses `os.system('rmdir /S /Q')` before `shutil.rmtree(ignore_errors=True)`
