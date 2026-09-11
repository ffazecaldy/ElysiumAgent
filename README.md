# ⚡ Elysium Agent — Harness web multi-agente

Harness multi-agente: una **chat** per progetto + **loop Elysium v0.15** (decompose → scatter → quality gate → retry)
che coordina agenti LLM subalterni su goal di sviluppo software, scrivendo i file direttamente nel workspace del progetto.

È un tool locale single-user: FastAPI in back-end, **SPA Alpine.js** (stile clears.ai: light + accent lilla `#bf8dff`, font Figtree) in front-end, motore comportamentale
riusato da `engine/` (port del nucleo di **Elysium Swarmloop v0.15**, `SKILL.md` = spec, già verificato dai 251 check di `e2e_test.py`).

- Provider LLM: **opencode-go** (OpenAI-compatible) → `https://opencode.ai/zen/go/v1`
- Modello: **deepseek-v4-flash**
- API key: variabile `OPTIMIZE_ENGINE_API_KEY` (valorizzata con `OPENCODE_GO_API_KEY`)

---

## Architettura

```
┌──────────────────────────────────────────────────────────────┐
│                      SPA Alpine.js (web/)                    │
│               chat + progetti + report card + SSE            │
└──────────────────────────────┬───────────────────────────────┘
                               │ HTTP / SSE (text/event-stream)
┌──────────────────────────────▼───────────────────────────────┐
│                         FastAPI (api/)                       │
│   projects CRUD · chat SSE · file workspace · storico runs   │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                        Harness (harness/)                    │
│   ChatAgent: decide() → tier 1 = risposta diretta            │
│                 tier 2+ = attiva il loop multi-agente        │
│   Orchestrator: decompose → scatter → gate → retry → report  │
│   ProjectStore: files/ · chat.json · runs/ (su disco)        │
└──────────────────────────────┬───────────────────────────────┘
                               │ engine/ (riusato)
┌──────────────────────────────▼───────────────────────────────┐
│           engine/  ·  llm/client.py                          │
│   state (band filter+tier) · decompose · quality_gate        │
│   result_parser · security_shield · budget · scatter         │
│   LLM async (retry/backoff, quota 429 → QuotaExhaustedError) │
└──────────────────────────────────────────────────────────────┘
```

Il loop **scrive i file nel workspace del progetto** (`projects/<slug>/files/`), la chat conserva la conversazione
(`chat.json`), e ogni run produce un **report JSON** (`runs/<run_id>.json`) con metriche misurabili:
first-pass rate, qualità media, task passati/ritentati, file scritti, stima token.

---

## Quickstart

```bash
# 1. ambiente virtuale + dipendenze
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt          # Windows
# source .venv/bin/activate && pip install -r requirements.txt   # Linux/macOS

# 2. API key del provider opencode-go
export OPTIMIZE_ENGINE_API_KEY="$OPENCODE_GO_API_KEY"

# 3. avvia il server (UI + API su http://127.0.0.1:8137)
.venv/Scripts/python -m uvicorn api.main:app --port 8137
```

Poi apri **http://127.0.0.1:8137** → crea un progetto → scrivi un goal.

> Se `OPTIMIZE_ENGINE_API_KEY` non è valorizzata, le chiamate LLM reali falliscono con un errore chiaro.
> Per provare la UI senza rete (@ 0 costi) esiste la modalità demo: `OPTIMIZE_ENGINE_TEST_MODE=1`.

---

## Come funziona il loop

### 1. Tier detection + 4-Band Filter (`engine/state.py`)

Ogni messaggio del progetto passa da `decide()`:

- **4-Band Filter** (`band_filter`): classifica la complessità del goal su keyword gerarchiche
  (banda 4 vincente → banda 1; default banda 2 *"when in doubt, default to Tier 2"*).
- **`detect_tier`**: regex sulle keyword → tier 1..4 (fast link per task atomici).
- **`tier_to_threshold`**: soglia di qualità per banda — tier 1→6, tier 2→7, tier 3→7, tier 4→8.

Bande:
| Banda | Keyword tipiche | Esempio |
|-------|-----------------|---------|
| 1 | quick, tiny, typo, rename, config, edit, single, bump, atomic | "fixa il typo nel README" |
| 2 | bugfix, feature, refactor, test, small, patch, endpoint | "refactor del modulo auth con test" |
| 3 | api, migration, multi-file, dashboard, integration, pipeline, auth | "migrazione del servizio a multi-file" |
| 4 | greenfield, from scratch, full-stack, system, architecture, mvp | "rewrite dell'architettura in full-stack" |

### 2. Decide: risposta diretta vs loop

`wants_loop(goal)` (`harness/chat.py`):

- **tier ≥ 2** → attiva il **loop multi-agente**.
- **tier 1** → **risposta diretta** in streaming (`chunk` SSE), nessun loop.
- Hints espliciti forzano il loop anche su tier 1: `attiva elysium`, `elysium`, `swarmloop`,
  `fai il loop`, `usa gli agenti`, `multi-agente`, `decomp`.

