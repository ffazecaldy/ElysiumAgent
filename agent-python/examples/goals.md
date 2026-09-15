# Elysium Agent — Goal d'esempio per tier

Documento di riferimento: **12 goal pronti da copia-incollare nella chat**,
organizzati per tier (1–4). Ogni esempio riporta il goal esatto, il tier
atteso (come lo classifica `detect_tier`) e la barra prevista
(`PytestBar` / `PerfBar`) dove pertinente.

## Come funziona `detect_tier`

`engine/state.py` → `detect_tier(goal)` classifica il goal in 4 tier con
match di keyword (regex). **Vale il massimo tra le keyword trovate** nel testo.

| Tier | Cosa | Keyword tipiche |
|------|------|-----------------|
| 1 | Task atomiche → **fast-path** (risposta diretta, niente loop) | `typo`, `rename`, `edit`, `quick`, `minor`, `bump version` |
| 2 | Feature piccole / fix locali → loop Elysium | `bugfix`, `feature`, `refactor`, `small`, `patch`, `add endpoint` |
| 3 | Modifiche multi-file / servizi → loop con più subagent | `api`, `auth`, `module`, `service`, `migration`, `dashboard`, `multi-file` |
| 4 | Greenfield / full-stack / piattaforme | `greenfield`, `from scratch`, `full-stack`, `rewrite`, `platform`, `production`, `mvp` |

- Subagent per tier: 1→3, 2→10, 3→35, 4→80. Soglia qualità: 6 / 7 / 7 / 8.
- ⚠️ **Le keyword dei tier superiori hanno precedenza**: basta una parola
  come `api`, `module` o `auth` nel testo per alzare il tier. Esempio: una
  "quick edit" che menziona `api` scatta a Tier 3. Scrivete i goal senza
  queste parole se volete davvero Tier 1.

## Barre

- **PytestBar** (`bar/pytest_bar.py`) — *win* = tutti i test del workspace
  passano (rc 0, 0 failed, ≥1 passed). Il builder **deve** scrivere anche i
  test, altrimenti la barra fallisce.
- **PerfBar** (`bar/perf_bar.py`) — *win* = mediana runtime del candidato
  **inferiore a** quella della baseline su N esecuzioni (misura `perf_counter`
  + picco memoria `tracemalloc`).
- **Tier 1** → fast-path diretto, di norma nessuna barra (risposta LLM).

---

## Tier 1 — Task atomiche (fast-path, risposta diretta)

### 1. Correzione typo

> **Goal da incollare:**

```
Fix the typo in the welcome message inside app.py
```

- **Tier atteso:** 1 — keyword `typo`.
- **Barra:** nessuna (fast-path, risposta diretta). `PytestBar` opzionale se
  `app.py` ha una suite che copre il messaggio.

### 2. Rename di funzione

> **Goal da incollare:**

```
Rename the function compute to calculate in solution.py
```

- **Tier atteso:** 1 — keyword `rename`.
- **Barra:** nessuna (fast-path). `PytestBar` opzionale se esistono test che
  chiamano la funzione.

### 3. Modifica veloce (small edit)

> **Goal da incollare:**

```
Quick edit to fix the indentation in main.py
```

- **Tier atteso:** 1 — keyword `edit`. *(N.B.: niente parole come `api` /
  `module` nel testo, altrimenti salirebbe a Tier 3.)*
- **Barra:** nessuna (fast-path).

### 4. Version bump

> **Goal da incollare:**

```
Bump version to 1.0.1 in pyproject.toml
```

- **Tier atteso:** 1 — keyword `bump version`.
- **Barra:** nessuna (fast-path).

---

## Tier 2 — Feature piccole / fix locali (loop Elysium)

### 5. Feature piccola

> **Goal da incollare:**

```
Add a small feature to filter the table by date range
```

- **Tier atteso:** 2 — keyword `small` + `feature`.
- **Barra:** `PytestBar` (test di correttezza sul filtro).

### 6. Nuovo endpoint

> **Goal da incollare:**

```
Add endpoint to export the report as CSV
```

- **Tier atteso:** 2 — keyword `add endpoint`.
- **Barra:** `PytestBar` (test sull'endpoint: 200, payload atteso, CSV valido).

### 7. Refactor locale + test

> **Goal da incollare:**

```
Refactor the parser function and add unit tests for it
```

- **Tier atteso:** 2 — keyword `refactor`.
- **Barra:** `PytestBar` (i test sono parte esplicita del goal).

### 8. Ottimizzazione prestazioni (vs baseline)

> **Goal da incollare:**

```
Refactor the sort function so the candidate runs faster than the baseline
```

- **Tier atteso:** 2 — keyword `refactor` (nessuna keyword Tier 3+).
- **Barra:** `PerfBar` (mediana runtime candidato < baseline su N esecuzioni).

---

## Tier 3 — Modifiche multi-file / servizi (api, auth)

### 9. Refactor auth in servizio api condiviso

> **Goal da incollare:**

```
Refactor the auth module into a shared api service
```

- **Tier atteso:** 3 — keyword `auth`, `module`, `api`, `service`.
- **Barra:** `PytestBar` (test di autenticazione su tutti i file toccati).

### 10. Migrazione auth multi-file + dashboard

> **Goal da incollare:**

```
Migrate the authentication service to a multi-file module and add a dashboard endpoint
```

- **Tier atteso:** 3 — keyword `migration`, `auth`, `multi-file`, `module`,
  `dashboard`.
- **Barra:** `PytestBar` (regressione su auth + test del nuovo endpoint
  dashboard). `PerfBar` opzionale se la migrazione tocca la hot-path.

---

## Tier 4 — Greenfield / full-stack / piattaforme

### 11. Full-stack da zero

> **Goal da incollare:**

```
Build a full-stack app from scratch with user auth and a dashboard
```

- **Tier atteso:** 4 — keyword `full-stack`, `from scratch` (+ `auth`,
  `dashboard`).
- **Barra:** `PytestBar` (test su API, auth e dashboard). Soglia qualità 8.

### 12. Rewrite greenfield production-ready

> **Goal da incollare:**

```
Greenfield rewrite: build a production-ready e-commerce platform with a payment api
```

- **Tier atteso:** 4 — keyword `greenfield`, `rewrite`, `production`,
  `platform` (+ `api`).
- **Barra:** `PytestBar` (suite completa: catalogo, carrello, pagamenti) +
  `PerfBar` opzionale sulle query più lente.
