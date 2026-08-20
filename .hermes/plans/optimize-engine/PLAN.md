# Optimize Engine — Piano di Implementazione

Goal: programma standalone (FastAPI + SPA Alpine.js) — loop multi-agente LLM per
programmazione pura e ottimizzazione di codice/algoritmi, con barra esterna misurabile
(test, runtime, memoria). Motore comportamentale derivato da Elysium Swarmloop v0.15.0
(SKILL.md = spec; e2e_test.py = nucleo logico portato).

## Task
| # | Task | Stato |
|---|------|-------|
| 0 | Setup repo + venv | ✅ commit e6de533 |
| 1 | engine/state.py + tier detection | ✅ commit 2e34d9f |
| 2 | result_parser + quality_gate + security_shield | ✅ commit 276c527 |
| 3 | llm/client.py (retry/backoff + quota) | ✅ commit d58ee76 |
| 4 | sandbox/runner.py | ✅ commit cd3455c |
| 5 | bar (pytest_bar + perf_bar) | ✅ commit 41b7dca |
| 6 | engine/decompose.py + scatter.py | ✅ commit ca597a2 |
| 7 | engine/gauntlet.py + budget.py | ✅ commit 267db3e |
| 8 | api/main.py + routes.py | ✅ commit 65d1f3d |
| 9 | web/ SPA Alpine.js dark | ✅ commit 6f078e8 + e063f5e |
| 10 | E2E su 3 problemi reali | ✅ commit a5fed36 (3/3 WIN, token reali) |
| 11 | Config finale + README | ✅ commit e05d336 |

**Totale: 13 commit, 41 test, pushato su github.com/ffazecaldy/ElysiumAgent (main) + backup optimize-engine.**

> 📦 Il progetto vive in `C:\Users\Admin\OneDrive - Florian Elmazi\Documenti\ProgettiAtigravity\HERMES\ElysiumAgent`
> (spostato da ~/optimize-engine per allineare sessione/codice/repo). Remote: origin=ElysiumAgent, backup=optimize-engine.

## Dipendenze
0 → 1 → 2 → (3,4,5 paralleli) → 6 → 7 → 8 → 9 → 10 → 11

## Assunzioni chiave
- A1: provider opencode-go, base_url https://opencode.ai/zen/go/v1, model deepseek-v4-pro
- A7: quota rolling 5h → QuotaExhaustedError distinto, mai retry cieco
- A2: task atomici → fast-path diretto senza loop
- A3: self-learning NON in v1
- A4: sandbox subprocess + timeout (Docker opzionale v2)
- A6: UI dark, Space Grotesk, numeri smart format, localStorage, italiano