### 3. Il loop Elysium v0.15 (`harness/orchestrator.py`)

```
              ┌────────────────────────────────────────────────────────────┐
              │                     GOAL (tier 2+)                        │
              └───────────────────────────┬────────────────────────────────┘
                                          ▼
                    ┌─────────────────────────────┐
               ┌───►│ 1. DECOMPOSE (LLM)          │  il MODELLO propone la scomposizione
               │    │    validazione deterministica│  (lavoro intellettuale, mai hardcoded)
               │    │    - no conflitti di file    │  Python valida: file unici, slots≤16
               │    │    - count ≤ slots dispon.   │
               │    └─────────────────────────────┘
               │              │  rifiuto? → retry (max 2) → fallback task singolo
               │              ▼
               │    ┌─────────────────────────────┐
               │    │ 2. SCATTER (parallelo)       │  N worker agenti in parallelo
               │    │    semaforo max_concurrent=8 │  ogni worker: ## RESULT + ## FILES
               │    └─────────────────────────────┘
               │              ▼
               │    ┌─────────────────────────────┐
               │    │ 3. QUALITY GATE             │  penalità deterministiche sul self-score:
               │    │    - issues di sicurezza → 0.0  (blocco secco)
               │    │    - stub/TODO           → cap 3.0
               │    └─────────────────────────────┘
               │              │  score < threshold
               │              ▼
               │    ┌─────────────────────────────┐
               └────┤ 4. RETRY (max 2)            │  ritenta il task con i GAP indicati
                    │    gap → prompt iterazione   │
                    └─────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────────────┐
                    │ 5. ASSEMBLA + REPORT        │  scrive i file nel workspace
                    │    first_pass · qualità avg │  salva runs/<run_id>.json
                    │    task passati · token est.│  → chat: report card
                    └─────────────────────────────┘
```

Dettagli del loop:

- **Decompose** — `engine/decompose.py`: il modello propone id/description/files/interface_contract in JSON;
  Python valida (nessun conflitto di file tra task, count ≤ slots). Dopo 2 rifiuti → fallback: singolo task sul goal intero.
- **Scatter** — `asyncio.gather` con semaforo `harness.max_concurrent` (default 8).
- **Quality gate** — mai calcolo esterno di completeness: è giudizio del modello (`result_parser` centralizza il
  parsing di `## RESULT`). Si applicano solo penalità deterministiche (`engine/quality_gate.py`).
- **Retry** — sotto soglia (default `7.0`) il task viene ritentato (max `2`) riproponendo i `GAP` del tentativo precedente.
- **Security shield** — `engine/security_shield.py`: check regex deterministici sul codice generato (Phase 3a).
- **Report** — first_pass_rate, avg_quality, n_tasks, n_passed, files_written, tokens_estimate,
  `final_status`: `completed` | `partial`.

Il **costruttore della risposta** è sempre l'utente che itera nella chat ("fai tu", correzioni, nuove richieste):
la cronologia (ultimi 12 messaggi) viene ricompattata, con i report dei loop precedenti compressi in una nota di contesto.

---

## API endpoints (da CONTRACT.md)

Base URL: `http://127.0.0.1:8137` — tutto sotto `/api`.

### Progetti
| Metodo | Path | Descrizione |
|--------|------|-------------|
| `GET` | `/api/projects` | elenco progetti `[{id,name,created_at,files_count}]` |
| `POST` | `/api/projects` | crea progetto (body `{"name": "..."}`) → 201 |
| `GET` | `/api/projects/{id}` | dettaglio progetto (file + runs) |
| `DELETE` | `/api/projects/{id}` | rimuove workspace → 204 |

### Chat & workspace
| Metodo | Path | Descrizione |
|--------|------|-------------|
| `GET` | `/api/projects/{id}/chat` | messaggi `[{role,content,ts,meta?}]` |
| `POST` | `/api/projects/{id}/chat` | messaggio utente → **SSE streaming** (vedi sotto) |
| `GET` | `/api/projects/{id}/files` | elenco file `[{path,bytes,modified}]` |
| `GET` | `/api/projects/{id}/files/{path}` | contenuto file `{path,content,truncated}` |
| `GET` | `/api/projects/{id}/runs` | storico run `[{id,goal,first_pass_rate,quality,n_tasks}]` |
| `GET` | `/api/projects/{id}/runs/{run_id}` | report completo di un run |
| `POST` | `/api/projects/{id}/continue` | riservato — usato dal loop quando serve input utente |

### Eventi SSE (`POST .../chat`)

Header: `Accept: text/event-stream`, `Content-Type: application/json`. Body: `{"message": "..."}`.
Ogni evento è una riga `data: <json>`:

| Evento | Campi | Significato |
|--------|-------|-------------|
| `loop` | `goal`, `tier` | loop Elysium attivato (tier ≥ 2) |
| `report` | `report` | report loop (first_pass_rate, avg_quality, n_tasks, files_written) |
| `chunk` | `text` | streaming risposta diretta (tier 1) |
| `error` | `detail` | errore (quota / LLM) |
| `done` | `final` | fine (`kind`: `chat` \| `loop` \| `error`) |

