# Session Results — 21 July 2026

Benchmark runs executed during this session on Hermes Desktop (Windows 10, deepseek-v4-flash/pro via opencode-go).

## Run 1: Quick test — WITH skill (logical_deduction)

**Config:** config_quick.yaml (baseline=off, loops=2, logical_deduction)
**Duration:** 417s (7 min)
**Skill:** `elysium-swarmloop` v0.8.1, subagents=50

| Phase | Score |
|-------|-------|
| Loop 1 | 100.0/100 |
| Loop 2 | 100.0/100 |
| Re-Test | 100.0/100 |
| Δ | +0.0 |

**Result:** Text tasks max out immediately. No improvement possible. Useful only as smoketest.
**File:** `results/results_20260721_170246.json`

## Run 2: Full benchmark — WITH skill, 10 categories × 3 loops + retest

**Config:** default config.yaml (baseline=on, loops=3, all 10 categories)
**Duration:** 6175s (1h 43min)
**Skill:** `elysium-swarmloop` v0.8.1 with `subagents_max: 100`

| Phase | Average |
|-------|---------|
| Baseline (no Elysium) | 58.4/100 |
| Loop 1 (Elysium) | 63.5/100 |
| Loop 2 (practice) | 69.2/100 |
| Loop 3 (practice) | 60.9/100 |
| Re-Test | 68.4/100 |
| Δ Re-Test vs Loop 1 | **+4.9** |
| Δ Re-Test vs Baseline | **+9.9** |

**File:** `results/results_20260721_184717.json`

### Per-Category Detail

| Category | Type | Baseline | L1 | L2 | L3 | Re-Test | Δ L1→RT |
|----------|------|----------|----|----|----|---------|---------|
| API Development | code | 36.2 | 35.0 | 35.0 | 30.0 | 31.0 | -4.0 📉 |
| Bug Fixing | code | 41.0 | 39.0 | 34.0 | 39.0 | 41.0 | +2.0 |
| Algorithm | code | 36.5 | 34.0 | 32.0 | 35.0 | 32.0 | -2.0 📉 |
| Data Analysis | data | 26.0 | 26.0 | 26.0 | 26.0 | 26.0 | 0.0 ➡️ |
| Math Reasoning | math | 26.0 | 55.1 | 65.4 | 59.9 | 60.9 | **+5.8 📈** |
| Logical Ded. | text | 95.8 | 100.0 | 100.0 | 100.0 | 100.0 | 0.0 ➡️ |
| Security | text | 95.0 | 100.0 | 100.0 | 100.0 | 100.0 | 0.0 ➡️ |
| Code Review | text | 96.2 | 100.0 | 100.0 | 100.0 | 100.0 | 0.0 ➡️ |
| Documentation | text | 96.2 | 100.0 | 100.0 | 100.0 | 100.0 | 0.0 ➡️ |
| Configuration | plan | 36.5 | 45.8 | 100.0 | — | 42.1 | -3.7 📉 |

### Key Findings

1. **Code tasks (API, Bug, Algorithm): correctness = 0/40 across ALL phases and ALL tasks.** Not a bug — confirmed by v0.9.0 falsification tests. Working code gets correctness=40.0, broken code gets 0.0. Hermes generates code that doesn't pass pytest. completeness/efficiency/clarity are static (11, 13, 10).

2. **Text tasks at ceiling (91-100 baseline).** Rubric keyword matching — model answers perfectly first time. No room for improvement.

3. **Data Analysis invariant at 26/100.** Known DataScoringEngine anomaly (fixed in v0.8.0+ with content-aware heuristics, verified 5/5 pairs in v0.9.0).

4. **Math is the ONLY category with real improvement.** Baseline 26.0 → L1 55.1 (+112%) → Re-Test 60.9. Some tasks match exact answers → correctness=40.

5. **Configuration is unstable.** T02 (Docker Compose) scored 100/100 in L2. T01 (Dockerfile) retest scored 42.1 — worse than baseline.

6. **The +4.9 Δ is diluted** by 7 categories where improvement is impossible (text: already perfect) or broken (code: correctness=0, data: invariant scorer). The real signal is concentrated in Math.

## Hermes Interface Fixes Applied

File: `elysium_bench/hermes_interface.py`

```python
cmd = [
    "hermes", "chat",
    "-q", prompt_content,
    "--skills", "elysium-swarmloop",  # KEPT — works with proper flags
    "-Q",                              # Quiet mode
    "--yolo",                          # Bypass approval prompts
    "--accept-hooks",                  # Auto-approve shell hooks
    "--source", "tool",                # Mark programmatic call
]

# File redirect avoids pipe buffer deadlock:
with open(stdout_file, "w", encoding="utf-8") as out, \
     open(stderr_file, "w", encoding="utf-8") as err:
    result = subprocess.run(cmd, stdout=out, stderr=err, text=True, timeout=timeout + 60)

stdout = stdout_file.read_text(encoding="utf-8", errors="replace")
```

## Process Management

- **6+ Hermes.exe accumulating** = orphaned child processes from KILLED runs, NOT recursive cascade
- `taskkill /F /IM hermes.exe` kills EVERYTHING including user session — NEVER use while user is chatting
- Safe: kill only PIDs of child processes spawned by benchmark
- Benchmark output files written to `~/Desktop/Hermes/.elysium-bench/`

## Skill Updated to v0.9.0

During session, `elysium-swarmloop` skill was updated from v0.8.1 → v0.9.0 from GitHub (`Boschi404/Elysium-Swarmloop`). Key additions: transparency note, CodeScoringEngine falsification tests (ceiling effect confirmed: broken code=0.0, working code=40.0), DataScoringEngine fix verified 5/5 pairs.
