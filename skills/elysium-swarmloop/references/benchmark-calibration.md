# Elysium Swarmloop — Benchmark Calibration Reference

## Timeout Sweet Spot (Critical)

Session 2026-07-17 discovered through 4 iterations:

| Timeout | L1 Score | RT Score | Timeouts | Verdict |
|:-------:|:--------:|:--------:|:--------:|:-------:|
| 120s (draft) | 84.0 | 86.8 | 0 | Too aggressive — would kill code_review (265s) |
| 180s (v0.7.2) | 84.0 | 86.8 | 0 | Used 600s actual cap — RT was good but slow |
| 300s (v0.8.0) | 84.2 | 83.8 | 3 | Killed bug_fixing RT (-9), algorithm RT (-7) |
| **450s (v0.8.1)** | **84.0** | **81.7** | **0** | **Optimal — covers code_review 265s + 185s buffer** |

**Rule: never tune timeout below 450s without benchmark evidence.**
See Phase 3d point 5 in SKILL.md.

## v0.8.1 Data (10 categories)

### Loop 1: avg 84.0 — Re-Test: avg 81.7 — Delta: -2.2

| Category | L1 | RT | Delta |
|:---------|:--:|:--:|:-----:|
| api_development | 75 | 75 | 0 |
| bug_fixing | 79 | 79 | 0 |
| algorithm | 72 | 70 | -2 |
| data_analysis | 100 | 100 | 0 |
| mathe_matical | 75.6 | 55.1 | -20.5 |
| logical_deduction | 100 | 100 | 0 |
| security_analysis | 100 | 100 | 0 |
| code_review | 100 | 100 | 0 |
| documentation | 100 | 100 | 0 |
| configuration | 38.3 | 38.3 | 0 |

### Known Gaps
- **configuration_management** (~38): plan-scoring engine penalty, not skill quality
- **mathe_matical** (75→55): inconsistent Re-Test, possible context saturation
- **Data Analysis fix** (58→100): solved by Phase 3b + 3a + 1c combined

### Progression
```
v5.2.0: -23.2 → v0.7.2: -30.3 → v0.8.0: -0.8 → v0.8.1: -2.2
Delta improvement: +21 points from baseline.
```
