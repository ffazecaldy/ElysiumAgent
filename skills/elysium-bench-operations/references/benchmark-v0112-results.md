# v0.11.2 Super Lungo Benchmark Results

**Date:** 23 July 2026 | **Duration:** 107 min | **Tasks:** 100 (all 10 per category)

## Full Results

| Categoria | N | Baseline | Loop 1 | Re-Test | Δ RT-BL |
|:----------|:-:|:--------:|:------:|:-------:|:-------:|
| algorithm_implementation | 10 | 36.4 | 35.0 | 34.0 | -2.4 |
| api_development | 10 | 36.2 | 35.0 | 35.0 | -1.2 |
| bug_fixing | 10 | 41.0 | 39.0 | 39.0 | -2.0 |
| code_review | 10 | 93.3 | 100 | 100 | +6.7 |
| configuration_management | 10 | 36.4 | 92.0 | 92.0 | +55.6 |
| data_analysis | 10 | 22.8 | 68.0 | 68.0 | +45.2 |
| documentation_generation | 10 | 94.2 | 100 | 100 | +5.8 |
| logical_deduction | 10 | 96.7 | 100 | 100 | +3.3 |
| mathematical_reasoning | 10 | 26.0 | 55.1 | 89.9 | +63.9 |
| security_analysis | 10 | 92.5 | 100 | 100 | +7.5 |
| **MEDIA** | **100** | **57.5** | **72.4** | **75.8** | **+18.2** |

## Key Findings

### Code Task Crash (35 vs expected 73)
Code tasks scored 35-39 instead of 72-79. Root cause:
1. Isolated test: TaskExecutor → Hermes CLI → **73/100** for T01_api_development ✅
2. Benchmark: same task → **35/100** (correctness=0.0) ❌
3. Likely integration bug in BenchmarkRunner, not skill issue
4. Scoring engine runs pytest on `task_dir/tests/` not workspace — if Hermes writes to wrong directory, correctness drops

### Version Comparison (10-category super lungo)

| Version | Loop 1 | Re-Test | Code Avg | Size | Timeouts |
|:--------|:------:|:-------:|:--------:|:----:|:--------:|
| v0.7.2 (180s) | 77.3 | 47.0 | 72.7 | 1430 | 3 |
| v0.8.0 (300s) | 77.8 | 77.0 | 73.7 | 1358 | 3 |
| **v0.8.1 (450s)** | **84.0** | **81.7** | **75.3** | 1358 | **0** |
| v0.11.2 (450s) | 72.4 | 75.8 | 36.3* | 965 | 0 |

*Code avg impacted by integration bug.

### Skill Evolution
| Version | Key Changes |
|:--------|:------------|
| v0.11.2 | SkillOpt gate, -34% size, rejected_patterns, stable/candidate, .partial saves |
| v0.9.1 | 7 fixes (pattern cache, __fields__, HTTPException, 4-Band, Global Re-Check, degradation, .partial) |
| v0.8.1 | Timeout 450s (optimal sweet spot) |
| v0.8.0 | Word-boundary, Clean Code filtered, Tier 1 Fast-Path expanded |
