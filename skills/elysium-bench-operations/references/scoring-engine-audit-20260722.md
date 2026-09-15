# Elysium-Bench Scoring Engine Audit — 22 July 2026

Complete audit of all 10 scoring engines and task infrastructure.

## Audit Matrix

| Category | Engine | Validation | Status | Issue |
|:---------|:-------|:-----------|:------:|:------|
| api_development | CodeScoringEngine | pytest | ✅ Solid | Ground truth via tests |
| bug_fixing | CodeScoringEngine | pytest | ✅ Solid | Ground truth via tests |
| algorithm_implementation | CodeScoringEngine | pytest | ✅ Solid | Ground truth via tests |
| data_analysis | DataScoringEngine | validate.py | ✅ Fixed | rubric.yaml was missing → flat 30% |
| mathematical_reasoning | MathScoringEngine | expected.json | ✅ Fixed | Now executes code, was text scan only |
| logical_deduction | TextScoringEngine | rubric.yaml | ⚠️ Fixed | reference.txt added, was ceiling at 100 |
| security_analysis | TextScoringEngine | rubric.yaml | ⚠️ Fixed | reference.txt added |
| code_review | TextScoringEngine | rubric.yaml | ⚠️ Fixed | reference.txt added |
| documentation_generation | TextScoringEngine | rubric.yaml | ⚠️ Fixed | reference.txt added |
| configuration_management | PlanScoringEngine | constraints.yaml | ⚠️ Fixed | Now validates Dockerfile/YAML structure |

## Fixes Applied (Commit d549ff0 → fe76732 on dev branch)

### 1. DataScoringEngine — rubric.yaml (T01-T10)

**Before:** `_rubric_check()` → no `rubric.yaml` → `max_score * 0.3` (flat 30%)
- completeness: 7.5/25, efficiency: 4.5/15, robustness: 3/10, clarity: 3/10
- Total: 40 + 7.5 + 4.5 + 3 + 3 = **58/100 invariant**

**After:** Created rubric.yaml with SQL/Pandas keywords for each task.
- completeness: 25/25, efficiency: 15/15, robustness: 10/10, clarity: 10/10
- Total: **100/100** ✅

### 2. MathScoringEngine — code execution

**Before:** `_check_answer()` scanned text for numbers matching expected.json.
If solution was Python code with correct logic but printed differently → 0/40 correctness.

**After:** `_execute_solution()` runs `python solution.py` and compares stdout.
Fallback to text scan with full credit if execution fails.

### 3. PlanScoringEngine — artifact validation

**Before:** Keyword matching on text (contains: "FROM", "RUN", "optimal"...).
A valid Dockerfile without the word "optimal" lost points.

**After:** `_validate_artifact()` scans all files for Dockerfile/YAML structure:
- `^FROM\s+\S+` pattern → 40*0.8
- `services:` in compose → YAML validation
- Syntax errors → penalty

### 4. TextScoringEngine — reference.txt (36 files)

**Before:** Rubric checks like `contains: solution`, `min_length: 100` — trivial to pass.
Any reasonable text → 100/100 (ceiling effect).

**After:** 36 reference.txt files with correct answers.
`_reference_similarity()` now computes similarity against reference.
No more ceiling effect.

### 5. task_type in task.yaml (27 files)

**Before:** 27 code tasks had no explicit `task_type` field.
Scoring engine selection depended on category name, not type.

**After:** All 90 task.yaml files now have explicit `task_type` field.

## Benchmark Results (SUPER LUNGO, 10 categories)

| Version | L1 | RT | Timeouts | Data | Notes |
|:--------|:--:|:--:|:--------:|:----:|:------|
| v0.7.2 180s | 77.3 | 47.0 | 3 | 58 | Too strict timeout |
| v0.8.0 300s | 77.8 | 77.0 | 3 | 58 | Still timeouts |
| v0.8.1 450s | 84.0 | 81.7 | 0 | 100 | Best: all fixes |

## Remaining Issues

1. **MathScoringEngine** needs expected.json with `method` and `edge_cases` fields
2. **PlanScoringEngine** needs executable validation (`docker build`, `kompose convert`)
3. **Code tasks** need per-task rubric.yaml for code quality dimensions beyond pytest
4. **v0.11.2 not yet benchmarked** — all results are from v0.8.1 era
