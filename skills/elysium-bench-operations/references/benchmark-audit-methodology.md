# Benchmark Audit Methodology — Scoring Engine Verification

## When to Use

- Benchmark scores seem invariant across tasks/loops/categories
- "Self-improving" claims cannot be verified because scores don't change
- Before publishing quantitative claims based on benchmark results

## Step 1: Extract Scores from JSON

```python
import json, statistics

with open("risultati/medium_results_*.json") as f:
    data = json.load(f)

correctness_values = []
for loop_key in data["loops"]:
    for task_id, task in data["loops"][loop_key].items():
        c = task.get("correctness", None)
        if c is not None and task.get("total", 0) > 0:  # exclude timeouts
            correctness_values.append(c)

stdev = statistics.stdev(correctness_values) if len(correctness_values) > 1 else 0
print(f"correctness: mean={statistics.mean(correctness_values):.1f} stdev={stdev:.3f} n={len(correctness_values)}")
# If stdev == 0.000 → SCORER IS BROKEN
```

## Step 2: Diagnose the Cause

### Cause A: Static fallback (most common)
Check the scoring engine for patterns like:
```python
if not rubric_file.exists():
    return max_score * 0.3  # ← STATIC: same value for every input
```
**Fix**: Replace with content-aware heuristics that check actual output content (SQL keywords, Pandas usage, error handling, comments, code structure).

### Cause B: Ceiling effect
Check if the scoring function returns `max_score` when a condition is always true:
```python
if result.returncode == 0:  # all tests pass
    return max_score  # ← always 40.0 if tests are easy
```
**Fix**: Make tests harder (more edge cases), or weight correctness by test count/ratio instead of binary pass/fail.

### Cause C: Silent exception
```python
except Exception:
    return 0.0  # ← swallows real errors, returns default
```
**Fix**: Log the exception, return partial score, or re-raise.

## Step 3: Fix in Elysium-Bench repo (NOT in the skill repo)

The scoring engine lives in `Elysium-Bench/elysium_bench/scoring.py`, not in `Elysium-Swarmloop/SKILL.md`. Fix the code, commit, then re-run benchmarks.

## Step 4: Verify Fix with Deliberate Test

```python
# Create two solutions: one good, one deliberately bad
# Run scorer on both — scores MUST differ
good_score = engine.evaluate()  # should be higher
bad_score = engine_bad.evaluate()  # should be lower
assert good_score.total != bad_score.total, "Scorer still invariant!"
```

## Step 5: Re-run Benchmark and Publish Separately

- Save new results as `risultati/medium_v083_scorer_fixed_<date>.json`
- Do NOT overwrite old results — both needed for before/after comparison
- Update BENCHMARK_RESULTS.md with separate "Post-Fix" section

## Historical Context

- **v0.8.2 audit**: Found `correctness=40.0` on 54/54 non-timeout tasks. `DataScoringEngine` returned 58.0 for every input.
- **v0.8.3 fix**: `DataScoringEngine._rubric_check()` replaced static `max_score * 0.3` with content-aware heuristics. Test: good=50.0 vs bad=4.5 (was both 58.0).
- **CodeScoringEngine**: `correctness=40.0` is NOT a bug — ceiling effect from easy tests. Fix requires harder test suites, not scorer changes.
