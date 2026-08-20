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
| 2 | result_parser + quality_gate + security_shield | 🔄 in parallelo |
| 3 | llm/client.py (retry/backoff + quota) | 🔄 in parallelo |
| 4 | sandbox/runner.py | 🔄 in parallelo |
| 5 | bar (pytest_bar + perf_bar) | 🔄 in parallelo |
| 6 | engine/decompose.py + scatter.py | ⏳ dipende da 2-5 |
| 7 | engine/gauntlet.py + budget.py | ⏳ dipende da 6 |
| 8 | api/main.py + routes.py | ⏳ dipende da 7 |
| 9 | web/ SPA Alpine.js dark | ⏳ dipende da 8 |
| 10 | Integrazione E2E su 3 problemi reali | ⏳ |
| 11 | Config finale + README | ⏳ |

## Dipendenze
0 → 1 → 2 → (3,4,5 paralleli) → 6 → 7 → 8 → 9 → 10 → 11

## Assunzioni chiave
- A1: provider opencode-go, base_url https://opencode.ai/zen/go/v1, model deepseek-v4-pro
- A7: quota rolling 5h → QuotaExhaustedError distinto, mai retry cieco
- A2: task atomici → fast-path diretto senza loop
- A3: self-learning NON in v1
- A4: sandbox subprocess + timeout (Docker opzionale v2)
- A6: UI dark, Space Grotesk, numeri smart format, localStorage, italiano
