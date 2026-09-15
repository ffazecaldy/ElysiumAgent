from engine.state import detect_tier, State, band_filter, tier_to_threshold, is_tier1_fast_path


def test_tier_atomico():
    assert detect_tier("fixa un typo in utils.py") == 1


def test_tier_complesso_multifile():
    assert detect_tier("refactor sistema auth con API, CRUD e test su 8 file") == 3


def test_tier_4_greenfield():
    assert detect_tier("greenfield full-stack platform mvp da zero") == 4


def test_band_filter_default_tier2():
    assert band_filter("aggiungi un endpoint per il login") == 2


def test_band_to_tier_threshold():
    assert tier_to_threshold(3) == 7
    assert tier_to_threshold(4) == 8


def test_tier1_fast_path():
    assert is_tier1_fast_path(1) is True
    assert is_tier1_fast_path(3) is False


def test_state_defaults_ok():
    s = State(goal="ottimizza sort", tier=2, threshold=7.0)
    assert s.iteration == 0
    assert s.tasks_done == [] and s.tasks_failed == []
    assert s.first_pass_rate is None