---

## Struttura del progetto

```
ElysiumAgent/
├── config.yaml        # provider/model/key-env + harness (concurrent, retry, threshold)
├── requirements.txt   # fastapi, uvicorn, httpx, pyyaml, pytest, pytest-asyncio
├── engine/            # MOTORE RIUSATO: state (band filter+tier), decompose, scatter,
│                      #   quality_gate, gauntlet, security_shield, budget, result_parser
├── llm/               # client OpenAI-compatible async (retry/backoff, quota 429)
├── harness/           # cuore dell'harness:
│   ├── chat.py        #   ChatAgent: decide tier → risposta diretta o loop
│   ├── orchestrator.py#   HarnessRun: decompose→scatter→gate→retry→report
│   └── projects.py    #   ProjectStore: workspace su disco (files/, chat.json, runs/)
├── api/               # FastAPI: main.py (app+CORS+static) · routes.py (REST+SSE)
│                      #   client_factory.py (LLM da config) · fakes.py (test)
├── web/               # SPA Alpine.js stile clears.ai (light + accent lilla #bf8dff, Figtree): index.html · style.css · app.js
├── projects/          # workspace persistenti dei progetti (gitignored)
├── tests/             # suite pytest (76 test)
├── scripts/           # smoke_harness.py (FakeLLM) · e2e_real.py (3 problemi reali)
└── CONTRACT.md        # spec condivisa API & UI
```

Ogni progetto su disco è:

```
projects/<slug>/
├── files/            # artefatti scritti dagli agenti
├── chat.json         # conversazione persistente
└── runs/<run_id>.json  # report Elysium
```

> Root override via env `ELYSIUM_AGENT_HOME`.

### Config (`config.yaml`)

| Sezione | Campo | Default | Note |
|---------|-------|---------|------|
| `llm` | `provider` | `opencode-go` | provider OpenAI-compatible |
| `llm` | `base_url` | `https://opencode.ai/zen/go/v1` | |
| `llm` | `model` | `deepseek-v4-flash` | |
| `llm` | `api_key_env` | `OPTIMIZE_ENGINE_API_KEY` | valorizzata con `OPENCODE_GO_API_KEY` |
| `llm` | `max_retries` | `3` | retry/backoff su errori transitori |
| `llm` | `timeout_s` | `300` | |
| `harness` | `max_concurrent` | `8` | agenti paralleli nel loop |
| `harness` | `max_retries` | `2` | retry per task sotto soglia |
| `harness` | `quality_threshold` | `7.0` | soglia qualità |
| `harness` | `projects_dir` | `projects` | workspace progetti |
| `server` | `host` / `port` | `127.0.0.1` / `8137` | |

---

## Test

```bash
.venv/Scripts/python -m pytest -q     # 76 test
```

Copertura: band filter / tier detection, chat (`wants_loop`, `build_messages`, streaming con FakeLLM),
orchestrator (`parse_files_block`, run con FakeLLM), API + SSE con `TestClient`, security, quality gate, config.
Niente rete né subprocess: oggetti fake deterministici mai-rete in `api/fakes.py`.

Smoke rapido del nucleo senza rete:

```bash
.venv/Scripts/python scripts/smoke_harness.py
```

---

## Limiti v1

- **Niente self-learning**: v1 = orchestrazione + verifica. Il loop non impara dalle run precedenti.
- **La qualità è il self-score del modello** + penalità deterministiche (security → 0.0, stub → cap 3.0):
  nel loop harness non c'è esecuzione in sandbox del codice generato (l'esecuzione con barra/gauntlet
  resta nel vecchio Optimize Engine; qui i file sono scritti nel workspace ma non eseguiti).
- **Contabilità token**: stima conservativa nel report (`attempts × 900`), non tracking quota reale nel loop.
- **Chat SSE monofase**: il loop parte e termina in un'unica risposta SSE (nessun checkpoint per-round
  come nel vecchio engine); l'eventuale input utente è demandato al `continue` riservato.
- **Modello singolo**: tutti gli agenti (coordinatore e worker) usano lo stesso LLM
  (opencode-go / deepseek-v4-flash); nessun routing per ruolo.
- **Single-user locale**: dati solo sul disco, CORS aperto per tool locale; nessuna autenticazione.
- **Decomposizione LLM-dipendente**: se il modello sforna decomposizioni incoerenti → fallback a task singolo.

---

## Disclaimer

Strumento locale single-user. Nessun dato inviato a servizi non configurati esplicitamente
(provider LLM `opencode-go` configurato via `config.yaml` + `OPTIMIZE_ENGINE_API_KEY`).


## v0.16 — Execution & Verification

From v0.16 the harness runs real verification commands in the project workspace (pytest / npm test / cargo test / go test, auto-detected).

**WARNING: v0.16 does NOT provide a full security sandbox.** The subprocess executes model-produced code with strict timeouts and an executable allowlist, but network access and filesystem access outside the workspace are NOT fully isolated. Run only on trusted projects and never expose the server publicly.
