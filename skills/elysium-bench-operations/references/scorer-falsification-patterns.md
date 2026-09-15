# Scorer Falsification Patterns — Concrete Test Recipes

## Pattern 1: Ceiling Effect vs Bug Distinction

When a scoring dimension is invariant (same value across all tasks), determine WHY:

### Test: Create 3+ deliberately BROKEN solutions + 1 CORRECT solution

```python
# BROKEN SOLUTION 1: Syntax error (import fails)
(main_dir / 'main.py').write_text('''
from fastapi import FastAPI
app = FastAPI()
@app.get("/users")
def get_users(          # ← missing parenthesis
    return [{"id": 1}]
''')

# BROKEN SOLUTION 2: Wrong return type
(main_dir / 'main.py').write_text('''
from fastapi import FastAPI
app = FastAPI()
@app.get("/users")
def get_users():
    return "not json"   # ← should return JSON
''')

# BROKEN SOLUTION 3: Minimal stub (no routes)
(main_dir / 'main.py').write_text('''
from fastapi import FastAPI
app = FastAPI()
''')

# CORRECT SOLUTION: Full implementation
(main_dir / 'main.py').write_text('''
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
app = FastAPI()
class User(BaseModel):
    name: str
    email: str
@app.get("/users")
def get_users():
    return [{"id": 1, "name": "Alice"}]
''')
```

### Interpretation

| Broken solutions | Correct solution | Verdict |
|:-----------------|:-----------------|:--------|
| correctness=0.0 | correctness=40.0 | ✅ **Ceiling effect** — scorer works, tests are just too easy |
| correctness=40.0 | correctness=40.0 | ❌ **Bug** — scorer ignores test results |
| correctness=0.0 | correctness=0.0 | ⚠️ **Tests not found** — check pytest execution path |

### Real result (2026-07-22, Elysium-Bench T01_api_development):
- BROKEN_SYNTAX: correctness=0.0, pytest returncode=1, 7 errors
- BROKEN_RETURN: correctness=0.0, pytest returncode=1, 1 fail
- MINIMAL_STUB: correctness=0.0, pytest returncode=1, 1 fail
- CORRECT_SOLUTION: correctness=40.0, pytest returncode=0, 7 pass

**Verdict: ceiling effect confirmed.** All benchmark solutions pass all tests → correctness always 40.0.

## Pattern 2: DataScoringEngine Content-Aware Verification

When `_rubric_check` returns static values (e.g., always `max_score * 0.3`):

### Test: Create 5 pairs (good, bad) covering different data task types

```python
pairs = [
    {"name": "SQL_sales", "good": "SELECT ... FROM ... JOIN ... GROUP BY ...", "bad": "x = 1"},
    {"name": "Pandas_clean", "good": "import pandas\ndf.dropna()\ntry: ...", "bad": "print(1)"},
    {"name": "SQL_join", "good": "SELECT ... JOIN ... WHERE ... ORDER BY ...", "bad": "conn.execute('SELECT *')"},
    {"name": "Pandas_merge", "good": "pd.merge(...)\n.groupby().agg()\ntry: ...", "bad": "pd.DataFrame({'a':[1]})"},
    {"name": "SQL_subquery", "good": "WITH cte AS (...) SELECT ... CASE WHEN ...", "bad": ","},
]
```

### Expected output

| Pair | GOOD total | BAD total | Delta | Status |
|:-----|:----------:|:---------:|:-----:|:------:|
| SQL_sales | 91.7 | 40.0 | +51.7 | ✅ |
| Pandas_clean | 46.7 | 40.0 | +6.7 | ✅ |
| SQL_join | 70.0 | 45.0 | +25.0 | ✅ |
| Pandas_merge | 51.7 | 40.0 | +11.7 | ✅ |
| SQL_subquery | 71.7 | 40.0 | +31.7 | ✅ |

**All 5 must differentiate.** If even 1 pair shows same score → fix incomplete.

### Known limitation
`correctness` for data tasks uses `_run_validation_script()` which checks `validate.py` returncode. If `validate.py` always exits 0 (even for bad input), correctness stays at 40.0 for both good and bad. This is a SEPARATE ceiling effect from the `_rubric_check` fix.

## Pattern 3: Content-Aware Fallback for Data Tasks

Replace static `max_score * 0.3` with output-content analysis:

```python
def _rubric_check(self, output: str, dimension: str) -> float:
    # ... existing rubric.yaml check ...
    
    # CONTENT-AWARE FALLBACK (when no rubric.yaml)
    output_lower = output.lower().strip()
    if not output_lower:
        return 0.0
    
    if dimension == "completeness":
        score = 0.0
        if "select" in output_lower or "insert" in output_lower:
            score += max_score * 0.3
        if "join" in output_lower or "group by" in output_lower:
            score += max_score * 0.25
        if "where" in output_lower or "having" in output_lower:
            score += max_score * 0.2
        if "import pandas" in output_lower or "df[" in output_lower:
            score += max_score * 0.25
        return min(max_score, score)
    
    # ... similar for efficiency, robustness, clarity ...
```

## Release Engineering: "No Claim Without Artifact"

When publishing benchmark-based claims:
1. Every quantitative claim must trace to a specific file in the repo
2. If no artifact exists, write "non verificato" — not the number
3. Falsification tests (Pattern 1) must be in the repo as executable scripts
4. Old results are NEVER overwritten — save as separate files with date suffix
5. Changelog must state per-phase: completed with proof, blocked, or failed

### v0.8.1→v0.9.0 progression (real example):
- v0.8.1: "timeout 450s" — based on real data (code_review max 265s + buffer)
- v0.8.2: "audit published" — invariant correctness documented with data
- v0.8.3: "transparency" — claims softened, caveat added to all public text
- v0.9.0: "evidence" — falsification tests run, results saved as artifacts
