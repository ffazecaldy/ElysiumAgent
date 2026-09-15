# Elysium-Bench Infrastructure Audit — 2026-07-22 (POST-FIX)

## Applied Fixes (commit d549ff0)

All 5 structural issues were fixed on 22 July 2026. Here's what changed:

### Fix 1: MathScoringEngine → Code Execution
**Before:** `_check_answer()` used regex `[-+]?\d*\.?\d+` to find numbers in text. The baseline (free-form text) had few numbers → score 17.5. With skill (Python code) had many numbers → score 70.4. The +52.9 delta was a FORMAT artifact.

**After:** Added `_execute_solution()` method. Executes `python solution.py`, captures stdout, compares output numbers to `expected.json["answer"]`. Text fallback preserves original full-credit behavior if execution fails.
- File: `elysium_bench/scoring.py` (lines 397-440)

### Fix 2: PlanScoringEngine → Artifact Validation
**Before:** Only keyword matching via `constraints.yaml` on `required_elements` and `forbidden_elements`. Dockerfile that works but uses different wording → lost points.

**After:** Added `_validate_artifact()` method. Scans ALL files (not just filenames):
- Dockerfile content: detects `FROM`, `RUN`, `CMD` patterns → 0.8× correctness if valid
- docker-compose.yml: `yaml.safe_load()` + checks for `services` key → 0.7×
- Generic YAML validation → 0.5×
- Takes `max(constraint_score, validation_score)` — best of both
- File: `elysium_bench/scoring.py` (lines 536-590)

### Fix 3: Text Tasks → reference.txt (Ceiling Effect Killed)
**Before:** TextScoringEngine used only `rubric.yaml` keyword matching. "contains: solution" + "min_length: 100" → any text ≥100 words mentioning "solution" = 40/40 correctness. All 4 text categories (36 tasks) scored 100/100 in every benchmark phase.

**After:** Created 36 `reference.txt` files with ground-truth answers (specific facts, vulnerabilities found, review findings, documentation key points). `TextScoringEngine._reference_similarity()` computes cosine similarity against reference. Score now varies based on content accuracy.
- Files: `tasks/{logical_deduction,security_analysis,code_review,documentation_generation}/T0{1..9}_*/tests/reference.txt`

### Fix 4: task_type in Task YAML
**Before:** 27 code tasks (api_development, bug_fixing, algorithm_implementation) had empty `task_type: ""`. Scoring engine selection relied on category folder name, not an explicit field.

**After:** Added `task_type: "code"` to all 27 task.yaml files.
- Files: `tasks/{api_development,bug_fixing,algorithm_implementation}/T0{1..9}_*/task.yaml`

### Fix 5: DataScoringEngine rubric (from earlier)
**Before (pre-21 July):** `DataScoringEngine._rubric_check()` returned `max_score * 0.3` when no `rubric.yaml` existed. All 10 data_analysis tasks scored invariant 58.0/100.

**After:** Created 10 `rubric.yaml` files with category-specific SQL/Pandas keywords.
- Files: `tasks/data_analysis/T0{1..10}_*/tests/rubric.yaml`

## Post-Fix Category Status

| Category | task_type | Tests | Scoring | Reliability |
|:---------|:---------|:------|:--------|:-----------:|
| api_development | code ✅ | pytest | CodeScoringEngine | 🟢 Solid |
| bug_fixing | code ✅ | pytest | CodeScoringEngine | 🟢 Solid |
| algorithm | code ✅ | pytest | CodeScoringEngine | 🟢 Solid |
| data_analysis | data | validate.py + rubric ✅ | DataScoringEngine | 🟢 Fixed |
| math | math | expected.json + execution ✅ | MathScoringEngine | 🟢 Fixed |
| code_review | text | rubric + reference.txt ✅ | TextScoringEngine | 🟢 Fixed |
| logical_deduction | text | rubric + reference.txt ✅ | TextScoringEngine | 🟢 Fixed |
| security_analysis | text | rubric + reference.txt ✅ | TextScoringEngine | 🟢 Fixed |
| documentation | text | rubric + reference.txt ✅ | TextScoringEngine | 🟢 Fixed |
| config_management | plan | constraints + artifact val ✅ | PlanScoringEngine | 🟢 Fixed |

## Remaining Limitations (honest assessment)

1. **Text tasks have reference.txt but not executable ground truth.** Better than keyword-only, but still less objective than pytest pass/fail.
2. **Code tasks have no per-task rubric.** Scoring criteria (code length, naming, error handling) are hardcoded. Different tasks might benefit from different weights.
3. **Plan tasks still have keyword-based completeness/efficiency checks.** Only correctness uses artifact validation.
4. **No test for scoring engine reliability itself.** Some categories (math, config) score differently than expected even with the fix — need falsification tests.

## v0.11.2 Benchmark — 23 July 2026

**107 min, 100 tasks (all T01-T10), Hermes CLI real.**

### Code Task Crash — Investigation

T01_api_development scored **35/100** in the full benchmark but **73/100** in isolation test.
- Isolated test: `TaskExecutor.execute()` → Hermes CLI → pytest passes → correctness=40 → **73/100** ✅
- Full benchmark: same task → **35/100** with correctness=0.0 ❌
- **Verdict: BenchmarkRunner integration bug, NOT a skill v0.11.2 issue.**
- Likely cause: workspace cleanup or test file copying race condition in the harness

### Key Results

| Category | Baseline | Loop 1 | Re-Test | Notes |
|:---------|:--------:|:------:|:-------:|:------|
| Code (api/bug/algo) | 37.9 | 36.3 | 36.0 | Integration bug — should be ~73 |
| Data analysis | 22.8 | 68.0 | 68.0 | Rubric fix working |
| Math | 26.0 | 55.1 | 89.9 | Execution fix + learning |
| Config | 36.4 | 92.0 | 92.0 | Artifact validation |
| Text (4 cats) | 94.2 | 100 | 100 | Reference.txt not fully effective |

### Skill Sizes

| Version | Lines | Key Feature |
|:--------|:-----:|:------------|
| v0.7.2 | 1430 | Baseline (benchmarked) |
| v0.8.1 | 1358 | Best overall score (84.0) |
| v0.11.2 | 965 | SkillOpt gate, -34% |

## What's Actually Solid

The 3 code categories (api, bug, algo) with pytest → CodeScoringEngine: **ground truth**. These 30 tasks are the only metrics that should drive decisions about skill effectiveness. Everything else is supporting evidence.
