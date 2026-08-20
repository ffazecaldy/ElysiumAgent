"""engine/quality_gate.py — penalità deterministiche sopra il self-score del modello.

MAI calcolare la completeness esternamente: è un giudizio del modello.
Qui si applicano solo penalità deterministiche:
- security_issues  -> blocco secco a 0.0 (Phase 3a)
- has_stubs        -> cap a 3.0 (non azzeramento: il lavoro parziale vale qualcosa)
"""
from __future__ import annotations

from typing import Any, Sequence

STUB_CAP = 3.0


def apply_penalties(
    self_reported_score: float,
    has_stubs: bool,
    security_issues: Sequence[Any],
) -> float:
    """Applica le penalità deterministiche al self-score del modello."""
    if security_issues:
        return 0.0  # blocco secco (secrets, SQLi, deprecati critici)
    if has_stubs:
        return min(float(self_reported_score), STUB_CAP)  # cap, non azzeramento
    return float(self_reported_score)
