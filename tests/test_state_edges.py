"""Edge case della tier detection (portata da elysium).

Copre i bordi di detect_tier / band_filter e le mappature derivate
(threshold, subagents, fast-path) — file stabile, senza fix a engine/state.py
se i test passano.
"""
from engine.state import (
    detect_tier,
    band_filter,
    tier_to_threshold,
    tier_to_subagents,
    is_tier1_fast_path,
)


def test_tier_default_1_con_parole_generiche():
    # nessuna keyword -> tier 1 (fast path)
    assert detect_tier('sistemami il file main') == 1


def test_tier_resta_fermo_con_minuscole_con_apostrofi():
    assert detect_tier("l'api va refactorizzata") >= 2


def test_threshold_mapping():
    assert tier_to_threshold(1) == 6
    assert tier_to_threshold(4) == 8


def test_subagents_mapping():
    assert tier_to_subagents(1) == 3
    assert tier_to_subagents(4) == 80


def test_fast_path():
    assert is_tier1_fast_path(1)
    assert not is_tier1_fast_path(3)


def test_band_filter_alto_priorita():
    # keyword tier4 in goal piccolo vince
    assert band_filter('greenfield full-stack platform') == 4


def test_detect_tier_non_crash_vuoto():
    assert detect_tier('') in (1, 2)
