# Optimize Engine ⚡

Programma standalone (FastAPI + SPA Alpine.js) che esegue un **loop multi-agente LLM** focalizzato
solo su programmazione pura e ottimizzazione di codice/algoritmi, con **barra esterna misurabile**
(test, runtime, memoria).

Il motore comportamentale deriva da **Elysium Swarmloop v0.15.0** (`SKILL.md` = spec,
`scripts/e2e_test.py` = nucleo logico già in Python, da cui sono portati band filter / tier detection).

## Architettura

```
optimize-engine/
├── config.yaml            # provider, model, budget, sandbox timeout
├── engine/                # stato, decompose, scatter, gauntlet, quality gate, security, budget
├── llm/client.py          # client OpenAI-compatible async (retry/backoff + quota)
├── sandbox/runner.py      # subprocess + timeout + tmpdir isolato
├── bar/                   # barra misurabile: PytestBar (test) + PerfBar (runtime+memoria)
├── api/                   # FastAPI: pre-flight gate, check-in per-round, stop
├── web/                   # SPA Alpine.js dark (Space Grotesk, italiano)
└── tests/                 # suite pytest (41 test)
```

### Loop

```
decompose → scatter parallelo → quality gate → retry → gauntlet builder/critic vs barra
```

- **Builder** riceve goal + pezzo + barra (mai l'architettura).
- **Critic** riceve contesto fresco e ispeziona l'**artefatto reale sul disco** (mai il summary del builder).
- **Barra** = l'unico giudice: `PytestBar` (test pass) o `PerfBar` (mediana di N esecuzioni + tracemalloc).
- **Check-in per-round**: il run si ferma dopo ogni round e riparte solo via `POST /runs/{id}/continue`.

### Macchina a stati

```
pending_confirmation → running → awaiting_approval → running → completed | stopped | quota_exhausted | failed
```

- `POST /runs` → run in `pending_confirmation` + **pre-flight** con `estimate_tokens` (Phase 0.7a: mai dispatch senza conferma, mai prezzi $ inventati).
- `POST /runs/{id}/confirm` → avvia il dispatch.
- `POST /runs/{id}/continue` → sblocca il check-in per-round.
- `POST /runs/{id}/stop` → loop esce pulito a fine round.
- `GET /runs/{id}/events` → progress live per il polling UI (2s).

## Setup

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt        # Windows
# source .venv/bin/activate && pip install -r requirements.txt  # Linux/macOS
```

### API key

```bash
export OPTIMIZE_ENGINE_API_KEY="$OPENCODE_API_KEY"   # provider opencode-go (A1)
```

Se la variabile non è valorizzata, le chiamate LLM reali falliscono con un errore chiaro.
Modalità demo (nessuna rete): `OPTIMIZE_ENGINE_TEST_MODE=1`.

## Avvio

```bash
.venv/Scripts/python -m uvicorn api.main:app --port 8137
# apri http://127.0.0.1:8137
```

## API (esempi)

```bash
# 1. crea run (pre-flight, nessun dispatch)
curl -X POST http://127.0.0.1:8137/runs \
  -H "Content-Type: application/json" \
  -d '{"goal":"refactor del modulo quicksort con test","bar":"pytest","max_rounds":3}'

# 2. conferma → avvia il loop
curl -X POST http://127.0.0.1:8137/runs/{id}/confirm

# 3. check-in per-round (bloccante: senza questo il run resta in awaiting_approval)
curl -X POST http://127.0.0.1:8137/runs/{id}/continue

# 4. stato + ultimo risultato round
curl http://127.0.0.1:8137/runs/{id}

# 5. ferma il run
curl -X POST http://127.0.0.1:8137/runs/{id}/stop
```

## Test

```bash
.venv/Scripts/python -m pytest -q     # 41 test
```

## Limiti v1

- **Niente self-learning** (claim non verificato — assunzione A3): v1 = orchestrazione + verifica.
- **Sandbox = subprocess + timeout** (A4). Docker opzionale in v2.
- **Quota rolling 5h** (A7): `QuotaExhaustedError` al primo colpo, mai retry cieco; stato `quota_exhausted` via API.
- **Task atomici (tier 1)** → fast-path diretto senza loop (A2).
- Task complessi multi-file = il valore massimo (+18 su Elysium-Bench).

## Config

`config.yaml`:

| Campo | Default | Note |
|-------|---------|------|
| `llm.provider` | opencode-go | provider OpenAI-compatible |
| `llm.base_url` | https://opencode.ai/zen/go/v1 | assunzione A1 |
| `llm.model` | deepseek-v4-pro | |
| `llm.api_key_env` | OPTIMIZE_ENGINE_API_KEY | valorizzata con OPENCODE_API_KEY |
| `engine.max_rounds` | 3 | cap round gauntlet |
| `sandbox.timeout_s` | 60 | timeout subprocess |

## Disclaimer

Strumento locale single-user. Nessun dato inviato a servizi non configurati esplicitamente.
