# Piano Harness — Riorientamento ElysiumAgent: da optimize-engine ad agent harness

**Data:** 2026-08-20 · **Repo:** `ElysiumAgent` · **Doc precedente:** `PLAN.md` (piano optimize-engine, chiuso ✅)

---

## 1. Riorientamento del progetto

Su richiesta dell'utente il progetto è stato **ri-orientato da «optimize-engine» ad «agent harness»**:

- **Prima (PLAN.md):** motore multi-agente LLM *standalone* per ottimizzare codice/algoritmi (gauntlet builder/critic + barra pytest/performance), destinato alla risoluzione di problemi di programmazione con benchmark esterni misurabili. Chiesa con 13 commit e 3/3 E2E WIN (token reali).
- **Ora (questo piano):** **Elysium Agent è un agent harness** — un assistente conversazionale per progetto che decide autonomamente se rispondere direttamente (tier 1) o attivare il loop multi-agente Elysium (tier 2+, decomposizione → scatter parallelo → quality gate → retry), con workspace progetti persistenti, API FastAPI e UI web di chat. Il motore Elysium resta il cuore intellettuale; l'harness lo rende utilizzabile.

**Cosa è stato MANTENUTO (il motore Elysium, `engine/`):**

| Modulo | Ruolo |
|---|---|
| `engine/state.py` | 4-Band Filter + tier detection (tier 1–4), soglie |
| `engine/decompose.py` | decomposizione goal in task (LLM propone, Python valida) |
| `engine/scatter.py` | esecuzione parallela con semaforo/retry |
| `engine/gauntlet.py` + `budget.py` | cicli builder/critic vs barra + budget token per round |
| `engine/quality_gate.py` + `result_parser.py` | score 0–10, penalità (stub, security), parsing `## RESULT` |
| `engine/security_shield.py` | scan artefatti (eval/exec/os, secret) |
| `llm/client.py` | client OpenAI-compatible: retry/backoff, quota 5h, `QuotaExhaustedError` |
| `bar/` | barra misurabile (pytest + perf, mediana, tracemalloc) |

