# Benchmark Version Comparison — 10 Categories (SUPER LUNGO)

Multi-version comparison of Elysium Swarmloop on the full 10-category Elysium-Bench.

## Raw Data

### Loop 1 Scores

| Categoria | v0.7.2 | v0.8.0 | v0.8.1 | v0.11.2† |
|:----------|:------:|:------:|:------:|:--------:|
| api_development | 73.0 | 72.0 | **75.0** | 35.0 |
| bug_fixing | 79.0 | 79.0 | 79.0 | 39.0 |
| algorithm_implementation | 66.0 | 70.0 | **72.0** | 35.0 |
| data_analysis | 58.0 | 58.0 | **100.0** | 68.0 |
| mathematical_reasoning | 55.1 | 56.9 | **75.6** | 55.1 |
| logical_deduction | 100 | 100 | 100 | 100 |
| security_analysis | 100 | 100 | 100 | 100 |
| code_review | 100 | 100 | 100 | 100 |
| documentation_generation | 100 | 100 | 100 | 100 |
| configuration_management | 42.1 | 42.1 | 38.3 | **92.0** |

### Re-Test Scores

| Categoria | v0.7.2 | v0.8.0 | v0.8.1 | v0.11.2† |
|:----------|:------:|:------:|:------:|:--------:|
| api_development | 75.0 | 75.0 | 75.0 | 35.0 |
| bug_fixing | 79.0 | 76.0 | 79.0 | 39.0 |
| algorithm_implementation | 68.0 | 68.0 | **70.0** | 34.0 |
| data_analysis | 58.0 | 58.0 | **100.0** | 68.0 |
| mathematical_reasoning | 55.1 | 58.1 | 55.1 | **89.9** |
| logical_deduction | 100 | 100 | 100 | 100 |
| security_analysis | 0.0* | 100 | 100 | 100 |
| code_review | 0.0* | 100 | 100 | 100 |
| documentation_generation | 0.0* | 100 | 100 | 100 |
| configuration_management | 35.3 | 35.3 | 38.3 | **92.0** |

*\* Timeout (180s hard cap)*

## Summary

| Metrica | v0.7.2 | v0.8.0 | v0.8.1 | v0.11.2† |
|:--------|:------:|:------:|:------:|:--------:|
| Loop 1 AVG | 77.3 | 77.8 | **84.0** | 72.4 |
| Re-Test AVG | 47.0 | 77.0 | **81.7** | 75.8 |
| Code AVG (L1) | 72.7 | 73.7 | **75.3** | 36.3 |
| Δ L1→RT | -30.3 | -0.8 | -2.2 | **+3.4** |
| Duration | 55.7 min | 70.4 min | 60.7 min | 107 min |
| Timeouts | 3 | 3 | **0** | 0 |
| Skill lines | 1430 | 1358 | 1358 | **965** |
| Data Analysis | 58 | 58 | **100** | 68 |

## Key Findings

1. **v0.8.1 is the best performer** — 84.0 L1, 81.7 RT, highest code scores, zero timeouts
2. **v0.11.2 code scores are artificially low** — BenchmarkRunner bug, NOT skill regression. Isolated test: 73/100 on same task
3. **Data analysis rubric fix** (v0.8.1) added +42 pts — confirmed effective
4. **MathScoringEngine execution fix** (v0.8.1 dev branch) eliminates floor effect
5. **Text tasks ceiling effect** — 4 categories always at 100 because rubric is too easy
6. **Self-learning never detected** — all versions flag "Learning Detected: NO"
7. **Timeout sweet spot: 450s** — covers code_review (265s) with buffer
8. **Skill size vs performance** — smaller ≠ better. v0.8.1 (1358 lines) > v0.11.2 (965) > v0.7.2 (1430). Goldilocks is ~1300 lines.

## v0.11.2 Investigation

### The Bug

BenchmarkRunner with all 100 tasks produced code scores of 35-39 instead of 72-79.
- correctness=0.0 (pytest failed)
- completeness/efficiency/clarity normal (11/13/10)

### Root Cause

The BenchmarkRunner's `_run_single_task` + `_score_task` pipeline has an integration issue when running at scale (100 tasks):
- Workspace creation/deletion may interfere with each other
- Test files may be overwritten by Hermes workspace operations
- Scoring may happen on wrong workspace

### Proof

Isolated test of single code task using SAME code path (TaskExecutor + ScoringEngine):
```
T01_api_development: 73/100 (c:40 m:11 e:13 r:1 l:10)
```
Same task, same skill, same runner — but in isolation. Score matches v0.8.1.

### Fix

Use workspace isolation per task, explicit cleanup after scoring (not before), and verify solution files exist before scoring.

## v0.11.2 Benchmark Results (22 July 2026)

Full run: 100 tasks, 107 minutes, `results_20260723_145429.json`

- Baseline: 57.5 → Loop1: 72.4 → Loop2: 72.5 → Loop3: 74.8 → ReTest: 75.8
- Improvement: Δ RT-BL = +18.2, Δ RT-L1 = +3.4
- Learning Detected: NO
- Only math shows genuine improvement (+34.8 L1→RT) — likely scoring engine fix effect
