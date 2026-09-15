# HumanEval Benchmark Results

**Date:** 25 July 2026
**Skill:** Elysium Swarmloop v0.11.2
**Model:** deepseek-v4-pro (via opencode-go)

## Results

### 20-task Sample (HumanEval/0 through /19)

| Config | Passed | Failed | Time | pass@1 |
|:-------|:------:|:------:|:----:|:------:|
| **WITH skill** | 20 | 0 | 6.9 min | **100%** |
| **NO skill** | 20 | 0 | 3.3 min | **100%** |

*First NO SKILL run: 0/20 (1s per task) — hermes was broken due to click version conflict after SWE-bench install. After `pip install click==8.1.7 --force-reinstall` + `hermes-agent --upgrade`, NO SKILL correctly returned 20/20.*

### Per-task (WITH skill)

All 20 tasks passed on first attempt. Average time: 20.5s per task (fastest: 12s, slowest: 36s).

```
HumanEval/0   has_close_elements        ✅ 36s
HumanEval/1   separate_paren_groups     ✅ 32s
HumanEval/2   truncate_number           ✅ 18s
HumanEval/3   below_zero                ✅ 25s
HumanEval/4   mean_absolute_deviation   ✅ 14s
HumanEval/5   intersperse               ✅ 25s
HumanEval/6   parse_nested_parens       ✅ 14s
HumanEval/7   filter_by_substring       ✅ 26s
HumanEval/8   sum_product               ✅ 29s
HumanEval/9   rolling_max               ✅ 13s
HumanEval/10  make_palindrome           ✅ 17s
HumanEval/11  string_xor                ✅ 22s
HumanEval/12  longest                   ✅ 14s
HumanEval/13  greatest_common_divisor   ✅ 12s
HumanEval/14  all_prefixes              ✅ 12s
HumanEval/15  string_sequence           ✅ 36s
HumanEval/16  count_distinct_characters ✅ 12s
HumanEval/17  parse_music               ✅ 15s
HumanEval/18  how_many_times            ✅ 13s
HumanEval/19  sort_numbers              ✅ 27s
```

### Per-task (NO skill)

All 20 tasks passed. Average time: 10.9s per task.

## Analysis

- **Both configs hit ceiling at 100%** — HumanEval tasks are too simple for DeepSeek V4
- **Skill adds 2× overhead** (20.5s vs 10.9s) — subagent dispatch wasted on atomic functions
- **Skill value is on complex tasks** (Elysium-Bench: +18.3 pts), not atomic coding

## Windows Adapter

`human_eval.execution.check_correctness` uses `signal.setitimer()` (Unix-only) and `multiprocessing.Manager()` (requires `if __name__ == "__main__":` on Windows). The subprocess-based adapter is in `scripts/humaneval_bench.py`.

## Comparison

| Model | HumanEval pass@1 |
|:------|:----------------:|
| GPT-4 | ~88% |
| Claude 3.5 Sonnet | ~92% |
| DeepSeek V4 (no skill) | **100%** (20/20) |
| DeepSeek V4 + Elysium | **100%** (20/20) |

⚠️ 20-task sample is not statistically significant. Run full 164 tasks for publishable results.
