"""engine/result_parser.py — UNICO punto di parsing del formato RESULT.

Il modello auto-riporta il risultato in formati diversi ("N/10", "score: N",
"quality_score: N", "task_id:", "id:", "status: pass|fail|partial", "gaps:").
Questo modulo centralizza il parsing (DRY): riusato da scatter e quality_gate.
"""
from __future__ import annotations

import re
from typing import Any

# campo -> lista di pattern alternativi (primo che matcha vince)
_PATTERNS: dict[str, list[re.Pattern]] = {
    "quality_score": [
        re.compile(r"quality[_\- ]?score\s*[:=]\s*(\d+(?:\.\d+)?)\s*(?:/\s*10)?"),
        re.compile(r"score\s*[:=]\s*(\d+(?:\.\d+)?)\s*(?:/\s*10)?"),
        re.compile(r"q(?:uality)?\s*[:=]\s*(\d+(?:\.\d+)?)\s*(?:/\s*10)?"),
    ],
    "task_id": [
        re.compile(r"task[_\- ]?id\s*[:=]\s*([A-Za-z0-9_.\-]+)"),
        re.compile(r"\bid\s*[:=]\s*([A-Za-z0-9_.\-]+)"),
    ],
    "status": [
        re.compile(r"status\s*[:=]\s*(pass|fail|partial|error|success)\b", re.IGNORECASE),
    ],
}


def _to_score(value: str) -> float:
    """'8', '8/10', '8.5' -> float. Se 'N/10' estende a scala 0-10."""
    raw = value.strip()
    if "/" in raw:
        num, _, den = raw.partition("/")
        try:
            return float(num)
        except ValueError:
            return 0.0
    try:
        return float(raw)
    except ValueError:
        return 0.0


def parse_result(text: str) -> dict[str, Any]:
    """Estrae i campi strutturati dal RESULT auto-riportato dal modello.

    Resistente a formati sloppy (ordine arbitrario, "score: 7/10, id=t1").
    Ritorna sempre un dict con task_id, status, quality_score, gaps, files_created.
    """
    result: dict[str, Any] = {
        "task_id": None,
        "status": None,
        "quality_score": None,
        "gaps": [],
        "files_created": [],
    }
    if not isinstance(text, str) or not text.strip():
        return result

    # quality_score: prova i pattern in ordine di priorità
    for pat in _PATTERNS["quality_score"]:
        m = pat.search(text)
        if m:
            result["quality_score"] = _to_score(m.group(1))
            break

    # task_id
    for pat in _PATTERNS["task_id"]:
        m = pat.search(text)
        if m:
            result["task_id"] = m.group(1)
            break

    # status
    m = _PATTERNS["status"][0].search(text)
    if m:
        result["status"] = m.group(1).lower()

    # gaps: lista dopo "gaps:" o "- gaps:" (fino a fine sezione / nuove righe)
    m = re.search(r"gaps?\s*[:=]\s*\[?([^\n\]]*)\]?", text, re.IGNORECASE)
    if m:
        raw = m.group(1)
        result["gaps"] = [g.strip() for g in re.split(r"[,;]", raw) if g.strip()]

    # files_created / files
    m = re.search(r"files[_\- ]?created\s*[:=]\s*\[([^\]]*)\]", text, re.IGNORECASE)
    if m:
        result["files_created"] = [f.strip().strip("'\"") for f in m.group(1).split(",") if f.strip()]

    # fallback "score:" generico senza /10 (es. "score: 7")
    if result["quality_score"] is None:
        m = re.search(r"\bscore\s*[:=]\s*(\d+(?:\.\d+)?)", text, re.IGNORECASE)
        if m:
            result["quality_score"] = _to_score(m.group(1))

    return result
