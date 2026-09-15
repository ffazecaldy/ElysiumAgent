# Elysium Agent (Optimize Engine) — Tier detection & verified goal catalog

Repo: `C:\Users\Admin\OneDrive - Florian Elmazi\Documenti\ProgettiAtigravity\HERMES\ElysiumAgent`
(a.k.a. "Optimize Engine", FastAPI + SPA Alpine.js, loop multi-agente vs barra misurabile).
`engine/state.py` → `detect_tier(goal)` è un port del 4-Band Filter di `elysium-swarmloop/scripts/e2e_test.py`.

## Come classifica `detect_tier` (verificato empiricamente sul codice)

Regex per band, **vale il MASSIMO tra le keyword trovate** (controllo da banda alta a bassa):

| Tier | Regex keyword | Sotto-livelli |
|------|---------------|----------------|
| 1 | `quick|tiny|minor|typo|config\s*change|edit|single\s*command|bump\s*version|rename` | fast-path, niente loop |
| 2 | `bugfix|bug\s*fix|feature|refactor|modular|test\s*add|small|update|patch|add\s*endpoint` | loop Elysium |
| 3 | `api|research|migration|multi.?file|dashboard|integration|pipeline|service|module|component|auth` | |
| 4 | `greenfield|from\s*scratch|full.?stack|system|platform|redesign|rewrite|architecture|mvp|production` | |

Subagent per tier 1→3, 2→10, 3→35, 4→80. Soglia qualità 6/7/7/8. Backend: `band_filter()` usa lo stesso concetto ma con matching a sottostringa (niente `\b`), quindi può divergere da `detect_tier()`.

## ⚠️ Collisioni keyword — non leggere le regex a occhio, ESEGUI la funzione

Le keyword dei tier superiori **hanno precedenza e tirano su il tier** (max-band-wins). Casi reali misurati:

| Goal "innocente" | Tier reale | Causa |
|---|---|---|
| `Quick edit to update the API base URL in config.yaml` | **3** | `api` (era pensato Tier 1) |
| `Add endpoint POST /api/items to the FastAPI app` | **3** | `api` dentro `/api/` |
| `Minor edit to the comment header of the module` | **3** | `module` |
| `Refactor the parser module and add tests` | **3** | `module` (solo `refactor` avrebbe dato 2) |
| `Add a small pagination feature to the list view` | **2** | OK — `small`+`feature` |
| `Fix the typo in the welcome message inside app.py` | **1** | OK |

Altre insidie:
- `add\s*endpoint` richiede la stringa letterale "add endpoint": "Add a new endpoint …" **NON matcha** (l'endpoint "nudo" non è keyword in `detect_tier`, solo in `band_filter`).
- `config\s*change` NON matcha "config edit" (serve la parola "change").
- La parola `small` è Tier 2: un goal "small edit" → Tier 2, non Tier 1. Per esempi Tier 1 usa `quick edit` / `minor edit` MA senza parole tier 2/3 nel resto (ex. "api", "module", "feature").

## Ricetta di verifica (obbligatoria prima di consegnare goal/esempi classificati)

```bash
cd "…/HERMES/ElysiumAgent" && ./.venv/Scripts/python -c "
from engine.state import detect_tier
for g in ['…goal…', '…']:
    print(detect_tier(g), '--', g)"
```

Non consegnare mai una tabella "goal → tier atteso" senza averla verificata: anche un esempio apparentemente banale finisce in tier sbagliato.

## Catalog goal verificato (12 esempi, 0 misclassificati)

Committato in `examples/goals.md` (commit `docs: esempi goal per tier`):

- **Tier 1 (fast-path)**: tyop in app.py; rename funzione; quick edit indentazione; version bump in pyproject.toml.
- **Tier 2**: small feature filtro tabella; add endpoint export CSV; refactor parser + unit test; refactor sort + PerfBar (faster than baseline).
- **Tier 3**: refactor auth module → shared api service; migration auth + multi-file module + dashboard endpoint.
- **Tier 4**: full-stack from scratch (auth+dashboard); greenfield rewrite production-ready platform con payment api.

## Barre (giudice di vittoria, in `bar/`)

- **PytestBar** — win = tutti i test del workspace passano (rc 0, 0 failed, ≥1 passed). Il builder DEVE allegare i test, altrimenti round bocciato.
- **PerfBar** — win = mediana runtime candidate < mediana baseline (N=5 esecuzioni, `perf_counter` + picco `tracemalloc`).

## Note ambiente (Windows / OneDrive)

- `search_files` (rg) **fallisce** sui path OneDrive con spazi e `-` ("Impossibile trovare il file specificato", os error 2/3), mentre `terminal` (ls/grep) e `read_file` con lo stesso path funzionano. Sui repo in `OneDrive - …\ProgettiAtigravity\…` usare `grep -rn` via terminal (path tra virgolette) o `read_file` — non perdere tempo con search_files.
- Il venv del progetto è `.venv` root del repo (i moduli si importano da lì: `./.venv/Scripts/python -c "from engine.state import …"`).
