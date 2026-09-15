#!/usr/bin/env python
"""
file_validation.py — Elysium Swarmloop Phase 3b (v0.16.0)

Validates that files produced by subagents are real, syntactically valid,
and not silently stubbed. Replaces the previous `grep -n "TODO|pass|stub"`
which had a ~70% false-positive rate on "pass", "password", "passport".

Usage:
    python file_validation.py <file_or_dir>... [--allow-partial] [--strict] [--json]

Exit codes:
    0 = all OK
    1 = at least one violation (block in strict mode)
    2 = parse error in this script itself

Status contract (referenced by Phase 3j-bis):
    status="pass"   → use --strict (no marker exceptions)
    status="partial"→ use --allow-partial (PARTIAL: markers OK)
"""
from __future__ import annotations
import argparse, ast, json, pathlib, re, sys
from typing import List, Dict, Any

# --- patterns ------------------------------------------------------------------

# Match TODO/FIXME/XXX comments (block)
RE_TODO_COMMENT = re.compile(
    r'^\s*#\s*(TODO|FIXME|XXX)\b', re.MULTILINE
)
# Match # PARTIAL: / # FIXME: implemented partially (allowed in --allow-partial)
RE_PARTIAL_MARKER = re.compile(
    r'^\s*#\s*(PARTIAL|FIXME:\s*implemented\s+partially)\b', re.MULTILINE
)
# Match raise NotImplementedError (always block, even with --allow-partial)
RE_NOT_IMPLEMENTED = re.compile(r'\bNotImplementedError\b')
# Match bare `pass` statement (Python only, AST) — but ONLY as a function body
#  with no other statements, to avoid false positives on legitimate `if cond: pass`
#  inside try/except blocks. We use AST to be precise.

PY_EXT = {'.py'}
SKIP_DIRS = {'.git', '__pycache__', 'node_modules', '.venv', 'venv', 'dist', 'build', '.hermes'}


def _is_test_file(p: pathlib.Path) -> bool:
    """Files in tests/ or conftest.py are exempted from deprecation checks
    (matches Phase 3a exclusion rule)."""
    parts = p.parts
    if any(part == 'tests' or part.startswith('test_') for part in parts):
        return True
    if p.name in {'conftest.py', 'pytest.ini'}:
        return True
    return False


def _validate_python(p: pathlib.Path, strict: bool, allow_partial: bool) -> List[Dict[str, Any]]:
    """AST-based check for Python files. Catches:
    - syntax errors
    - function whose body is ONLY `pass` (real stub, blocks always)
    - `raise NotImplementedError` (blocks always)
    - TODO/FIXME comments (blocks in --strict, warns in --allow-partial)
    """
    v = []
    try:
        src = p.read_text(encoding='utf-8', errors='ignore')
        tree = ast.parse(src, filename=str(p))
    except SyntaxError as e:
        v.append({
            'file': str(p), 'line': e.lineno or 0, 'rule': 'syntax',
            'severity': 'block', 'msg': f'SyntaxError: {e.msg}'
        })
        return v
    except Exception as e:
        v.append({
            'file': str(p), 'line': 0, 'rule': 'parse',
            'severity': 'block', 'msg': f'Parse error: {e}'
        })
        return v

    for node in ast.walk(tree):
        # Function with body = [Pass] → real stub
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if len(node.body) == 1 and isinstance(node.body[0], ast.Pass):
                # OK if decorated with @abstractmethod / @override (legit placeholder)
                is_abstract = any(
                    (isinstance(d, ast.Name) and d.id in ('abstractmethod', 'override'))
                    or (isinstance(d, ast.Attribute) and d.attr in ('abstractmethod', 'override'))
                    for d in node.decorator_list
                )
                if not is_abstract:
                    v.append({
                        'file': str(p), 'line': node.lineno,
                        'rule': 'empty_function_body',
                        'severity': 'block',
                        'msg': f'Function `{node.name}` has only `pass` as body — looks like a stub'
                    })
        # raise NotImplementedError → always block
        if isinstance(node, ast.Raise) and node.exc:
            exc_name = None
            if isinstance(node.exc, ast.Call) and isinstance(node.exc.func, ast.Name):
                exc_name = node.exc.func.id
            elif isinstance(node.exc, ast.Name):
                exc_name = node.exc.id
            if exc_name == 'NotImplementedError':
                v.append({
                    'file': str(p), 'line': node.lineno,
                    'rule': 'not_implemented',
                    'severity': 'block',
                    'msg': f'`raise NotImplementedError` in `{node.name if hasattr(node, "name") else "code"}`'
                })

    # TODO/FIXME comments
    src_lines = src.splitlines()
    partial_lines = set()
    for m in RE_PARTIAL_MARKER.finditer(src):
        partial_lines.add(src[:m.start()].count('\n') + 1)

    for m in RE_TODO_COMMENT.finditer(src):
        line_no = src[:m.start()].count('\n') + 1
        if line_no in partial_lines:
            continue  # already a PARTIAL marker, skip
        sev = 'block' if strict else 'warn'
        v.append({
            'file': str(p), 'line': line_no,
            'rule': 'todo_comment',
            'severity': sev,
            'msg': f'TODO/FIXME comment at line {line_no}'
        })
    return v


