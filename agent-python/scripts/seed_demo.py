"""scripts/seed_demo.py — genera progetti demo di esempio nell'harness.

Per ogni progetto demo:
- lo crea via harness.projects ProjectStore (cartella files/, runs/, chat.json);
- scrive nella chat il messaggio di apertura dell'assistente;
- crea il README del progetto nel workspace (files/README.md).

Idempotente: se il progetto (stesso nome) esiste già, non lo duplica:
salta la creazione, ma garantisce che README e messaggio di apertura siano
presenti (aggiunge solo ciò che manca).

Uso:
  PYTHONPATH=. .venv/Scripts/python.exe scripts/seed_demo.py
"""
from __future__ import annotations

import os
import sys

# rende importabile il package harness dalla root del repo
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from harness.projects import Project, ProjectStore  # noqa: E402

APERTURA = "Progetto pronto. Dammi un goal e attivo il loop Elysium per tier 2+."

DEMO_PROJECTS = [
    {
        "name": "demo-api-python",
        "desc": "API REST in Python: endpoint, validazione e test, da lanciare con uvicorn.",
        "readme": """# demo-api-python

API REST di esempio in Python (FastAPI).

Obiettivi tipici per il loop Elysium:
- implementare gli endpoint `GET /items` e `POST /items`;
- validazione input (Pydantic) e gestione errori;
- test con pytest e doc OpenAPI.

Struttura attesa:
- `app/main.py` — entrypoint FastAPI
- `app/schemas.py` — modelli/validazione
- `tests/test_api.py` — test degli endpoint
""",
    },
    {
        "name": "demo-refactor-auth",
        "desc": "Refactor del sistema di autenticazione: token, refresh e permessi.",
        "readme": """# demo-refactor-auth

Refactor del sistema di autenticazione esistente.

Obiettivi tipici per il loop Elysium:
- estrarre la logica JWT in un modulo dedicato `auth/`;
- aggiungere il refresh token e la rotazione;
- introdurre i permessi per ruolo (RBAC);
- mantenere la retrocompatibilità con l'interfaccia attuale.

Struttura attesa:
- `auth/tokens.py` — emissione/verifica token
- `auth/decorators.py` — protezione route e permessi
- `tests/test_auth.py` — copertura auth
""",
    },
    {
        "name": "demo-script-ottimizzazione",
        "desc": "Script di ottimizzazione: refactor di una pipeline lenta in Python puro.",
        "readme": """# demo-script-ottimizzazione

Ottimizzazione di uno script Python di elaborazione dati, lento e monolitico.

Obiettivi tipici per il loop Elysium:
- refactor in funzioni/passaggi riutilizzabili (`pipeline/`);
- sostituire i loop annidati con operazioni vectorizzate o algoritmi migliori;
- benchmark prima/dopo con `timeit` e report dei guadagni.

Struttura attesa:
- `pipeline/etl.py` — pipeline refactorata
- `benchmarks/bench.py` — confronto prestazioni prima/dopo
""",
    },
]


def _ensure_project(store: ProjectStore, spec: dict) -> Project:
    """Crea il progetto se assente; garantisce README e messaggio di apertura."""
    name = spec["name"]
    existing = next((p for p in store.list() if p.name == name), None)

    if existing is None:
        proj = store.create(name)
        print(f"[creato] {name}  ->  {proj.id}")
    else:
        proj = existing
        print(f"[esiste] {name}  (id={proj.id}, salto la creazione)")

    # messaggio di apertura dell'assistente: solo se non già presente
    chat = store.read_chat(proj)
    if not any(m.get("role") == "assistant" and m.get("content") == APERTURA
               for m in chat):
        store.append_message(proj, "assistant", APERTURA)
        print(f"  [chat] messaggio di apertura aggiunto a {name}")
    else:
        print(f"  [chat] messaggio di apertura già presente in {name}")

    # README di esempio nel workspace: solo se non esiste già
    rel = "README.md"
    if not any(f["path"] == rel for f in store.list_files(proj)):
        store.write_file(proj, rel, spec["readme"])
        print(f"  [files] scritto {rel} in {name}")
    else:
        print(f"  [files] {rel} già presente in {name}")

    return proj


def main() -> None:
    store = ProjectStore()
    print(f"ROOT progetti: {store.root}\n")

    for spec in DEMO_PROJECTS:
        _ensure_project(store, spec)

    print("\n=== LISTA PROGETTI ===")
    for p in store.list():
        files = [f["path"] for f in store.list_files(p)]
        n_msg = len(store.read_chat(p))
        print(f"- {p.name} (id={p.id}, msgs={n_msg}, files={files})")


if __name__ == "__main__":
    main()
