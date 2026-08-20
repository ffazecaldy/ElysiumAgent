"""engine/security_shield.py — check regex hardcoded su codice prodotto dal modello.

Phase 3a della spec Elysium: applicato a TUTTI i task che producono codice.
Genuinamente regex-based: zero intelligenza, solo pattern deterministici.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


@dataclass
class SecurityIssue:
    id: str
    severity: str  # CRITICAL | HIGH | WARNING
    message: str
    line: int = 0

    def __iter__(self):
        # rende l'oggetto usabile come tupla dove richiesto
        yield self.id
        yield self.severity
        yield self.message

    @property
    def as_dict(self) -> dict:
        return {"id": self.id, "severity": self.severity, "message": self.message, "line": self.line}


# 1. HARDCODED SECRETS (CRITICAL — blocca)
_SECRET_ASSIGN_RE = re.compile(
    r"\b(api_?key|password|secret|token|api_?secret)\s*=\s*['\"][^'\"]{8,}['\"]",
    re.IGNORECASE,
)
_ENV_REF_RE = re.compile(r"\b(os\.getenv|environ|process\.env|get_secret|env\()\b")

# 2. SQL INJECTION (HIGH — blocca)
_SQLI_RE = re.compile(r"f['\"]SELECT|f['\"]INSERT|\.format\([^)]*SELECT|\+\s*\w*\s*SELECT|execute\([^)]*\+")

# 3. PLACEHOLDER SECRETS (WARNING — non blocca)
_PLACEHOLDER_RE = re.compile(r"\b(api_?key|token|secret)\s*=\s*(['\"]\s*['\"]|None)\s*#\s*(TODO|FIXME)", re.IGNORECASE)

# 4. DEPRECATED API PATTERNS (HIGH — blocca, escluso codice di test)
_DEPRECATED_RE = re.compile(r"\.__fields__\b|\.dict\(\)|\.json\(\)\s*$|pydantic\.v1|@app\.route\(")


def scan(code: str) -> list[SecurityIssue]:
    """Scansiona il codice prodotto e ritorna la lista di SecurityIssue."""
    issues: list[SecurityIssue] = []
    lines = code.splitlines()

    for i, line in enumerate(lines, start=1):
        # 1. hardcoded secrets: la riga imposta un segreto e le 3 successive
        #    NON lo leggono da env
        if _SECRET_ASSIGN_RE.search(line):
            nxt = lines[i : i + 3]
            if not any(_ENV_REF_RE.search(l) for l in nxt):
                issues.append(SecurityIssue(
                    id="HARDCODED_SECRET",
                    severity="CRITICAL",
                    message="Credenziale hardcoded: spostare in variabile d'ambiente",
                    line=i,
                ))

        # 2. SQL injection
        if _SQLI_RE.search(line):
            issues.append(SecurityIssue(
                id="SQL_INJECTION",
                severity="HIGH",
                message="Query SQL costruita per interpolazione: usare query parametrizzate o ORM",
                line=i,
            ))

        # 3. placeholder secrets
        if _PLACEHOLDER_RE.search(line):
            issues.append(SecurityIssue(
                id="PLACEHOLDER_SECRET",
                severity="WARNING",
                message="Segnaposto secret con TODO: verificare che sia intenzionale",
                line=i,
            ))

        # 4. deprecated API (escludi file di test: righe con hasattr o # test)
        if _DEPRECATED_RE.search(line) and not re.search(r"hasattr|\btest\b", line, re.IGNORECASE):
            issues.append(SecurityIssue(
                id="DEPRECATED_API",
                severity="HIGH",
                message="Pattern API deprecato (__fields__/.dict()/.json()/pydantic.v1)",
                line=i,
            ))

    return issues
