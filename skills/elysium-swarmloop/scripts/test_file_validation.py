#!/usr/bin/env python
"""
test_file_validation.py — minimal smoke test for file_validation.py

Run from the scripts/ directory:
    python test_file_validation.py
"""
import os, sys, tempfile, subprocess, pathlib

SCRIPT = pathlib.Path(__file__).parent / 'file_validation.py'


def run_validator(args, expect_ok):
    result = subprocess.run(
        [sys.executable, str(SCRIPT)] + args,
        capture_output=True, text=True
    )
    actual_ok = (result.returncode == 0)
    return actual_ok, actual_ok == expect_ok, result.stdout, result.stderr


def test_pass_falspositive():
    """The classic bug: `grep "pass"` matches `pass` in legitimate code."""
    with tempfile.TemporaryDirectory() as d:
        f = pathlib.Path(d) / "legit.py"
        f.write_text(
            "def login(password: str) -> bool:\n"
            "    passport = get_user()\n"
            "    if not password:\n"
            "        return False\n"
            "    return True\n"
        )
        ok, passed, out, err = run_validator([str(f), '--strict', '--json'], expect_ok=True)
        assert passed, f"Should NOT flag legit code with 'pass' substring. stdout={out} stderr={err}"


def test_todo_blocked():
    with tempfile.TemporaryDirectory() as d:
        f = pathlib.Path(d) / "stub.py"
        f.write_text("def fetch():\n    # TODO implement\n    pass\n")
        ok, passed, out, err = run_validator([str(f), '--strict', '--json'], expect_ok=False)
        assert passed, f"Should block silent TODO+pass stub. ok={ok} out={out}"


def test_partial_allowed_in_allow_mode():
    with tempfile.TemporaryDirectory() as d:
        f = pathlib.Path(d) / "degraded.py"
        f.write_text(
            "def fetch():\n"
            "    # PARTIAL: timeout-recovery path\n"
            "    return None\n"
        )
        # In allow-partial mode, this should pass
        ok, passed, out, err = run_validator([str(f), '--allow-partial', '--json'], expect_ok=True)
        assert passed, f"PARTIAL marker should be allowed in --allow-partial mode. out={out}"


def test_partial_blocked_in_strict():
    with tempfile.TemporaryDirectory() as d:
        f = pathlib.Path(d) / "degraded.py"
        f.write_text(
            "def fetch():\n"
            "    # PARTIAL: timeout-recovery path\n"
            "    return None\n"
        )
        # In strict mode, even PARTIAL should not save a TODO-style marker
        # (PARTIAL: alone is OK; TODO/FIXME are blocked)
        f2 = pathlib.Path(d) / "has_todo.py"
        f2.write_text("def fetch():\n    # TODO real work\n    pass\n")
        ok, passed, out, err = run_validator([str(d), '--strict', '--json'], expect_ok=False)
        assert passed, f"Strict mode should block TODO even in a dir with PARTIAL. out={out}"


def test_empty_file():
    with tempfile.TemporaryDirectory() as d:
        f = pathlib.Path(d) / "empty.py"
        f.write_text("")
        ok, passed, out, err = run_validator([str(f), '--strict', '--json'], expect_ok=False)
        assert passed, f"Empty file must be blocked. out={out}"


def test_abstract_method_passes():
    with tempfile.TemporaryDirectory() as d:
        f = pathlib.Path(d) / "abc.py"
        f.write_text(
            "from abc import abstractmethod\n"
            "class Foo:\n"
            "    @abstractmethod\n"
            "    def bar(self):\n"
            "        pass\n"
        )
        ok, passed, out, err = run_validator([str(f), '--strict', '--json'], expect_ok=True)
        assert passed, f"@abstractmethod pass body should NOT be flagged. out={out}"


def test_syntax_error():
    with tempfile.TemporaryDirectory() as d:
        f = pathlib.Path(d) / "broken.py"
        f.write_text("def foo(\n    return 1\n")  # syntax error
        ok, passed, out, err = run_validator([str(f), '--strict', '--json'], expect_ok=False)
        assert passed, f"Syntax error must be blocked. out={out}"


def test_not_implemented_always_blocks():
    with tempfile.TemporaryDirectory() as d:
        f = pathlib.Path(d) / "raiseit.py"
        f.write_text(
            "def fetch():\n"
            "    # PARTIAL: work in progress\n"
            "    raise NotImplementedError\n"
        )
        # Even with --allow-partial, NotImplementedError is a hard block
        ok, passed, out, err = run_validator([str(f), '--allow-partial', '--json'], expect_ok=False)
        assert passed, f"NotImplementedError must always block. out={out}"


if __name__ == '__main__':
    tests = [
        test_pass_falspositive,
        test_todo_blocked,
        test_partial_allowed_in_allow_mode,
        test_partial_blocked_in_strict,
        test_empty_file,
        test_abstract_method_passes,
        test_syntax_error,
        test_not_implemented_always_blocks,
    ]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  ✓ {t.__name__}")
        except AssertionError as e:
            print(f"  ✗ {t.__name__}: {e}")
            failed += 1
    if failed:
        print(f"\n{failed}/{len(tests)} FAILED")
        sys.exit(1)
    else:
        print(f"\n{len(tests)}/{len(tests)} passed")
        sys.exit(0)