**Cosa è NUOVO (l'harness):**

| Componente | Ruolo |
|---|---|
| `harness/chat.py` | agente chat per progetto: `wants_loop()` (tier ≥2) o risposta diretta in streaming |
| `harness/orchestrator.py` | coordinatore: `run_harness()` → decompose → scatter N agenti → quality → retry → report |
| `harness/projects.py` | workspace persistenti: `files/`, `chat.json`, `runs/`, CRUD + path-traversal bloccato |
| `api/` | FastAPI: `main.py` + `routes.py` (progetti, chat SSE streaming, files, runs), `store.py`, `factory.py`/`client_factory.py`, `fakes.py` (demo) |
| `web/` | UI chat futuristica: Alpine.js + CSS dark (Space Grotesk, SSE, report card) |
| `projects/` (`demo-*`) | workspace demo seedati |
| `scripts/` | `smoke_harness.py` (nucleo con FakeLLM), `run_server.py`, `seed_demo.py`, `e2e_real.py` |

**Stack:** FastAPI + Alpine.js SPA · server `127.0.0.1:8137` · provider `opencode-go` (`deepseek-v4-flash`) · API key via env `OPTIMIZE_ENGINE_API_KEY`.

---

## 2. Stato dei 20 subagent

Delega in **20 subagent paralleli** (sessione orchestrante avviata con pool key `opencode-go`). Stato basato su git log/repo al momento della scrittura. Legenda: **✅** committato e verificato · **🔄** in corso (file non ancora committati) · **⏳** pianificato.

| # | Subagent | Obiettivo | File ownership | Esito |
|---|---|---|---|---|
| S01 | Nucleo harness | progetti + orchestrator multi-agente + chat SSE | `harness/` (chat, orchestrator, projects) | ✅ `123f9cf` |
| S02 | API FastAPI | endpoint progetti/chat SSE/continue + factory client | `api/` (main, routes, store, factory) | ✅ `123f9cf` |
| S03 | UI chat web | SPA Alpine.js dark con streaming SSE e report card | `web/` (index.html, app.js, style.css) | ✅ `4905054` |
| S04 | Asset brand | logo/favicon futurist per la UI | `web/logo.svg`, `web/favicon.svg` | ✅ `560f4ca` |
| S05 | Test ProjectStore | CRUD, persistenza, path traversal bloccato | `tests/test_projects.py` | ✅ `2387843` |
| S06 | Test API+SSE | endpoint + streaming con TestClient | `tests/test_api.py` | ✅ `492f758` |
| S07 | Test ChatAgent | wants_loop, build_messages, streaming fake | `tests/test_chat.py` | ✅ `632578c` |
| S08 | Conftest/fixture | fixture condivise harness per i test | `tests/conftest.py` | ✅ `b7839cd` |
| S09 | Test streaming | chunk LLM + quota | `tests/test_stream.py` | ✅ `28d00cb` |
| S10 | Test orchestrator | parse_files_block, run_harness con FakeLLM | `tests/test_orchestrator.py` | 🔄 in corso (untracked) |
| S11 | Test LLM extra | retry 500, quota, last_tokens | `tests/test_llm_client_extra.py` | ✅ `a6d18be` |
| S12 | Test config/factory | config.yaml + client_factory demo | `tests/test_config.py`, `api/client_factory.py` | ✅ `aff32e5` |
| S13 | Seed demo | workspace demo di esempio (api-python, refactor auth, ottimizzazione) | `scripts/seed_demo.py`, `projects/demo-*` | ✅ `9837c50` |
| S14 | Security shield integ. | security scan nel quality gate del loop harness | `tests/test_security_harness.py`, engine/security_shield | ✅ `8e5bbe0` |
| S15 | Edge tier detection | casi limite del band filter | `tests/test_state_edges.py`, `engine/state.py` | ✅ `49167f6` |
| S16 | Docs setup | guida setup + troubleshooting | `docs/` | ✅ `0da3ecf` |
| S17 | Run server | script di avvio server (uvicorn, env, check key) | `scripts/run_server.py` | 🔄 in corso (untracked) |
| S18 | Smoke nucleo | dimostrazione loop completo senza rete | `scripts/smoke_harness.py` | ✅ `ee845fa` |
| S19 | E2E reale | end-to-end con key reale sul loop harness | `scripts/e2e_real.py`, `results/` | ⏳ pianificato (roadmap step 2) |
| S20 | Piano/stato | questo documento di riorientamento + stato delega | `.hermes/plans/optimize-engine/PIANO_HARNESS.md` | 🔄 questo commit |

**Sintesi:** ✅ 15 · 🔄 3 (S10, S17, S20) · ⏳ 1 (S19).

**Suite globale:** **76 test verdi** (`pytest -q` → `76 passed`), smoke nucleo harness riproduce decompose→scatter→gate→file con FakeLLM ✅.

---

## 3. Roadmap

1. **Test verdi** — chiudere gli ultimi file non committati (S10 `test_orchestrator.py`, S17 `run_server.py`), ri-run completa `pytest -q` a verde, commit. *(stato attuale: 76/76 ✅, manca solo l'ingresso degli ultimi 2)*
2. **E2E reale con key** — lanciare il loop harness reale (tier 2+) su un progetto demo con la key `opencode-go` dal pool, verificare report con first-pass rate/qualità/file scritti su `projects/`. Non serve più il fallback OpenRouter: la chiave è nel pool.
3. **Push** — `git push` di `main` su `github.com/ffazecaldy/ElysiumAgent` + backup `optimize-engine`, con README/CONTRACT aggiornati al riorientamento harness.

---

## 4. Note

- **Delega subagent riparata:** la delega in 20 subagent è stata sbloccata aggiungendo la key `opencode-go` al pool di credenziali di Hermes — `hermes auth add` (label `ffazecaldy-sk`, base_url `https://opencode.ai/zen/go/v1`). Prima la delega falliva per provider senza credenziali nel pool.
- **Nessuna key nel repo:** le chiavi vivono solo nel pool Hermes (`auth.json`, fuori repo) o in env var; `config.yaml` referenzia `OPTIMIZE_ENGINE_API_KEY` come nome, non come valore. `.gitignore` esclude `.env`, `auth`/pool, `logs`, `results/`, `projects/`, `.sandbox/` — nessun segreto tracciabile.
- **Nota di collaborazione:** i subagent operano in parallelo sullo stesso working tree; le rispettive aggiunte in `git status` si alternano a mano a mano che ciascuno committa — questo documento fotografa lo stato al momento della scrittura.
