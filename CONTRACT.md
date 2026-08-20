# Elysium Agent — Contratto API & UI (spec condivisa per i subagent)

## Harness web: chat + progetti + loop multi-agente Elysium

Server: FastAPI. Base URL: `http://127.0.0.1:8137`. UI: Alpine.js + vanilla CSS dark futurist.

## Endpoint

### Progetti
- `GET  /api/projects`                    → `{"projects": [{id,name,created_at,files_count}]}`
- `POST /api/projects` `{"name": "..."}`  → 201 `{id,name,created_at}` (crea workspace)
- `GET  /api/projects/{id}`               → dettaglio progetto
- `DELETE /api/projects/{id}`             → 204 (rimuove workspace)

### Chat
- `GET  /api/projects/{id}/chat`          → `{"messages":[{"role","content","ts","meta"?}]}`
- `GET  /api/projects/{id}/files`         → `{"files":[{"path","bytes","modified"}]}`
- `GET  /api/projects/{id}/runs`          → `{"runs":[{id,goal,first_pass_rate,quality,n_tasks}]}`
- `GET  /api/projects/{id}/files/{path:path}` → `{"path","content","truncated"}`
- `POST /api/projects/{id}/chat`          → SSE streaming
  body: `{"message":"..."}`
  eventi (sse `data:` json per riga):
  - `{"type":"loop","goal","tier"}`           — loop Elysium attivato (tier>=2)
  - `{"type":"report","report":{...}}`        — report loop (first_pass_rate,avg_quality,n_tasks,files_written)
  - `{"type":"chunk","text":"..."}`           — streaming risposta diretta
  - `{"type":"error","detail":"..."}`         — errore (quota/LLM)
  - `{"type":"done","final":{...}}`           — fine (kind: chat|loop|error)
- `POST /api/projects/{id}/continue` → usato dal loop quando serve input utente (riservato)

Header: `Accept: text/event-stream`, `Content-Type: application/json`.

## UI — mockup
```
┌─────────────────────────────────────────────────────────┐
│ ⚡ ELYSIUM AGENT          [progetto ▾]   [+ nuovo]  ≡  │ header glare
├───────────────┬─────────────────────────────────────────┤
│ PROGETTI      │  (chat messages)                        │
│ • nome      ● │  user: "refactor auth su 8 file"        │
│ • altro     ○ │  sys:  loop attivato tier 3             │
│               │  sys:  [report card: first-pass 89%]    │
│ [+ nuovo]     │  assistant: "Fatto. File: ..."          │
│               │                                         │
│               │  ┌ input box ──────────────────────┐    │
│               │  │ Invia goal…            [▶ invia] │    │
│               │  └─────────────────────────────────┘    │
└───────────────┴─────────────────────────────────────────┘
```

## Design tokens (UI futuristica, armoniosa)
- bg: `#070b14`, surface: `#0d1420`, surface2: `#141e2e`, border: `rgba(255,255,255,0.08)`
- primary: `#4f8cff` (blu elysium) — gradient accent: `linear-gradient(135deg,#4f8cff,#7c5cff)`
- text: `#eef2fb`, muted: `#8b98b5`, success `#34d399`, warn `#fbbf24`, danger `#f87171`
- font: Space Grotesk (Google Fonts)
- glow: box-shadow `0 0 24px rgba(79,140,255,0.18)` su accenti
- numeri smart format: 1500→`1.5k`, 1234567→`1.2M`, 8.25→`8.25`
- stato loop: pill pulsanti colorate per fase (decompose/scatter/gate/done)
- EMPTY state (zero progetti): messaggio + CTA. LOADING spinner. ERROR banner. TUTTI presenti.

## Test
- `tests/test_projects.py` — CRUD progetti, path traversal bloccato
- `tests/test_chat.py` — wants_loop, build_messages, streaming fake
- `tests/test_orchestrator.py` — parse_files_block, run_harness con FakeLLM
- `tests/test_api.py` — endpoint + SSE con TestClient
