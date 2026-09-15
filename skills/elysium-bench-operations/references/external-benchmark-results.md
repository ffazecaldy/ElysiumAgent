# External Benchmark Results — Elysium Swarmloop v0.11.2

**Date:** July 2026 | **Model:** DeepSeek V4 Pro | **Skill:** 965 lines (-34% from v0.8.x)

## Summary: When the Skill Adds Value

| Benchmark | Task Type | NO SKILL | CON SKILL | Δ | Verdict |
|:----------|:----------|:--------:|:---------:|:-:|:-------|
| HumanEval 20 | Single functions | 100% | 100% | 0 | ❌ No gain |
| MBPP 20 | Single functions | **95%** | 85% | -10 | ❌ Hurts |
| BigCodeBench 20 | Multi-line funcs | TBD | 55% | — | ⚠️ Medium |
| Elysium-Bench | Multi-file complex | 57.5 | **75.8** | **+18** | ✅ SKILL WINS |
| SWE-bench Lite | Real repo bugs | — | 80% patches | — | ⚠️ Eval blocked |
| TaskBench | Tool decomposition | — | 3-6 steps | — | ⚠️ Diff granularity |

**Rule:** Skill helps on complex multi-file (+18). Hurts or neutral on single-function (-10 to 0). 4-Band Filter should fast-path single-function tasks (Tier 1).

## HumanEval (164 Python functions, pass@1)

- **20 tasks, 100% both ways** — too easy for any modern LLM
- DeepSeek V4 solves all 20 atomically with or without skill
- Task time: 10-36s (skill), 7-30s (no skill)
- Skill adds only overhead — subagents, quality gates = 2× slower
- **Not useful for skill benchmarking** — tasks hit ceiling immediately

## MBPP (257 Python functions, 20 tested)

- WITH skill: **17/20 (85%)** — NO SKILL: **19/20 (95%)**
- **Skill hurts performance on atomic tasks** — overhead without benefit
- Root cause: skill renames functions for clarity but breaks test assertions
- Fix: extract expected function name from `assert func_name(...)` in first test
- MBPP prompts don't include function signatures (unlike HumanEval)

## BigCodeBench (1140 complex functions, 20 tested)

- WITH skill: **11/20 (55%)** — harder than HumanEval/MBPP
- Functions with imports, multi-line logic, edge cases
- **Better middle ground** — not trivial, not impossible
- Task time: 9-82s (skill), wider variance on complex tasks

## SWE-bench Lite (300 GitHub issues, 10 predictions)

- **8/10 (80%)** patches generated with skill
- Django tasks faster (60-530s), Astropy slower (64-355s)
- 2 no-diff: text analysis instead of patches when codebase too large
- **Evaluation blocked on Windows** — needs Linux + Docker + `resource` module
- Prediction file saved in official format: `swebench_predictions.json`
- Linux eval command:
  ```bash
  python -m swebench.harness.run_evaluation \
    --dataset_name princeton-nlp/SWE-bench_Lite \
    --predictions_path swebench_predictions.json --run_id elysium-v0.11.2
  ```

## TaskBench (17K tool tasks, 5 tested)

- Elysium: high-level decomposition (3-6 steps)
- TaskBench: micro-steps (100-400 tool invocations)
- Different granularity, not wrong — skill does task-level, not tool-level
- Not directly comparable without tool execution environment

## Key Takeaways for Skill Design

1. **4-Band Filter should detect single-function tasks** → Tier 1 Fast-Path
2. **Subagent dispatch wastes tokens on atomic tasks** — 0 subagents when `def` count = 1
3. **Function renaming (Phase 1c) must preserve test assertions** — extract name from tests
4. **External benchmarks need adapters** — function name extraction, test format conversion
5. **SWE-bench needs file access** — LLM-only patch generation produces plausible but broken diffs
