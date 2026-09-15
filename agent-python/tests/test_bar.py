from bar.pytest_bar import PytestBar
from bar.perf_bar import PerfBar


def test_barra_test_pass_vince():
    b = PytestBar(test_dir="fixtures/sol_ok")
    res = b.evaluate("fixtures/sol_ok")
    assert res["win"] is True
    assert res["passed"] >= 1


def test_barra_perf_usa_mediana():
    b = PerfBar(target_runtime_s=0.5, iterations=5)
    res = b.evaluate("fixtures/slow.py", "fixtures/fast.py")
    assert res["baseline"] > res["candidate"]
    assert res["n_runs"] == 5