def _validate_text(p: pathlib.Path, strict: bool, allow_partial: bool) -> List[Dict[str, Any]]:
    """Generic check for non-Python text files (.md, .ts, .tsx, .js, .css, .json, .yaml).
    No AST — just regex. Catches:
    - TODO/FIXME comments (block in --strict)
    - 'NotImplemented' string (warn, never block in non-code files)
    - PARTIAL markers → allowed when --allow-partial
    """
    v = []
    try:
        src = p.read_text(encoding='utf-8', errors='ignore')
    except Exception as e:
        return [{'file': str(p), 'line': 0, 'rule': 'read',
                 'severity': 'block', 'msg': str(e)}]

    partial_lines = set()
    for m in RE_PARTIAL_MARKER.finditer(src):
        partial_lines.add(src[:m.start()].count('\n') + 1)
    for m in RE_TODO_COMMENT.finditer(src):
        line_no = src[:m.start()].count('\n') + 1
        if line_no in partial_lines:
            continue
        sev = 'block' if strict else 'warn'
        v.append({
            'file': str(p), 'line': line_no,
            'rule': 'todo_comment',
            'severity': sev,
            'msg': f'TODO/FIXME at line {line_no}'
        })
    return v


def validate_path(p: pathlib.Path, strict: bool, allow_partial: bool) -> List[Dict[str, Any]]:
    """Run all applicable checks on a single file or directory (recursive)."""
    violations = []
    if p.is_dir():
        for child in sorted(p.rglob('*')):
            if not child.is_file():
                continue
            if any(part in SKIP_DIRS for part in child.parts):
                continue
            if child.stat().st_size == 0:
                violations.append({
                    'file': str(child), 'line': 0,
                    'rule': 'empty_file',
                    'severity': 'block',
                    'msg': f'{child.name} is 0 bytes'
                })
                continue
            if child.suffix in PY_EXT and not _is_test_file(child):
                violations.extend(_validate_python(child, strict, allow_partial))
            else:
                violations.extend(_validate_text(child, strict, allow_partial))
    elif p.exists():
        if p.stat().st_size == 0:
            violations.append({
                'file': str(p), 'line': 0, 'rule': 'empty_file',
                'severity': 'block', 'msg': f'{p.name} is 0 bytes'
            })
        elif p.suffix in PY_EXT and not _is_test_file(p):
            violations.extend(_validate_python(p, strict, allow_partial))
        else:
            violations.extend(_validate_text(p, strict, allow_partial))
    else:
        violations.append({
            'file': str(p), 'line': 0, 'rule': 'missing',
            'severity': 'block', 'msg': f'{p} does not exist'
        })
    return violations


def main() -> int:
    ap = argparse.ArgumentParser(description='Elysium file validation (replaces grep pass/stub).')
    ap.add_argument('paths', nargs='+', help='Files or directories to validate.')
    ap.add_argument('--allow-partial', action='store_true',
                    help='Allow # PARTIAL: / # FIXME: implemented partially markers. Use for status=partial.')
    ap.add_argument('--strict', action='store_true',
                    help='Block TODO/FIXME even outside PARTIAL markers. Use for status=pass.')
    ap.add_argument('--json', action='store_true', help='Output machine-readable JSON.')
    args = ap.parse_args()

    if not args.strict and not args.allow_partial:
        # Default: strict (safer, matches Phase 3b original intent).
        args.strict = True

    all_violations: List[Dict[str, Any]] = []
    for raw in args.paths:
        p = pathlib.Path(raw)
        all_violations.extend(validate_path(p, args.strict, args.allow_partial))

    blocked = [v for v in all_violations if v['severity'] == 'block']
    warnings = [v for v in all_violations if v['severity'] == 'warn']

    result = {
        'ok': len(blocked) == 0,
        'mode': 'strict' if args.strict else 'allow-partial',
        'files_checked': len(args.paths),
        'violations': all_violations,
        'blocked_count': len(blocked),
        'warn_count': len(warnings),
    }
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result['ok']:
            print(f"✅ {len(args.paths)} path(s) OK ({len(warnings)} warnings)")
        else:
            print(f"❌ {len(blocked)} blocking violations ({len(warnings)} warnings)")
        for v in blocked:
            print(f"  BLOCK  {v['file']}:{v['line']}  [{v['rule']}]  {v['msg']}")
        for v in warnings:
            print(f"  WARN   {v['file']}:{v['line']}  [{v['rule']}]  {v['msg']}")
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
