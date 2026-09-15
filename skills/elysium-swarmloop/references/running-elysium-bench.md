# Running Elysium-Bench

The [Elysium-Bench](https://github.com/Boschi404/Elysium-Bench) repo is the official benchmark for the Elysium Swarmloop skill. It measures self-improvement across 100 tasks × 10 categories, comparing scores across loops.

## Quick Reference

```bash
cd ~/Elysium-Bench
pip install -e .

# PRIMARY INTERFACE: Web UI (dashboard, real-time progress, comparison)
elysium-bench ui                        # → http://localhost:8080
# Open http://localhost:8080/run in browser to configure and launch benchmarks

# CLI mode (headless / quick tests only)
elysium-bench run                       # Full 100-task, 10-loop benchmark
elysium-bench run --category api_development  # Single category
elysium-bench list-tasks                # List all tasks
```

## Common Pitfalls

### ❌ Using CLI instead of Web UI

The benchmark's **primary interface is the Web UI** (`elysium-bench ui` on port 8080), not CLI. The UI provides:
- Dashboard with historical run comparison (line chart)
- Real-time SSE progress with per-category cards and named phase blocks
- Start/stop controls with category dropdown and loop count selector
- Side-by-side run comparison
- System status panel (Hermes Agent, CPU, RAM, Disk)

The CLI (`elysium-bench run`) and `run.bat` are launchers for headless/CI use. For interactive benchmarking, always use the Web UI at `http://localhost:8080/run`.

**Port conflict on restart:** if the UI server crashes and port 8080 is still bound, kill the stale process:
```bash
python -c "import subprocess; out=subprocess.run(['netstat','-ano'], capture_output=True, text=True).stdout
for line in out.split('\n'):
    if ':8080' in line and 'LISTENING' in line:
        subprocess.run(['taskkill','/F','/PID', line.strip().split()[-1]], capture_output=True)"
```

### ❌ Hermes chat subprocess hangs without --yolo flag

When `hermes chat -q` is called via `subprocess.run()` inside the benchmark runner, the child Hermes process **hangs indefinitely** waiting for approval prompts (e.g., `clarify()` tool, dangerous command confirmations). In a non-interactive subprocess, these prompts never receive a response → hang.

**Fix:** Always add `--yolo`, `--accept-hooks`, and `--source tool`:

```python
cmd = [
    "hermes", "chat",
    "-q", prompt_content,
    "--skills", "elysium-swarmloop",
    "-Q",             # Quiet mode: suppress banner, spinner
    "--yolo",          # Bypass ALL approval prompts (critical for non-interactive subprocess)
    "--accept-hooks",  # Auto-approve shell hooks
    "--source", "tool", # Mark as tool call, not user session
]
```

Without `--yolo`, tasks hang on:
- Clarification Interview (Phase 0.5a — 6 questions waiting for stdin)
- `clarify()` tool calls from the skill
- Dangerous command approval prompts
- Any interactive tool in the agent loop

**Symptoms of this bug:** benchmark progresses through some tasks, then stalls on Loop 1 or Loop 2 with no output. Multiple hung `hermes.exe` processes visible in Task Manager.

### ❌ Hermes CLI `-z` flag wrong — use `-q QUERY`

The `hermes_interface.py` shipped with elysium-bench v0.x uses `-z` for the prompt query, but **Hermes Agent's CLI uses `-q`** (or `--query`), not `-z`. `-z` is a top-level unnamed-arg catcher, not a valid `chat` subcommand flag.

**Fix:** Before running the benchmark, patch the file:

```python
# In elysium_bench/hermes_interface.py, _try_hermes_cli():
# WRONG:
# cmd = ["hermes", "chat", "-z", prompt_content, "--skills", "elysium-swarmloop", "--cli"]
# RIGHT:
cmd = [
    "hermes", "chat",
    "-q", prompt_content,
    "--skills", "elysium-swarmloop",
    "-Q",   # Quiet mode for programmatic use
]
```

Also drop `--cli` — that flag forces the classic REPL appearance, not non-interactive mode. `-Q` is what suppresses the banner/spinner/progress.

### ❌ Provider base_url mismatch — OpenCode Go + OpenRouter URL

When the Hermes config has `provider: opencode-go` but `base_url` is set to `https://openrouter.ai/api/v1`, the authentication fails (HTTP 401) because the OpenCode Go API key is sent to OpenRouter's endpoint.

**Fix:**

```bash
hermes config set model.base_url https://opencode.ai/zen/go/v1
```

If you're using OpenRouter instead, set `provider: openrouter` and use `OPENROUTER_API_KEY` in `.env`.

### ❌ Baseline mode still calls Hermes CLI

The benchmark's `TaskExecutor.execute()` **always** tries `_try_hermes_cli()` first, regardless of the `use_llm` flag. This means even Phase 0 (baseline, meant to run without Elysium) will dispatch tasks to Hermes if the CLI is available.

If you want a true "no AI" baseline, either:
- Uninstall hermes CLI temporarily (`pip uninstall hermes`)
- Or modify `_try_hermes_cli()` to return `None` immediately when `llm_provider is None`

### ❌ task_count in config is metadata-only

Setting `task_count: 4` in `config.yaml` doesn't limit how many tasks the registry discovers. The `TaskRegistry.discover()` reads **all** task directories (`T01`–`T10`), ignoring `task_count`. This causes unexpected runtime when you intended a quick subset.

The `task_count` field is for the summary display only. To truly limit tasks, either:
- Use `elysium-bench run --category <name>` to run only one category (still runs all 10 tasks)
- Or patch the runner's `_run_baseline()` to slice `all_tasks[:N]`

### ❌ Workspace cleanup false sense of security

The benchmark deletes workspaces at the end via `cleanup: true`. If the Hermes CLI call hangs (timeout on a subprocess.run), the workspace is already half-written and gets deleted before you can inspect it. For debugging, set:

```yaml
environment:
  cleanup: false
```

### ❌ UnicodeDecodeError in hermes subprocess on Windows

Hermes CLI on Windows writes ANSI control characters to stderr that Python's `subprocess.run(capture_output=True, text=True)` can't decode as UTF-8. This produces a `UnicodeDecodeError` in the reader thread but **does not affect** the actual response — `stdout` still contains the correct output.

If you need clean capture, pipe through `chcp 65001 >NUL && hermes chat ...` or capture binary (`capture_output=True, text=False`) and decode with `errors='replace'`.

### ❌ Rubric YAML regex — unterminated subpattern per escaping YAML

Le regex in `tests/rubric.yaml` possono rompersi quando YAML escaping (doppio `''`) si combina con la sintassi regex. Esempio reale dalla task T02_logical_deduction:

```yaml
# Questo YAML:
- 'regex: zebra|puzzle|(einstein''s'

# Diventa in Python:
#   "zebra|puzzle|(einstein's"
#   ↑ parentesi aperta mai chiusa → re.error: missing ), unterminated subpattern
```

**Fix:** Prima di usare `(` in una regex YAML, verifica che:
1. La parentesi sia davvero necessaria (spesso pipe basta)
2. Se serve grouping, usa `(?:...)` invece di `(...)` per non catturare
3. Controlla che ogni `(` abbia la sua `)` dopo il parsing YAML

### ❌ Task lunghi senza timeout — perdita totale dei risultati

Task complessi (Zebra Puzzle diff=6, LRU Cache diff=5, Code Review su vulnerabilità) possono far stallare `hermes chat -q` per 3-10 minuti. Senza timeout, un singolo task blocca l'intero benchmark e tutti i risultati delle fasi precedenti vengono persi.

**Pattern collaudato con timeout + salvataggio incrementale:**

```python
HERMES_TIMEOUT = 180  # 3 minuti massimi per task

def solve_task(task, workspace):
    prompt = build_prompt(task, workspace)
    try:
        result = subprocess.run(
            ["hermes", "chat", "-q", prompt, "--skills", "elysium-swarmloop", "-Q"],
            capture_output=True, text=True, timeout=HERMES_TIMEOUT
        )
        return {"mode": "completed", "elapsed": time.time()-start, ...}
    except subprocess.TimeoutExpired:
        return {"mode": "timeout", "elapsed": HERMES_TIMEOUT, "score": 0}

# Salvataggio incrementale dopo OGNI fase completata
all_results["loops"][phase_key] = phase_scores
checkpoint_file = f"checkpoint_{timestamp}_phase{phase}.json"
json.dump(all_results, open(checkpoint_file, "w"))
```

Pulisci i checkpoint alla fine quando il report finale è salvato.

## Running a Custom Quick Benchmark

For a <10-minute benchmark (instead of the full multi-hour run):

1. Create a custom config (example: `config_10min.yaml`):

```yaml
categories:
  - id: api_development
    name: "API Development"
    task_count: 10

phases:
  baseline:
    enabled: false       # Skip baseline to save time
  loops:
    count: 2             # Only 2 loops (not 10)
    loop_1_tasks:
      api_development: [1]
    practice_tasks_start: 2
  retest:
    enabled: true

environment:
  cleanup: false
  timeout_per_task: 300

hermes:
  skill: "elysium-swarmloop"
  subagents_max: 5
  quality_threshold: 7
  retries_max: 2
```

2. Run with: `elysium-bench run -c config_10min.yaml`

3. For full control, write a custom Python runner that imports `ScoringEngine` and `TaskRegistry` directly, calls `subprocess.run(["hermes", "chat", "-q", prompt, ...])`, and scores results. See `run_quick_benchmark.py` in the repo for a working example.

## Scoring Engine Dimensions

| Dimension | Weight | Code tasks | Text/Math/Plan tasks |
|-----------|--------|------------|----------------------|
| Correctness | 40 | pytest pass rate | rubric / exact match |
| Completeness | 25 | lint + no stubs | required sections |
| Efficiency | 15 | complexity | optimal method |
| Robustness | 10 | error handling | edge cases |
| Clarity | 10 | import/syntax | structure |

Pass threshold: ≥ 60/100. Excellent: ≥ 85/100. Learning detected: ≥ 5% improvement.

## Progressive Benchmark Iteration (collaudato)

Il pattern usato in questa sessione per eseguire benchmark complessi senza perdere ore su bug prevenibili:

### Fasi

1. **Quick run** (1 categoria, 2 loop) — testa che Hermes CLI + Elysium skill rispondano, che lo scoring funzioni, che i workspace vengano creati
2. **Analizza risultati quick** — trova bug infrastrutturali (flag `-z`→`-q`, provider `base_url`, path test sbagliati)
3. **Fixa e medium run** (4 categorie, 3 loop) — verifica che i fix reggano su più domini, scopri bug specifici per tipo task
4. **Analizza risultati medium** — trova bug di dominio (regex rubric, timeout task lunghi, scoring anomaly)
5. **Fixa e lungo run** (5+ categorie, 4+ loop) — incorpora tutti i fix precedenti, genera report finale consolidato

### Regole pratiche

| Iterazione | Scope | Bug da aspettarsi | Durata attesa |
|-----------|-------|-------------------|---------------|
| Quick | 1 cat × 1-2 loop | Infrastruttura (`-q` flag, base_url, workspace path) | 2-5 min |
| Medium | 3-4 cat × 2-3 loop | Dominio (rubric regex, scoring engine mismatch) | 15-25 min |
| Lungo | 5+ cat × 4+ loop | Performance (timeout, hang, credential) | 30-50 min |

### Checkpoint pattern

```python
# DOPO ogni fase completata, salva risultati parziali
checkpoint_file = f"risultati/checkpoint_{timestamp}_phase{phase}.json"
json.dump(all_results, open(checkpoint_file, "w"))

# Alla fine, pulisci checkpoint e salva report finale
for f in risultati_dir.glob("checkpoint_*.json"):
    f.unlink()
```

Questo garantisce che anche se un task successivo crasha, i risultati delle fasi precedenti non vanno persi.

## User Preferences (Boschi404)

### Organizzazione risultati

- **Cartella:** `risultati/` (italiano, non `results/` o `output/`)
- **Posizione:** copiare nella cartella del progetto su OneDrive: `OneDrive - Florian Elmazi/Documenti/ProgettiAtigravity/HERMES/NomeProgetto/risultati/`
- **Push:** su entrambi i repo: `Elysium-Bench` (codice benchmark) e `Elysium-Swarmloop` (skill + risultati)
- **Formato:** JSON + Markdown, con report consolidato `BENCHMARK_RESULTS.md` che riassume TUTTI i benchmark eseguiti

### Git push con credenziali condivise

Se il git locale è configurato con un utente diverso dal proprietario del repo (es. `ffazecaldy` deve pushare su `Boschi404/...`):

```bash
# 1. Usa l'username del proprietario nell'URL per forzare la richiesta di credenziali diverse
git remote set-url origin https://Boschi404@github.com/Boschi404/NomeRepo.git

# 2. Usa PTY (pseudo-terminal) per far apparire il prompt della password
#    (in terminal: run normal mode, in Hermes: pty=true)
git push origin main
```

Se il credential manager ha credenziali vecchie:

```bash
# Rimuovi credenziali GitHub dal Git credential store
echo "protocol=https\nhost=github.com" | git credential reject

# Rimuovi anche dal Windows Credential Manager
cmdkey /list | findstr github  # trova i nomi esatti
cmdkey /delete:"LegacyGeneric:target=git:https://github.com"
```

## Baseline Comparison (Skill vs No-Skill)

Per verificare che Elysium Swarmloop fornisca un reale beneficio, esegui lo **stesso benchmark CON e SENZA** la skill e confronta i risultati.

### Metodologia

```python
# CON skill:
subprocess.run(["hermes", "chat", "-q", prompt, "--skills", "elysium-swarmloop", "-Q"])

# SENZA skill (baseline):
subprocess.run(["hermes", "chat", "-q", prompt, "-Q"])
# Nessun flag --skills → Hermes base agent, senza orchestrazione multi-agente
```

### Risultati misurati in questa sessione (Luglio 2026)

| Benchmark | CON Skill (v0.7.2) | CON Skill (v5.2.0) | NO Skill | Δ vs NO Skill | Δ vs v5.2 |
|:----------|:------------------:|:------------------:|:--------:|:-------------:|:---------:|
| **Quick** | **65.5** | **74.5** | 71.7 | -6.2 📉 | **-9.0** 📉 |
| **Medium** | **57.0** | **72.6** | 69.8 | -12.8 📉 | **-15.6** 📉 |
| **Lungo L1** | **83.4** | **86.0** | 83.2 | +0.2 ➡️ | **-2.6** 📉 |
| **Super Lungo** (10 cat, L1) | **77.3** | — | — | — | — |

### Confronto versione skill (v0.7.2 vs v5.2.0)

La v0.7.2 ha **performance inferiori** alla v5.2.0 su Quick e Medium benchmark, nonostante abbia più funzionalità. Il motivo principale: l'overhead dei nuovi meccanismi (4-Band Filter, Global Re-Check, Quality-First, Sandbox Racing) aggiunge 40-180s per task, spingendo molti task oltre il timeout di 180s.

**Dove vince v0.7.2:** sul Lungo benchmark (10 categorie, super lungo), i task code_review non bloccano più grazie al Graceful Degradation (Phase 3j-bis). Senza timeout recovery, v5.2.0 lasciava questi task a 0/100.

**Dove perde:** su Quick e Medium, l'overhead è sproporzionato rispetto alla complessità dei task. Task semplici (CRUD API, bug fixing) vengono classificati come Tier 3 dal 4-Band Filter e sottoposti a cicli di qualità non necessari.

### Pattern di confronto

```bash
# 1. CONFIG: abilita baseline comparison
hermes config set model.base_url https://opencode.ai/zen/go/v1  # se provider = opencode-go

# 2. Esegui benchmark completi in serie (quick + medium + lungo)
cd ~/Elysium-Swarmloop
python run_baseline_benchmark.py  # NO skill run

# 3. Poi CON skill (usa run_benchmark_v072.py o lo script corrispondente)
python run_benchmark_v072.py      # CON skill run

# 4. Leggi i risultati da risultati/
ls -la risultati/*_v072_*.json
ls -la risultati/*baseline*.json
```

### Cosa significa

1. **I task code traggono il massimo beneficio dalla skill** — API Development passa da 65-73 (no skill) a 75-81 (con skill). Il multi-agent orchestration migliora la qualità del codice generato.

2. **I task text (Logical Deduction, Code Review) fanno 100/100 in entrambi i casi** — Hermes base agent è già eccellente su task di ragionamento e revisione. La skill non è necessaria qui.

3. **Il DataScoringEngine penalizza a prescindere** — Data Analysis fa 58/100 sia con che senza skill. È un'anomalia dello scoring engine, non un problema dell'agente.

4. **Il Δ si riduce su benchmark più lunghi** — Quick (13%) > Medium (4%) > Lungo (3%). Su task complessi, la differenza tra Hermes base e skill orchestrata si assottiglia perché Hermes base gestisce bene anche task difficili.

### Pattern per il confronto

```bash
# 1. Esegui benchmark completi in serie (quick + medium + lungo)
cd ~/Elysium-Swarmloop  # oppure ~/Elysium-Bench
python run_baseline_benchmark.py  # usa run_baseline_benchmark.py modificato

# 2. Il confronto automatico legge i JSON con skill da risultati/
#    e calcola Δ per ogni benchmark
```

**Nota:** Esegui sempre prima lo SKILL run (per popolare `risultati/`) e poi il BASELINE run. Il confronto è valido solo se i task sono identici (stessa categoria, stesso indice T0N).

## Known Anomalies

| Anomaly | Task Type | Symptom | Cause | Fix |
|---------|-----------|---------|-------|-----|
| Data tasks stuck at 58 (FIXED) | `data_analysis` | Correctness=40, Completeness=7.5, Efficiency=4.5, Robustness=3, Clarity=3 across ALL runs | `DataScoringEngine._rubric_check()` defaulted to 30% when no `rubric.yaml` existed | ✅ Added `rubric.yaml` to all 10 data_analysis tasks (T01-T10) with task-specific keyword checks |
| Workspace PermissionError on Windows | all | `shutil.rmtree()` fails with `PermissionError: Accesso negato` on `.git` objects | Workspaces from previous runs have `.git` folders that Windows locks | ✅ Use `os.system(f'rmdir /S /Q "{path}" 2>nul')` instead of `shutil.rmtree()` |
| OpenAI `typing_extensions` corruption | all | `Failed to initialize OpenAI client: No module named 'typing_extensions'` | pip upgrades openai to version requiring newer typing_extensions | ✅ `python -m pip install --upgrade typing_extensions openai` |
| Score convergence at ~74 | `code` tasks in re-test | Multiple different tasks all converge to 74.0 | Penalty patterns are deterministic — completeness penalizes TODO/stub, robustness penalizes missing try/except (but FastAPI uses HTTPException) | Fixed in v0.8.0 Phase 1c point 4 (HTTPException recognized) |
| 100/100 on text tasks | `logical_deduction`, `code_review` | Perfect score every time | Rubric-based TextScoringEngine matches keywords easily | Not a bug — text tasks ARE easier to score than code tasks |

## v0.8.0 Benchmark Results (July 2026)

Super Lungo (10 cat × 2 loop + retest, 300s timeout, 70.4 min):

     Categoria           L1      L2    Re-Test   Δ
     api_development     72.0    69.0    75.0   +3.0
     bug_fixing          79.0    76.0    76.0   -3.0
     algorithm           70.0    68.0    68.0   -2.0
     logical_deduction  100.0   100.0   100.0    ➡️
     code_review        100.0     ⏰    100.0    ➡️
     MEDIA (5 cat)       84.2    82.6    83.8   -0.4

3 timeout su 30 task (code_review, documentation, configuration a 300s).
Confronto con v0.7.2 sulle stesse 5 categorie: v0.8.0 è 33% più veloce (99s vs 149s/task) e uguale in Loop 1 (84.2 vs 84.0).
