import asyncio

from sandbox.runner import run_code


def test_timeout_uccide_processo():
    r = asyncio.run(run_code("while True: pass", timeout=1))
    assert r.timed_out
    assert r.returncode != 0


def test_cattura_output():
    r = asyncio.run(run_code("print('bar')", timeout=5))
    assert "bar" in r.stdout


def test_tmpdir_isolato():
    # lo script non deve vedere file della CWD del chiamante
    r = asyncio.run(run_code("import os; print(os.listdir('.'))", timeout=5))
    assert ".sandbox" not in r.stdout  # cwd isolata


def test_stderr_catturato():
    r = asyncio.run(run_code("import sys; print('errore', file=sys.stderr)", timeout=5))
    assert "errore" in r.stderr
