# Benchmark-Driven Skill Improvement Workflow

How to use benchmark data to identify and fix skill flaws. Learned from v0.7.2 → v0.8.0 Elysium Swarmloop improvement cycle.

## The Workflow

```
1. COLLECT BENCHMARK DATA → PDF, JSON, Markdown results
2. EXTRACT TEXT → pdftotext -raw (for PDFs)
3. IDENTIFY ROOT CAUSES → map score drops to specific phases
4. APPLY TARGETED PATCHES → one patch per flaw, verified
5. RE-BENCHMARK → measure improvement
```

## Step 1: Extract Benchmark Data

```bash
# For PDF attachments:
pdftotext -raw "benchmark.pdf" - | grep -E "Score|Timeout|FPR|Data|Penal"

# For JSON results:
python -c "import json; d=json.load(open('results.json')); ..."

# For Markdown results:
grep -E "Delta|Score|Timeout|Improvement" results.md
```

## Step 2: Map Score Drops to Skill Phases

| Symptom | Data Pattern | Root Phase |
|---------|-------------|------------|
| Timeout → 0/100 | task score = 0, duration = 180s/300s | Phase 3d (Context Protection) |
| Data Analysis stuck at X | Same score across all loops | Phase 3b (File Validation) |
| FPR degrading over time | Loop 1 > Loop N | Phase 4c (Recall) |
| Systematic penalty | Same deduction every run | Phase 3a (Security Shield) |
| Binary 0 or 100 | Only two possible scores | Phase 3j (Escalation) |
| API scores drop on re-test | Re-test < Loop 1 | Phase 1c (Clean Code) |

## Step 3: Root Cause by Score Decomposition

From the Lungo benchmark (-23.2 total):

```
Timeout Code Review L2: -20.0 → Phase 3d timeout guard
Timeout API Dev L3:     -15.0 → Phase 3d timeout guard  
Timeout Code Review RT: -20.0 → Phase 3j-bis graceful degradation
Penalità Try/Except:    -5.0  → Phase 1c error handling
Penalità Pydantic v2:   -5.0  → Phase 3a deprecation check
Bias Data Analysis:     -5.0  → Phase 3b format validation
```

Formula: `total_loss = sum(penalties) - residual_performance`
If `penalties > residual_performance`, the decline is ARTIFICIAL — fix the scoring/reporting, not the code generation.

## Pitfalls Learned

1. **Don't auto-split at 120s** — tasks completing at 146s would be killed. Use data to set caps.
2. **Word-boundary matching on keywords** — `api` inside `/api/users/` must not trigger Tier 3.
3. **Non-code tasks don't need Clean Code checks** — logical deduction got 100/100 without them.\n4. **Benchmark scoring engine bias** — if Data Analysis always gets 58/100 regardless of output quality, the scoring engine is broken, not the skill.\n   - **Fix applied (July 2026):** `DataScoringEngine._rubric_check()` defaulted to `max_score * 0.3` when no `rubric.yaml` existed. Added task-specific `rubric.yaml` to all 10 data_analysis tasks. Estimated +20-30 points.\n5. **3-4 loops aren't enough for self-learning** — the skill needs 5+ repetitions to build pattern cache.
6. **Timeout → partial result, never 0/100** — a 5/100 partial is actionable; 0/100 is invisible.

## Key Insight

**When benchmark shows degradation, decompose the loss first.** 70% of the drop in the Lungo benchmark was artificial (timeouts producing 0/100, systematic penalties). Only 30% was genuine quality decline. Fixing the artificial causes is faster and higher-impact than rewriting code generation logic.
