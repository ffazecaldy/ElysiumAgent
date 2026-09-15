"""engine/state.py — stato centrale del loop + tier detection.

Port da elysium-swarmloop/scripts/e2e_test.py (nucleo già verificato da 251 check).
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Optional

# ── 4-Band Filter (port da e2e_test.py) ──────────────────────────────────────
BAND_KEYWORDS = {
    1: ['quick', 'tiny', 'minor', 'typo', 'config', 'edit', 'single', 'bump', 'rename', 'atomic'],
    2: ['bugfix', 'bug fix', 'feature', 'refactor', 'modular', 'test', 'small', 'update', 'patch', 'endpoint'],
    3: ['api', 'research', 'migration', 'multi-file', 'multi file', 'dashboard', 'integration',
        'pipeline', 'service', 'module', 'component', 'auth', 'authentication'],
    4: ['greenfield', 'from scratch', 'full-stack', 'full stack', 'system', 'platform',
        'redesign', 'rewrite', 'architecture', 'mvp', 'production'],
}


def band_filter(goal: str) -> int:
    """Classifica il goal in 4 bande di complessità (1-4)."""
    goal_lower = goal.lower()
    # parte dalla banda più alta: le keyword di priorità maggiore vincono
    for band in [4, 3, 2]:
        for kw in BAND_KEYWORDS[band]:
            if kw in goal_lower:
                return band
    word_count = len(goal_lower.split())
    has_conj = any(c in goal_lower for c in [',', ';', ' and ', ' then ', ' plus '])
    if word_count <= 5 and not has_conj and any(kw in goal_lower for kw in BAND_KEYWORDS[1]):
        return 1
    return 2  # default band 2 ("when in doubt, default to Tier 2")


def band_to_tier(band: int) -> int:
    """Mappa il risultato del 4-Band Filter al tier (1-4)."""
    return band


# ── Tier Detection ───────────────────────────────────────────────────────────
def detect_tier(goal: str) -> int:
    """Auto-detect del tier di esecuzione (1-4) dal testo del goal."""
    score = 0
    goal_lower = goal.lower()

    if re.search(r'\b(quick|tiny|minor|typo|config\s*change|edit|single\s*command|bump\s*version|rename)\b', goal_lower):
        score = 1
    if re.search(r'\b(bugfix|bug\s*fix|feature|refactor|modular|test\s*add|small|update|patch|add\s*endpoint)\b', goal_lower):
        score = max(score, 2)
    if re.search(r'\b(api|research|migration|multi.?file|dashboard|integration|pipeline|service|module|component|auth)\b', goal_lower):
        score = max(score, 3)
    if re.search(r'\b(greenfield|from\s*scratch|full.?stack|system|platform|redesign|rewrite|architecture|mvp|production)\b', goal_lower):
        score = max(score, 4)

    return max(1, min(4, score)) if score >= 1 else 1


def tier_to_subagents(tier: int) -> int:
    return {1: 3, 2: 10, 3: 35, 4: 80}.get(tier, 10)


def tier_to_threshold(tier: int) -> float:
    return {1: 6, 2: 7, 3: 7, 4: 8}.get(tier, 7)


def is_tier1_fast_path(tier: int) -> bool:
    """I goal Tier 1 saltano il loop e vanno in fast-path diretto."""
    return tier == 1


# ── State ────────────────────────────────────────────────────────────────────
@dataclass
class State:
    goal: str
    tier: int
    threshold: float
    iteration: int = 0
    tasks_done: list = field(default_factory=list)
    tasks_failed: list = field(default_factory=list)
    tasks_in_flight: list = field(default_factory=list)
    first_pass_rate: Optional[float] = None
    avg_quality: Optional[float] = None
    max_iterations: int = 10
    start_time: float = field(default_factory=time.time)
    fast_path: bool = False


def init_state(goal: str) -> State:
    """Inizializza lo State con tier auto-detect e soglia di qualità."""
    tier = detect_tier(goal)
    return State(
        goal=goal,
        tier=tier,
        threshold=tier_to_threshold(tier),
        fast_path=is_tier1_fast_path(tier),
    )
