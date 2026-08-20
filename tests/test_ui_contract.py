# -*- coding: utf-8 -*-
"""test_ui_contract.py — test di contratto della UI (web/).

Verifica che la UI (web/index.html, web/app.js, web/style.css) mantenga gli
elementi, gli id/class e le funzionalità attese dal backend:

  * font Figtree (restyle da Space Grotesk)
  * endpoint API del backend (/api/projects, streaming via text/event-stream)
  * stati obbligatori loading / empty / error
  * accessibilità di base (aria-label)
  * accent lilla (bf8dff o simile)
  * numeri "smart" (smart + pct)

La UI è in corso di restyle da un altro agente: alcuni test possono fallire
finché il restyle non è completo. NIENTE fix su web/ da qui — questo file
documenta SOLO lo stato del contratto. Se un file web/ manca, il test fallisce
con un messaggio chiaro invece di una traceback criptica.
"""

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _leggi(nome: str) -> str:
    """Legge un file web/; fallisce con messaggio chiaro se manca.

    Robustezza a file mancanti: la UI può non essere ancora generata
    (restyle in corso); in quel caso il contratto non è verificabile e il
    test deve dirlo senza incasinare il traceback.
    """
    p = ROOT / "web" / nome
    if not p.exists():
        raise AssertionError(f"file mancante: {p} — la UI web/ non è presente (restyle in corso?)")
    return p.read_text(encoding="utf-8")


HTML = _leggi("index.html")
JS = _leggi("app.js")
CSS = _leggi("style.css")


def test_figtree_presente():
    # La fonte leggera Figtree deve essere caricata o referenziata (restyle).
    assert "figtree" in HTML or "figtree" in CSS, "font Figtree assente (restyle non completato?)"


def test_endpoint_api_usati():
    # Il contratto col backend: endpoint /api/projects (l'app usa la costante
    # `API = "/api"` + "/projects") e streaming SSE.
    assert re.search(r'/api/projects|API\s*\+\s*["\']/projects', JS), \
        "endpoint /api/projects non raggiungibile da app.js"
    assert ("text/event-stream" in JS) or ("Accept" in JS), "streaming SSE assente"


def test_stati_obbligatori_presenti():
    # Stati UI obbligatori: loading / empty / error.
    assert re.search(r'x-show="loading|loadingProjects', HTML) or "loading" in JS, "stato loading assente"
    assert "empty" in HTML, "stato empty assente"
    assert "error" in HTML or "error" in JS, "stato error assente"


def test_accessibilita_theme():
    # Accessibilità di base: aria-label sugli elementi interattivi.
    assert "aria-label" in HTML, "aria-label assenti"


def test_accent_lilla():
    # Accent del tema: lilla (bf8dff o simile).
    assert ("bf8dff" in CSS) or ("bf8dff" in HTML), "accent lilla (bf8dff) assente (restyle non completato?)"


def test_numeri_smart():
    # Numeri "smart": logica smart + pct presente in app.js.
    assert "smart" in JS, "logica smart assente in app.js"
    assert "pct" in JS, "percentuale/pct assente in app.js"


def test_nessun_space_grotesk():
    # Restyle: la vecchia font Space Grotesk non deve sopravvivere.
    assert "Space Grotesk" not in HTML, "Space Grotesk ancora in index.html (restyle non completato?)"
    assert "Space Grotesk" not in CSS, "Space Grotesk ancora in style.css (restyle non completato?)"
