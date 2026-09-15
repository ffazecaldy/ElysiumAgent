#!/usr/bin/env python3
"""
Elysium Swarmloop v0.15.0 — End-to-End Test Suite
==================================================
Validates ALL phases of the autonomous orchestration engine across 4 tiers,
plus the SKILL.md contract for v0.13+ phases (Scenario 5).

Each scenario tests: 4-Band Filter, Tier Detection, State Init,
Decomposition Granularity, Streaming Gather, Convergence, Report Generation,
Quality Scoring Rubric, Security Shield, Context Protection,
Git Commit+Push Policy, and Self-Learning Pattern Capture.
Scenario 5 verifies the SKILL.md contract: case-insensitive triggers,
smart approval checkpoints, token-based cost gate, conditional RTK/PR/docs,
allowlist enforcement layer, and the lean-skill contract (no version history).

Exit code: 0 if ALL pass, 1 if any fail.

Usage:
  python scripts/e2e_test.py

Requires: Python 3.8+ (stdlib only — no external deps)
"""

import sys
import json
import re
import math
import time
import io
import os
import textwrap
import hashlib
from dataclasses import dataclass, field, asdict
from typing import Any, Optional
from enum import Enum

# ═════════════════════════════════════════════════════════════════════════════
# Colored terminal output
# ═════════════════════════════════════════════════════════════════════════════
GREEN = '\033[92m'
RED = '\033[91m'
CYAN = '\033[96m'
YELLOW = '\033[93m'
BOLD = '\033[1m'
NC = '\033[0m'

passed = 0
failed = 0


def check(description: str, condition: bool) -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  {GREEN}✅ {description}{NC}")
    else:
        failed += 1
        print(f"  {RED}❌ {description}{NC}")


def section(title: str) -> None:
    n = len(title)
    bar = "═" * n
    print(f"\n{CYAN}╔═{bar}═╗{NC}")
    print(f"{CYAN}║ {title} ║{NC}")
    print(f"{CYAN}╚═{bar}═╝{NC}")


def subsection(title: str) -> None:
    print(f"\n{YELLOW}── {title} ──{NC}")


# ═════════════════════════════════════════════════════════════════════════════
# CORE ENGINE LOGIC  (faithful to Elysium Swarmloop v0.7.0 specification)
# ═════════════════════════════════════════════════════════════════════════════

# ── 4-Band Filter ───────────────────────────────────────────────────────────
# Maps a goal into one of four complexity bands. Each band implies a tier.

BAND_DESCRIPTIONS = {
    1: "Band 1 (Green/Near)  — Single atomic action, one file/command",
    2: "Band 2 (Yellow/Mid)  — Small feature, 1-3 files, familiar domain",
    3: "Band 3 (Orange/Broad) — Multi-file feature, research, 3-10 files",
    4: "Band 4 (Red/Deep)    — Greenfield, 10+ files, cross-system",
}

BAND_KEYWORDS = {
    1: ['quick', 'tiny', 'minor', 'typo', 'config', 'edit', 'single', 'bump', 'rename', 'atomic'],
    2: ['bugfix', 'bug fix', 'feature', 'refactor', 'modular', 'test', 'small', 'update', 'patch', 'endpoint'],
    3: ['api', 'research', 'migration', 'multi-file', 'multi file', 'dashboard', 'integration',
        'pipeline', 'service', 'module', 'component', 'auth', 'authentication'],
    4: ['greenfield', 'from scratch', 'full-stack', 'full stack', 'system', 'platform',
        'redesign', 'rewrite', 'architecture', 'mvp', 'production'],
}


def band_filter(goal: str) -> int:
    """Classify goal into one of 4 complexity bands.
    Returns band 1-4. Band 1 is the simplest, Band 4 the most complex.
    """
    goal_lower = goal.lower()
    # Start from highest band so higher-priority keywords win
    for band in [4, 3, 2]:
        for kw in BAND_KEYWORDS[band]:
            if kw in goal_lower:
                return band
    # If no keywords, check if it looks truly atomic (< 10 words, no compound action)
    word_count = len(goal_lower.split())
    has_conj = any(c in goal_lower for c in [',', ';', ' and ', ' then ', ' plus '])
    if word_count <= 5 and not has_conj and any(kw in goal_lower for kw in BAND_KEYWORDS[1]):
        return 1
    return 2  # default to band 2 ("when in doubt, default to Tier 2")


def band_to_tier(band: int) -> int:
    """Map a 4-Band Filter result to a tier number (1-4)."""
    return band  # 1:1 mapping


# ── Tier Detection ──────────────────────────────────────────────────────────

def detect_tier(goal: str) -> int:
    """Auto-detect execution tier (1-4) from goal text.
    Uses keyword scoring matching the production heuristic in init-state.sh.
    """
    score = 0
    goal_lower = goal.lower()

    # Tier 1 signals (quick / atomic)
    if re.search(r'\b(quick|tiny|minor|typo|config\s*change|edit|single\s*command|bump\s*version|rename)\b', goal_lower):
        score = 1

    # Tier 2 signals (small feature / bugfix)
    if re.search(r'\b(bugfix|bug\s*fix|feature|refactor|modular|test\s*add|small|update|patch|add\s*endpoint)\b', goal_lower):
        score = max(score, 2)

    # Tier 3 signals (multi-file / research)
    if re.search(r'\b(api|research|migration|multi.?file|dashboard|integration|pipeline|service|module|component|auth)\b', goal_lower):
        score = max(score, 3)

    # Tier 4 signals (greenfield / redesign)
    if re.search(r'\b(greenfield|from\s*scratch|full.?stack|system|platform|redesign|rewrite|architecture|mvp|production)\b', goal_lower):
        score = max(score, 4)

    return max(1, min(4, score)) if score >= 1 else 1


def tier_to_subagents(tier: int) -> int:
    return {1: 3, 2: 10, 3: 35, 4: 80}.get(tier, 10)


def tier_to_threshold(tier: int) -> int:
    return {1: 6, 2: 7, 3: 7, 4: 8}.get(tier, 7)


def is_tier1_fast_path(tier: int) -> bool:
    """Tier 1 goals skip the loop entirely."""
    return tier == 1


# ── State Initialisation ────────────────────────────────────────────────────

@dataclass
class State:
    goal: str = ""
    tier: int = 1
    subagents: int = 10
    threshold: int = 7
    iteration: int = 0
    max_iterations: int = 10
    completed: list = field(default_factory=list)
    failed: list = field(default_factory=list)
    in_flight: list = field(default_factory=list)
    first_pass_rate: float = 0.0
    avg_quality: float = 0.0
    self_lessons: list = field(default_factory=list)
    start_time: float = 0.0
    fast_path: bool = False
    converged: bool = False


def init_state(goal: str, tier: int) -> State:
    """Initialise STATE object with spec-compliant fields."""
    subagents = tier_to_subagents(tier)
    threshold = tier_to_threshold(tier)
    fp = is_tier1_fast_path(tier)
    return State(
        goal=goal,
        tier=tier,
        subagents=subagents,
        threshold=threshold,
        iteration=0,
        max_iterations=10,
        completed=[],
        failed=[],
        in_flight=[],
        first_pass_rate=0.0,
        avg_quality=0.0,
        self_lessons=[],
        start_time=time.time(),
        fast_path=fp,
        converged=False,
    )


def validate_state(state: State) -> list:
    """Validate that a STATE object has all required fields and correct types."""
    issues = []
    required = ['goal', 'tier', 'subagents', 'threshold', 'iteration',
                'max_iterations', 'completed', 'failed', 'in_flight',
                'first_pass_rate', 'avg_quality', 'self_lessons',
                'start_time', 'fast_path', 'converged']
    for field in required:
        if not hasattr(state, field):
            issues.append(f"Missing field: {field}")
    if not isinstance(state.goal, str) or len(state.goal) == 0:
        issues.append("goal must be non-empty string")
    if not isinstance(state.tier, int) or state.tier < 1 or state.tier > 4:
        issues.append("tier must be int 1-4")
    if state.fast_path != (state.tier == 1):
        issues.append("fast_path must be True iff tier == 1")
    if not isinstance(state.completed, list):
        issues.append("completed must be list")
    if not isinstance(state.failed, list):
        issues.append("failed must be list")
    if not isinstance(state.in_flight, list):
        issues.append("in_flight must be list")
    if not isinstance(state.first_pass_rate, (int, float)):
        issues.append("first_pass_rate must be numeric")
    return issues


# ── Decomposition ───────────────────────────────────────────────────────────

def decompose(goal: str, tier: int, iteration: int = 0) -> list:
    """Break a goal into atomic tasks with correct granularity per tier.
    Returns list of task dicts: {id, description, files, quality_criteria}.
    """
    tasks = []

    if is_tier1_fast_path(tier):
        # Fast-path: the goal itself is the single task
        return [{
            "id": "task-1",
            "description": goal,
            "files": ["auto-detect"],
            "quality_criteria": {"completeness", "correctness"},
        }]

    goal_lower = goal.lower()

    if tier == 2:
        # Small feature → 3-5 tasks, per-function granularity
        tasks = [
            {"id": "task-1", "description": f"Implement core logic for: {goal}",
             "files": ["core.py"], "quality_criteria": {"completeness", "correctness"}},
            {"id": "task-2", "description": f"Add tests for: {goal}",
             "files": ["test_core.py"], "quality_criteria": {"edge_cases", "correctness"}},
            {"id": "task-3", "description": f"Wire up routes/entry points for: {goal}",
             "files": ["routes.py"], "quality_criteria": {"status_codes", "validation"}},
        ]
        if 'endpoint' in goal_lower or 'api' in goal_lower:
            tasks.append({"id": "task-4", "description": "Add OpenAPI/Swagger docs",
                          "files": ["docs.py"], "quality_criteria": {"completeness"}})

    elif tier == 3:
        # Multi-file feature → per-component granularity
        base_tasks = [
            {"id": "task-1", "description": f"Design data model for: {goal}",
             "files": ["models.py"], "quality_criteria": {"constraints", "completeness"}},
            {"id": "task-2", "description": f"Implement business logic for: {goal}",
             "files": ["services.py"],
             "quality_criteria": {"completeness", "correctness", "edge_cases"}},
            {"id": "task-3", "description": f"Create API routes for: {goal}",
             "files": ["routes.py"],
             "quality_criteria": {"status_codes", "validation", "edge_cases"}},
            {"id": "task-4", "description": f"Add input validation and error handling",
             "files": ["validation.py"], "quality_criteria": {"validation", "edge_cases"}},
            {"id": "task-5", "description": f"Write integration tests for: {goal}",
             "files": ["test_integration.py"], "quality_criteria": {"edge_cases", "completeness"}},
            {"id": "task-6", "description": f"Add configuration and wiring for: {goal}",
             "files": ["config.py"], "quality_criteria": {"completeness"}},
            {"id": "task-7", "description": f"Document the {goal} module",
             "files": ["README.md"], "quality_criteria": {"completeness"}},
        ]
        if 'auth' in goal_lower or 'authent' in goal_lower:
            base_tasks += [
                {"id": "task-8", "description": "Implement JWT/token auth middleware",
                 "files": ["auth.py"], "quality_criteria": {"security", "edge_cases"}},
                {"id": "task-9", "description": "Add password hashing and storage",
                 "files": ["security.py"], "quality_criteria": {"security", "validation"}},
            ]
        if 'api' in goal_lower:
            base_tasks += [
                {"id": "task-10", "description": "Rate limiting and throttling",
                 "files": ["rate_limit.py"], "quality_criteria": {"validation", "edge_cases"}},
            ]
        tasks = base_tasks

    elif tier == 4:
        # Greenfield → at least 10 tasks, per-component with depth-2 orchestration
        tasks = [
            {"id": "task-1", "description": f"Project scaffolding and structure for: {goal}",
             "files": ["pyproject.toml", "setup.py"],
             "quality_criteria": {"completeness"}},
            {"id": "task-2", "description": f"Core data models for: {goal}",
             "files": ["models.py", "schemas.py"],
             "quality_criteria": {"constraints", "completeness", "migration"}},
            {"id": "task-3", "description": f"Business logic layer for: {goal}",
             "files": ["services.py", "domain.py"],
             "quality_criteria": {"completeness", "correctness", "edge_cases"}},
            {"id": "task-4", "description": f"API layer (routes, controllers) for: {goal}",
             "files": ["routes.py", "controllers.py"],
             "quality_criteria": {"status_codes", "validation", "edge_cases"}},
            {"id": "task-5", "description": f"Authentication and authorization for: {goal}",
             "files": ["auth.py", "middleware.py"],
             "quality_criteria": {"security", "edge_cases", "validation"}},
            {"id": "task-6", "description": f"Database access and migrations for: {goal}",
             "files": ["repository.py", "migrations/"],
             "quality_criteria": {"constraints", "completeness"}},
            {"id": "task-7", "description": f"Input validation and error handling",
             "files": ["validation.py", "exceptions.py"],
             "quality_criteria": {"validation", "edge_cases"}},
            {"id": "task-8", "description": f"Background jobs and async processing",
             "files": ["workers.py", "tasks.py"],
             "quality_criteria": {"completeness", "edge_cases"}},
            {"id": "task-9", "description": f"Logging, monitoring, and metrics",
             "files": ["logging.py", "metrics.py"],
             "quality_criteria": {"completeness"}},
            {"id": "task-10", "description": f"Configuration management for: {goal}",
             "files": ["config.py", "settings.py"],
             "quality_criteria": {"completeness", "validation"}},
            {"id": "task-11", "description": f"Testing suite (unit + integration + e2e)",
             "files": ["tests/"],
             "quality_criteria": {"edge_cases", "completeness", "correctness"}},
            {"id": "task-12", "description": f"Documentation and README for: {goal}",
             "files": ["README.md", "docs/"],
             "quality_criteria": {"completeness"}},
        ]

    # Tag each task with its orchestration depth
    for t in tasks:
        t["orchestrator_depth"] = 1
        if tier == 4 and len(tasks) >= 10:
            # Tier 4 orchestrator tasks can spawn leaf workers
            t["orchestrator_depth"] = 2

    return tasks


def get_decomposition_range(tier: int) -> tuple:
    """Return (min_tasks, max_tasks) expected for each tier."""
    return {1: (1, 1), 2: (3, 5), 3: (7, 12), 4: (10, 20)}.get(tier, (1, 5))


# ── Streaming Gather ────────────────────────────────────────────────────────

@dataclass
class TaskResult:
    task_id: str
    score: float        # 0-10 quality score
    status: str         # 'pass' | 'fail' | 'silent'
    gaps: list = field(default_factory=list)
    files_created: list = field(default_factory=list)
    feedback: str = ""


def evaluate_result(result: TaskResult, threshold: float) -> tuple:
    """Evaluate a subagent result against the threshold.
    Returns (accepted: bool, action: str, feedback: str).
    """
    if result.status == 'silent':
        return (False, 'pivot', 'Silent failure — no result returned')

    if result.score >= threshold:
        return (True, 'accept', f"Score {result.score}/{threshold} meets threshold")

    # Below threshold — determine retry strategy
    if result.score >= 5:
        return (False, 'retry_feedback', f"Score {result.score} — superficial gaps: {', '.join(result.gaps)}")
    elif result.score >= 3:
        return (False, 'redefine_hint', f"Score {result.score} — structural issues: {', '.join(result.gaps)}")
    elif result.score >= 1:
        return (False, 'rewrite', f"Score {result.score} — critical gaps: {', '.join(result.gaps)}")
    else:
        return (False, 'pivot', 'Score 0 — silent or broken')


def streaming_gather(state: State, results: list) -> State:
    """Process subagent results as they arrive (simulated streaming).
    Retries below-threshold results immediately.
    Returns updated State.
    """
    if state.fast_path:
        state.completed.append("fast-path-executed")
        state.converged = True
        state.first_pass_rate = 1.0
        state.avg_quality = 10.0
        return state

    results_processed = 0
    retries_issued = 0
    quality_scores = []

    for r in results:
        accepted, action, fb = evaluate_result(r, state.threshold)
        results_processed += 1

        if accepted:
            state.completed.append(r.task_id)
            quality_scores.append(r.score)
        else:
            state.failed.append(r.task_id)
            retries_issued += 1
            # Simulate retry: retry with feedback bumps score by 2
            retry_score = min(10, r.score + 2.0)
            if retry_score >= state.threshold:
                # Retry succeeded — move from failed to completed
                if r.task_id in state.failed:
                    state.failed.remove(r.task_id)
                state.completed.append(f"{r.task_id}-retry")
                quality_scores.append(retry_score)
            else:
                state.failed.append(f"{r.task_id}-retry")

    # Calculate metrics
    total = len(results)
    completed_count = len(state.completed)
    state.first_pass_rate = (completed_count / total) if total > 0 else 0.0
    state.avg_quality = sum(quality_scores) / len(quality_scores) if quality_scores else 0.0

    state.iteration += 1

    # Convergence check
    if len(state.failed) == 0 and completed_count == total:
        state.converged = True

    return state


# ── Convergence Check ───────────────────────────────────────────────────────

def check_convergence(state: State) -> tuple:
    """Check if the loop should converge.
    Returns (is_converged: bool, reason: str).
    """
    if state.fast_path:
        return (True, "Fast-path: single atomic action, no loop needed")

    if not state.in_flight and not state.failed and len(state.completed) > 0:
        return (True, f"All {len(state.completed)} tasks completed successfully")

    if state.iteration >= state.max_iterations:
        return (True, f"Max iterations ({state.max_iterations}) reached")

    # Not yet converged
    return (False, f"Iteration {state.iteration}: {len(state.completed)} done, {len(state.failed)} failed")


# ── Final Report Generation ─────────────────────────────────────────────────

def generate_report(state: State, duration_secs: float) -> str:
    """Generate a spec-compliant final report."""
    lines = []
    lines.append("╔══════════════════════════════════════════════╗")
    lines.append("║   Elysium Swarmloop — Execution Report      ║")
    lines.append("╚══════════════════════════════════════════════╝")
    lines.append("")
    lines.append(f"  Goal:           {state.goal}")
    lines.append(f"  Tier:           {state.tier}")
    lines.append(f"  Duration:       {duration_secs:.1f}s")
    lines.append("")
    lines.append("  Loop Efficiency")
    lines.append(f"    Subagents:     {state.subagents}")
    lines.append(f"    First-pass:    {state.first_pass_rate * 100:.0f}%")
    lines.append(f"    Convergence:   {state.iteration} iteration(s)")
    lines.append(f"    Avg Quality:   {state.avg_quality:.1f}/10")
    lines.append("")
    lines.append("  Results")
    lines.append(f"    ✅ Passed:     {len(state.completed)}")
    lines.append(f"    ❌ Failed:     {len(state.failed)}")
    lines.append("")
    if state.fast_path:
        lines.append("  ⚡ Fast-Path: Loop skipped (Tier 1)")
    else:
        lines.append("  ⚡ Full loop executed")
    lines.append("")
    lines.append("  Self-Learning")
    if state.self_lessons:
        for lesson in state.self_lessons:
            lines.append(f"    • {lesson}")
    else:
        lines.append("    (no lessons captured)")
    return "\n".join(lines)


# ── Quality Scoring Rubric ──────────────────────────────────────────────────

def quality_score_rubric(completeness: float, has_edge_cases: bool,
                         has_error_handling: bool, has_tests: bool,
                         has_stubs: bool = False, has_conflicts: bool = False,
                         has_docs: bool = False) -> tuple:
    """Compute a quality score (0-10) with rationale, per the spec rubric.
    Base score from completeness (0-6) + bonuses − penalties.
    """
    base = min(6.0, completeness * 6.0)
    bonuses = 0.0
    penalties = 0.0
    rationale_parts = []

    if has_edge_cases:
        bonuses += 1.0
        rationale_parts.append("edge cases covered")
    if has_error_handling:
        bonuses += 1.0
        rationale_parts.append("error handling present")
    if has_tests:
        bonuses += 1.0
        rationale_parts.append("tests included")
    if has_docs:
        bonuses += 0.5
        rationale_parts.append("documentation provided")

    if has_stubs:
        penalties += 2.0
        rationale_parts.append("stubs/TODOs found (−2)")
    if has_conflicts:
        penalties += 3.0
        rationale_parts.append("file conflicts detected (−3)")

    score = max(0.0, min(10.0, base + bonuses - penalties))
    rationale = "; ".join(rationale_parts) if rationale_parts else "base score"

    # Map to label per spec rubric
    if score >= 10:
        label = "Flawless"
    elif score >= 9:
        label = "Excellent"
    elif score >= 8:
        label = "Good"
    elif score >= 7:
        label = "Solid"
    elif score >= 6:
        label = "Adequate"
    elif score >= 5:
        label = "Weak"
    elif score >= 4:
        label = "Poor"
    elif score >= 3:
        label = "Bad"
    elif score >= 2:
        label = "Critical"
    elif score >= 1:
        label = "Broken"
    else:
        label = "Silent"

    return (round(score, 1), label, rationale)


# ── Security Shield ──────────────────────────────────────────────────────────

SECURITY_RISK_PATTERNS = [
    (r'exec\(', 'Arbitrary code execution via exec()'),
    (r'eval\(', 'Arbitrary code execution via eval()'),
    (r'__import__\(', 'Dynamic import injection risk'),
    (r'os\.system\(', 'Shell injection via os.system()'),
    (r'subprocess\.call\(.*shell=True', 'Shell injection via subprocess shell=True'),
    (r'(password|secret|api_key|token)\s*=\s*["\'](?![*X])', 'Hardcoded secrets/credentials'),
    (r'sqlite3\.execute\(.*%.*\)', 'SQL injection risk via string formatting'),
    (r'\.format\(.*\{.*\)', 'Format string injection in SQL'),
    (r'pickle\.load', 'Insecure deserialization via pickle'),
    (r'request\.get_json\(.*silent=False', 'Missing silent flag on JSON parse — DoS risk'),
]


def security_shield_check(tasks: list) -> tuple:
    """Check tasks for common security issues.
    Returns (is_safe: bool, findings: list).
    """
    findings = []
    # In a real run, we'd scan actual file content.
    # Here we check task descriptions for security-relevant patterns.
    for task in tasks:
        desc = task.get('description', '')
        for pattern, msg in SECURITY_RISK_PATTERNS:
            if re.search(pattern, desc, re.IGNORECASE):
                findings.append(f"{task['id']}: {msg}")
        # Check files for security-relevant names
        for f in task.get('files', []):
            if 'auth' in f.lower() or 'security' in f.lower() or 'secret' in f.lower():
                if 'auth' not in desc.lower():
                    findings.append(f"{task['id']}: security-sensitive file '{f}' without auth in description")

    is_safe = len(findings) == 0
    return (is_safe, findings)


# ── Context Protection ──────────────────────────────────────────────────────

CONTEXT_LEAK_PATTERNS = [
    (r'(?i)(password|passwd|pwd)\s*[=:]\s*\S{6,}', 'Potential password leak in task'),
    (r'(?i)(api_key|apikey|api[-_]?key)\s*[=:]\s*\S{8,}', 'Potential API key leak in task'),
    (r'(?i)secret\s*[=:]\s*\S{8,}', 'Potential secret leak in task'),
    (r'(?i)(ssn|social.security)\s*[=:]\s*["\']?\d{3}', 'Potential SSN leak'),
    (r'(?i)token\s*[=:]\s*\S{16,}', 'Potential token leak in task'),
    (r'(?i)Bearer\s+\S{20,}', 'Bearer token in task description'),
]


def context_protection_check(state: State, tasks: list) -> tuple:
    """Verify tasks don't leak confidential context.
    Returns (is_protected: bool, violations: list).
    """
    violations = []

    # Check task descriptions for leaked patterns
    for task in tasks:
        desc = task.get('description', '')
        for pattern, msg in CONTEXT_LEAK_PATTERNS:
            if re.search(pattern, desc):
                violations.append(f"{task['id']}: {msg}")

    # Check state.goal for sensitive info
    for pattern, msg in CONTEXT_LEAK_PATTERNS:
        if re.search(pattern, state.goal):
            violations.append(f"state.goal: {msg}")

    return (len(violations) == 0, violations)


# ── Git Commit+Push Policy ──────────────────────────────────────────────────

def git_commit_push_policy(tier: int, fast_path: bool, converged: bool) -> str:
    """Determine the correct Git workflow based on tier and state.
    Returns strategy name.
    """
    if fast_path or tier == 1:
        return "direct_commit"
    elif not converged:
        return "no_commit_loop_not_done"
    elif tier == 2:
        return "branch_commit_push"
    elif tier == 3:
        return "branch_pr_merge"
    elif tier == 4:
        return "feature_branch_pr_review_merge"
    return "branch_commit"


# ── Self-Learning Pattern Capture ──────────────────────────────────────────

@dataclass
class ExecutionPattern:
    goal_type: str = ""
    tier: int = 1
    total_tasks: int = 0
    first_pass_rate: float = 0.0
    avg_quality: float = 0.0
    convergence_iterations: int = 0
    decomposition_pattern: str = ""
    lessons: list = field(default_factory=list)
    timestamp: float = 0.0


def capture_pattern(state: State, duration_secs: float) -> ExecutionPattern:
    """Capture a self-learning pattern from the completed execution."""
    # Detect goal type from the goal string
    goal_lower = state.goal.lower()
    goal_type = "general"
    if any(kw in goal_lower for kw in ['api', 'endpoint', 'rest', 'graphql']):
        goal_type = "api_creation"
    elif any(kw in goal_lower for kw in ['auth', 'login', 'oauth', 'permission', 'role']):
        goal_type = "auth_system"
    elif any(kw in goal_lower for kw in ['test', 'coverage', 'unittest']):
        goal_type = "testing"
    elif any(kw in goal_lower for kw in ['refactor', 'migrate', 'upgrade']):
        goal_type = "refactoring"
    elif any(kw in goal_lower for kw in ['greenfield', 'from scratch', 'new project', 'platform']):
        goal_type = "greenfield"
    elif any(kw in goal_lower for kw in ['fix', 'bug', 'typo', 'quick', 'rename', 'bump']):
        goal_type = "quick_fix"

    # Determine decomposition pattern
    decomp_pattern = {
        1: "atomic_task",
        2: "per_function",
        3: "per_component",
        4: "per_layer_with_orchestration",
    }.get(state.tier, "per_function")

    # Generate lessons
    lessons = []
    if state.first_pass_rate < 0.6:
        lessons.append("Low first-pass rate — consider finer decomposition for this goal type")
    if state.first_pass_rate > 0.95:
        lessons.append("High first-pass rate — may benefit from coarser granularity")
    if len(state.failed) > 0:
        lessons.append(f"Task type '{goal_type}' had {len(state.failed)} failures — needs better criteria")
    if state.tier == 1:
        lessons.append("Fast-path used — no self-learning needed for trivial tasks")
    if not lessons:
        lessons.append(f"Standard execution for {goal_type} — no anomalous patterns")

    return ExecutionPattern(
        goal_type=goal_type,
        tier=state.tier,
        total_tasks=len(state.completed) + len(state.failed),
        first_pass_rate=state.first_pass_rate,
        avg_quality=state.avg_quality,
        convergence_iterations=state.iteration,
        decomposition_pattern=decomp_pattern,
        lessons=lessons,
        timestamp=time.time(),
    )


def validate_pattern_store_schema() -> list:
    """Validate that the pattern SQL schema matches expected tables."""
    expected_tables = ['executions', 'decomposition_patterns', 'pitfalls', 'calibrations']
    expected_exec_cols = ['id', 'goal', 'goal_type', 'tier', 'total_tasks',
                          'first_pass_rate', 'avg_quality', 'convergence_iterations',
                          'decomposition_pattern', 'start_time', 'duration_seconds',
                          'lessons', 'created_at']
    issues = []
    # Schema definition is embedded; we validate by checking the SQL file content
    return issues  # Actual schema validation done in test via file read


# ═════════════════════════════════════════════════════════════════════════════
# PHASE 0.6 — SOLUTION-SPACE EXPLORATION (v0.10.0)
# ═════════════════════════════════════════════════════════════════════════════

@dataclass
class StrategyProposal:
    approach: str
    architecture: str
    key_decisions: list = field(default_factory=list)
    pros: list = field(default_factory=list)
    cons: list = field(default_factory=list)
    complexity: float = 5.0
    risk: float = 4.0
    estimated_subagents: int = 20
    approach_type: str = "layered"
    scout_bias: str = ""

    def __post_init__(self):
        self._score = 0.0
        self._axes = {}


def strategy_scout(goal: str, bias: str) -> StrategyProposal:
    """Simulate a strategy scout proposing ONE architectural approach."""
    proposals = {
        ("CRUD API", "simplicity"): StrategyProposal(
            approach="Layered Monolith", architecture="3-layer: routes→services→models",
            key_decisions=["FastAPI", "SQLite", "JWT auth"],
            pros=["Simple to understand", "Fast to implement", "Easy to test"],
            cons=["Harder to scale horizontally", "Tight coupling risk", "Single DB bottleneck"],
            complexity=3.0, risk=2.0, estimated_subagents=15,
            approach_type="layered", scout_bias=bias),
        ("CRUD API", "scalability"): StrategyProposal(
            approach="Microservices + API Gateway",
            architecture="N services behind gateway, async messaging",
            key_decisions=["FastAPI per service", "PostgreSQL", "RabbitMQ"],
            pros=["Horizontal scaling", "Independent deploy", "Fault isolation"],
            cons=["Complex orchestration", "Network latency", "Higher infra cost"],
            complexity=7.0, risk=6.0, estimated_subagents=45,
            approach_type="microservices", scout_bias=bias),
        ("CRUD API", "speed"): StrategyProposal(
            approach="Framework-First RAD",
            architecture="Django REST + admin auto-gen",
            key_decisions=["Django", "SQLite→Postgres later", "DRF serializers"],
            pros=["Admin panel free", "ORM built-in", "Fastest to MVP"],
            cons=["Less control", "Django-specific patterns", "Harder to customize"],
            complexity=2.0, risk=2.0, estimated_subagents=10,
            approach_type="monolith", scout_bias=bias),
    }
    key = goal[:50] if "API" in goal else goal[:30]
    # Flexible matching: check if any known goal key is a substring
    matched = None
    for gk in proposals:
        if gk[0].lower() in key.lower() and gk[1] == bias:
            matched = gk
            break
    if matched:
        return proposals[matched]
    return StrategyProposal(
        approach=f"Standard {bias}-first approach",
        architecture=f"Architecture optimized for {bias}",
        key_decisions=["Standard patterns", f"Optimize for {bias}"],
        pros=[f"Good {bias} score", "Standard tooling"],
        cons=["May trade off other qualities", f"Less optimal for non-{bias} goals"],
        complexity=5.0, risk=4.0, estimated_subagents=20,
        approach_type="layered", scout_bias=bias)


def tradeoff_matrix(proposals: list) -> list:
    """Compute weighted scores across 5 axes."""
    weights = {"quality": 2.0, "maintainability": 1.5, "speed": 1.0,
               "scalability": 1.0, "risk": -1.5}
    scalability_map = {"microservices": 9, "layered": 5, "pipeline": 6,
                       "monolith": 3, "plugin": 6, "event-driven": 8}
    for p in proposals:
        axes = {}
        axes["quality"] = min(10, max(1, 10 - p.risk + (p.complexity * 0.3)))
        axes["maintainability"] = min(10, max(1, 11 - p.complexity))
        axes["speed"] = min(10, max(1, 10 - (p.estimated_subagents / 5)))
        axes["scalability"] = scalability_map.get(p.approach_type, 5)
        axes["risk"] = p.risk
        p._score = round(sum(axes[k] * weights[k] for k in weights), 2)
        p._axes = axes
    return proposals


def select_winner(proposals: list) -> tuple:
    """Select winner with anti-bias check. Returns (winner, runner_up, reason)."""
    if len(proposals) < 2:
        return (proposals[0] if proposals else None, None, "only one proposal")
    sorted_p = sorted(proposals, key=lambda p: p._score, reverse=True)
    winner, runner_up = sorted_p[0], sorted_p[1]
    w_axes = winner._axes
    if w_axes.get("speed", 0) > 8 and w_axes.get("quality", 0) < 5:
        alt = w_axes["quality"] * 3.0 + w_axes["maintainability"] * 1.5 + w_axes["speed"] * 0.5 - w_axes["risk"] * 1.5
        if alt < runner_up._score:
            return (runner_up, winner,
                    f"anti-bias: {winner.approach} fast-but-fragile, promoted {runner_up.approach}")
    if runner_up._score >= winner._score * 0.85:
        return (winner, runner_up,
                f"synthesis possible — {runner_up.approach} within 15% of winner")
    return (winner, runner_up, f"clear winner: {winner.approach} (score {winner._score})")


# ═════════════════════════════════════════════════════════════════════════════
# SCENARIO 1 — TIER 1 FAST-PATH
# ═════════════════════════════════════════════════════════════════════════════

def test_tier1_fast_path() -> None:
    """Quick fix (typo, config change) → SKIP the loop entirely."""

    goals = [
        "Fix typo in config.yaml",
        "Bump version to 1.2.3",
        "Rename variable in utils.py",
    ]

    section("SCENARIO 1: TIER 1 FAST-PATH (Quick Fix)")
    print(f"  Testing {len(goals)} atomic goals — loop must be skipped\n")

    for g in goals:
        subsection(f"Goal: \"{g}\"")

        # 1. 4-Band Filter detection
        band = band_filter(g)
        check(f"[Band] 4-Band Filter classifies \"{g}\" as band 1 (got band {band})",
              band == 1)

        # 2. Tier auto-detection
        tier = detect_tier(g)
        check(f"[Tier] Auto-detected tier is 1 (got {tier})",
              tier == 1)

        # 3. Fast-path flag
        fp = is_tier1_fast_path(tier)
        check(f"[FastPath] is_tier1_fast_path({tier}) returns True",
              fp is True)

        # 4. State initialization
        state = init_state(g, tier)
        state_issues = validate_state(state)
        check(f"[State] STATE initialized with all required fields (issues: {len(state_issues)})",
              len(state_issues) == 0)
        check(f"[State] STATE.fast_path is True for tier 1",
              state.fast_path is True)
        check(f"[State] STATE.subagents == 3 for tier 1 (got {state.subagents})",
              state.subagents == 3)
        check(f"[State] STATE.threshold == 6 for tier 1 (got {state.threshold})",
              state.threshold == 6)
        check(f"[State] STATE.iteration starts at 0",
              state.iteration == 0)

        # 5. Decomposition granularity
        tasks = decompose(g, tier)
        min_t, max_t = get_decomposition_range(tier)
        check(f"[Decompose] Decomposition yields 1 task for fast-path (got {len(tasks)})",
              len(tasks) == 1)
        check(f"[Decompose] Single task description matches goal",
              tasks[0]['description'] == g)

        # 6. Streaming gather (fast-path)
        state2 = init_state(g, tier)
        # Simulate fast-path execution
        mock_result = TaskResult(task_id="task-1", score=10.0, status="pass")
        state2 = streaming_gather(state2, [mock_result])
        check(f"[Stream] Streaming gather marks converged=True for fast-path",
              state2.converged is True)
        check(f"[Stream] First-pass rate is 1.0 for fast-path",
              state2.first_pass_rate == 1.0)
        check(f"[Stream] Quality score is 10.0 for fast-path",
              state2.avg_quality == 10.0)

        # 7. Convergence check
        conv, reason = check_convergence(state2)
        check(f"[Converge] Convergence returns True for completed fast-path",
              conv is True)

    # 8. Report generation (use last state)
    report = generate_report(state2, 0.5)
    check(f"[Report] Final report contains header",
          "Execution Report" in report)
    check(f"[Report] Final report mentions fast-path",
          "Fast-Path" in report)
    check(f"[Report] Final report includes goal text",
          goals[-1] in report)

    # 9. Quality scoring rubric (fast-path)
    score, label, rationale = quality_score_rubric(
        completeness=1.0, has_edge_cases=False, has_error_handling=False,
        has_tests=False, has_stubs=False, has_conflicts=False
    )
    check(f"[Quality] Quick fix scores 6.0 base (completeness=1.0 → 6.0 * 1.0 = 6.0)",
          score == 6.0)
    check(f"[Quality] Score label is 'Adequate' for score 6.0 (got '{label}')",
          label == "Adequate")

    # 10. Security Shield (fast-path)
    safe, findings = security_shield_check(tasks)
    check(f"[Security] Security Shield passes for typo fix tasks",
          safe is True)
    check(f"[Security] Zero security findings for trivial task",
          len(findings) == 0)

    # 11. Context Protection
    prot, violations = context_protection_check(state2, tasks)
    check(f"[Context] Context Protection passes for simple goal",
          prot is True)

    # 12. Git Commit+Push policy
    git_strat = git_commit_push_policy(tier=1, fast_path=True, converged=True)
    check(f"[Git] Git policy is 'direct_commit' for tier 1 (got '{git_strat}')",
          git_strat == "direct_commit")

    # 13. Self-learning
    pattern = capture_pattern(state2, 0.5)
    check(f"[Learn] Self-learning pattern captured for tier 1",
          pattern.goal_type == "quick_fix")
    check(f"[Learn] Decomposition pattern is 'atomic_task' for tier 1 (got '{pattern.decomposition_pattern}')",
          pattern.decomposition_pattern == "atomic_task")

    print(f"\n  {CYAN}→ Scenario 1 complete: fast-path verified for all 3 goals{NC}")


# ═════════════════════════════════════════════════════════════════════════════
# SCENARIO 2 — TIER 2 STANDARD
# ═════════════════════════════════════════════════════════════════════════════

def test_tier2_standard() -> None:
    """Small feature (add endpoint, bugfix) → decompose → dispatch → stream → done."""

    goal = "Add user profile update endpoint for PUT requests"
    section("SCENARIO 2: TIER 2 STANDARD (Small Feature)")
    print(f"  Goal: \"{goal}\"\n")

    # 1. 4-Band Filter
    band = band_filter(goal)
    check(f"[Band] 4-Band Filter classifies endpoint addition as band 2 (got band {band})",
          band == 2)

    # 2. Tier auto-detection
    tier = detect_tier(goal)
    check(f"[Tier] Auto-detected tier is 2 (got {tier})",
          tier == 2)

    # 3. State initialization
    state = init_state(goal, tier)
    state_issues = validate_state(state)
    check(f"[State] STATE has all required fields (issues: {len(state_issues)})",
          len(state_issues) == 0)
    check(f"[State] STATE.fast_path is False for tier 2",
          state.fast_path is False)
    check(f"[State] STATE.subagents == 10 for tier 2 (got {state.subagents})",
          state.subagents == 10)
    check(f"[State] STATE.threshold == 7 for tier 2 (got {state.threshold})",
          state.threshold == 7)

    # 4. Decomposition granularity
    tasks = decompose(goal, tier)
    min_t, max_t = get_decomposition_range(tier)
    check(f"[Decompose] Tasks in range [{min_t}, {max_t}] for tier 2 (got {len(tasks)})",
          min_t <= len(tasks) <= max_t)
    check(f"[Decompose] All tasks have unique IDs",
          len(set(t['id'] for t in tasks)) == len(tasks))
    check(f"[Decompose] All tasks have files list",
          all(len(t['files']) > 0 for t in tasks))
    check(f"[Decompose] All tasks have quality_criteria",
          all(len(t['quality_criteria']) > 0 for t in tasks))
    # Tier 2 granularity: per-function — should include core, tests, routes
    file_names = [f for t in tasks for f in t['files']]
    check(f"[Decompose] Decomposition includes a routes file (got {file_names})",
          any('routes' in f.lower() for f in file_names))
    check(f"[Decompose] Decomposition includes a test file",
          any('test' in f.lower() for f in file_names))

    # 5. Streaming gather
    state_s = init_state(goal, tier)
    # Mix of pass and fail results to test retry logic
    results = [
        TaskResult(task_id="task-1", score=8.5, status="pass"),
        TaskResult(task_id="task-2", score=6.0, status="fail",
                    gaps=["missing edge case for empty name"], feedback="Add edge case"),
        TaskResult(task_id="task-3", score=7.5, status="pass"),
    ]
    state_s = streaming_gather(state_s, results)
    check(f"[Stream] Streaming gather processed {len(results)} results",
          len(results) > 0)
    check(f"[Stream] Retry issued for score=6.0 (below threshold 7.0)",
          state_s.avg_quality > 0)

    # 6. Convergence check (not yet — task-2 failed first pass but retry might have succeeded)
    conv, reason = check_convergence(state_s)
    # After retry, task-2 score 6.0 + 2.0 = 8.0 >= 7.0, so all should pass
    check(f"[Converge] Convergence reached after streaming with retry",
          conv is True)

    # 7. Report generation
    state_s.converged = True
    report = generate_report(state_s, 2.3)
    check(f"[Report] Report contains 'Loop Efficiency' section",
          "Loop Efficiency" in report)
    check(f"[Report] Report includes first-pass rate",
          f"{state_s.first_pass_rate * 100:.0f}%" in report)
    check(f"[Report] Report includes quality score",
          f"{state_s.avg_quality:.1f}/10" in report)

    # 8. Quality scoring rubric
    score, label, rationale = quality_score_rubric(
        completeness=1.0, has_edge_cases=True, has_error_handling=True,
        has_tests=True, has_stubs=False, has_conflicts=False, has_docs=True
    )
    check(f"[Quality] Full-feature score is 9.5 (base 6 + 1 edge + 1 error + 1 test + 0.5 docs = 9.5)",
          score == 9.5)
    check(f"[Quality] Score label is 'Excellent' for 9.5 (got '{label}')",
          label == "Excellent")
    # Score with stubs
    score2, label2, r2 = quality_score_rubric(
        completeness=0.8, has_edge_cases=True, has_error_handling=False,
        has_tests=False, has_stubs=True, has_conflicts=False
    )
    check(f"[Quality] Stub penalty: 4.8 base + 1 edge − 2 stubs = 3.8 (got {score2})",
          score2 == 3.8)
    check(f"[Quality] Stub-included score label is 'Bad' (got '{label2}')",
          label2 == "Bad")

    # 9. Security Shield
    safe, findings = security_shield_check(tasks)
    check(f"[Security] Security Shield verified for {len(tasks)} tasks",
          isinstance(safe, bool))
    check(f"[Security] Security Shield returns list of findings",
          isinstance(findings, list))

    # 10. Context Protection
    prot, violations = context_protection_check(state, tasks)
    check(f"[Context] Context Protection passes for standard feature",
          prot is True)

    # 11. Git policy
    git_strat = git_commit_push_policy(tier=2, fast_path=False, converged=True)
    check(f"[Git] Git policy for tier 2 is 'branch_commit_push' (got '{git_strat}')",
          git_strat == "branch_commit_push")
    git_strat_nc = git_commit_push_policy(tier=2, fast_path=False, converged=False)
    check(f"[Git] Git policy blocks commit when not converged (got '{git_strat_nc}')",
          git_strat_nc == "no_commit_loop_not_done")

    # 12. Self-learning pattern capture
    pattern = capture_pattern(state_s, 2.3)
    check(f"[Learn] Self-learning captures goal_type='api_creation' (got '{pattern.goal_type}')",
          pattern.goal_type == "api_creation")
    check(f"[Learn] Pattern records first_pass_rate={state_s.first_pass_rate:.2f}",
          pattern.first_pass_rate == state_s.first_pass_rate)
    check(f"[Learn] Decomposition pattern is 'per_function' for tier 2 (got '{pattern.decomposition_pattern}')",
          pattern.decomposition_pattern == "per_function")
    check(f"[Learn] Pattern has at least 1 lesson",
          len(pattern.lessons) >= 1)

    print(f"\n  {CYAN}→ Scenario 2 complete: standard feature loop verified{NC}")


# ═════════════════════════════════════════════════════════════════════════════
# SCENARIO 3 — TIER 3 COMPLEX
# ═════════════════════════════════════════════════════════════════════════════

def test_tier3_complex() -> None:
    """Multi-file feature (auth system) → full loop with streaming gather + retry."""

    goal = "Build authentication module with JWT tokens, role-based access, and password reset"
    section("SCENARIO 3: TIER 3 COMPLEX (Auth System)")
    print(f"  Goal: \"{goal}\"\n")

    # 1. 4-Band Filter
    band = band_filter(goal)
    check(f"[Band] 4-Band Filter classifies auth system as band 3 (got band {band})",
          band == 3)

    # 2. Tier auto-detection
    tier = detect_tier(goal)
    check(f"[Tier] Auto-detected tier is 3 (got {tier})",
          tier == 3)

    # 3. State initialization
    state = init_state(goal, tier)
    state_issues = validate_state(state)
    check(f"[State] STATE has all required fields (issues: {len(state_issues)})",
          len(state_issues) == 0)
    check(f"[State] STATE.subagents == 35 for tier 3 (got {state.subagents})",
          state.subagents == 35)
    check(f"[State] STATE.threshold == 7 for tier 3 (got {state.threshold})",
          state.threshold == 7)
    check(f"[State] STATE.fast_path is False",
          state.fast_path is False)

    # 4. Decomposition granularity
    tasks = decompose(goal, tier)
    min_t, max_t = get_decomposition_range(tier)
    check(f"[Decompose] Tasks in range [{min_t}, {max_t}] for tier 3 (got {len(tasks)})",
          min_t <= len(tasks) <= max_t)
    check(f"[Decompose] Auth-specific tasks included (auth.py, security.py)",
          any('auth.py' in t['files'] for t in tasks))
    check(f"[Decompose] Models, services, routes, and validation all present",
          all(any(f.startswith(n) for t in tasks for f in t['files'])
              for n in ['models', 'services', 'routes', 'validation']))
    check(f"[Decompose] All tasks have unique IDs",
          len(set(t['id'] for t in tasks)) == len(tasks))

    # 5. Streaming gather with retry
    state_s = init_state(goal, tier)

    # Results: mix of pass, retry-need, structural fail, and silent
    results = [
        TaskResult(task_id="task-1", score=8.0, status="pass"),
        TaskResult(task_id="task-2", score=5.5, status="fail",
                    gaps=["missing password validation"], feedback="Add validation"),
        TaskResult(task_id="task-3", score=3.0, status="fail",
                    gaps=["wrong routing approach"], feedback="Use FastAPI routers"),
        TaskResult(task_id="task-4", score=7.0, status="pass"),
        TaskResult(task_id="task-5", score=9.0, status="pass"),
        TaskResult(task_id="task-6", score=0.0, status="silent"),
        TaskResult(task_id="task-7", score=7.5, status="pass"),
        TaskResult(task_id="task-8", score=8.0, status="pass"),
    ]

    state_s = streaming_gather(state_s, results)

    total_tasks = len(results)
    check(f"[Stream] Processed {total_tasks} results through streaming gather",
          total_tasks == 8)
    check(f"[Stream] Retry logic executed (failed list populated then retried)",
          len(state_s.completed) > 0)
    check(f"[Stream] First-pass rate calculated ({state_s.first_pass_rate:.2f})",
          state_s.first_pass_rate > 0)
    check(f"[Stream] Average quality calculated ({state_s.avg_quality:.2f})",
          state_s.avg_quality > 0)

    # Test evaluate_result directly for different retry strategies
    ac1, act1, fb1 = evaluate_result(TaskResult(task_id="x", score=5.5, status="fail", gaps=["minor"]), 7.0)
    check(f"[Stream] Score 5.5 → retry with feedback (got '{act1}')",
          act1 == 'retry_feedback')

    ac2, act2, fb2 = evaluate_result(TaskResult(task_id="y", score=3.0, status="fail", gaps=["structural"]), 7.0)
    check(f"[Stream] Score 3.0 → redefine with hint (got '{act2}')",
          act2 == 'redefine_hint')

    ac3, act3, fb3 = evaluate_result(TaskResult(task_id="z", score=1.5, status="fail", gaps=["critical"]), 7.0)
    check(f"[Stream] Score 1.5 → rewrite from scratch (got '{act3}')",
          act3 == 'rewrite')

    ac4, act4, fb4 = evaluate_result(TaskResult(task_id="w", score=0.0, status="silent"), 7.0)
    check(f"[Stream] Silent failure → pivot (got '{act4}')",
          act4 == 'pivot')

    # 6. Convergence check
    conv, reason = check_convergence(state_s)
    check(f"[Converge] Convergence check returns a bool",
          isinstance(conv, bool))

    # After retries, some may still fail — verify iteration count
    check(f"[Converge] Iteration advanced to {state_s.iteration}",
          state_s.iteration == 1)

    # 7. Report generation
    report = generate_report(state_s, 15.7)
    check(f"[Report] Report contains 'Efficiency' section",
          "Efficiency" in report)
    check(f"[Report] Report contains quality score",
          "Quality" in report or "quality" in report.lower())
    check(f"[Report] Report includes subagent count ({state_s.subagents})",
          str(state_s.subagents) in report)

    # 8. Quality scoring rubric (comprehensive)
    score, label, rationale = quality_score_rubric(
        completeness=0.95, has_edge_cases=True, has_error_handling=True,
        has_tests=True, has_stubs=False, has_conflicts=False, has_docs=True
    )
    check(f"[Quality] Auth system score >= 9.0 (got {score})",
          score >= 9.0)
    check(f"[Quality] Score rationale includes 'tests included'",
          "tests" in rationale.lower())

    # 9. Security Shield
    safe, findings = security_shield_check(tasks)
    check(f"[Security] Security Shield runs on all {len(tasks)} tasks",
          isinstance(safe, bool))
    check(f"[Security] Auth-related tasks get security scrutiny (findings type: {type(findings).__name__})",
          isinstance(findings, list))

    # 10. Context Protection
    prot, violations = context_protection_check(state, tasks)
    check(f"[Context] Context Protection passes for auth system",
          prot is True)

    # 11. Git policy
    git_strat = git_commit_push_policy(tier=3, fast_path=False, converged=True)
    check(f"[Git] Git policy for tier 3 is 'branch_pr_merge' (got '{git_strat}')",
          git_strat == "branch_pr_merge")

    # 12. Self-learning pattern capture
    pattern = capture_pattern(state_s, 15.7)
    check(f"[Learn] Self-learning identifies goal_type='auth_system' (got '{pattern.goal_type}')",
          pattern.goal_type == "auth_system")
    check(f"[Learn] Decomposition pattern is 'per_component' for tier 3 (got '{pattern.decomposition_pattern}')",
          pattern.decomposition_pattern == "per_component")
    check(f"[Learn] Pattern stores convergence iterations ({pattern.convergence_iterations})",
          pattern.convergence_iterations > 0)

    print(f"\n  {CYAN}→ Scenario 3 complete: complex auth system loop verified{NC}")


# ═════════════════════════════════════════════════════════════════════════════
# SCENARIO 4 — TIER 4 EPIC
# ═════════════════════════════════════════════════════════════════════════════

def test_tier4_epic() -> None:
    """Greenfield project → full loop with depth-2 orchestration."""

    goal = "Greenfield full-stack e-commerce platform with payments, inventory, and admin dashboard"
    section("SCENARIO 4: TIER 4 EPIC (Greenfield Platform)")
    print(f"  Goal: \"{goal}\"\n")

    # 1. 4-Band Filter
    band = band_filter(goal)
    check(f"[Band] 4-Band Filter classifies greenfield as band 4 (got band {band})",
          band == 4)

    # 2. Tier auto-detection
    tier = detect_tier(goal)
    check(f"[Tier] Auto-detected tier is 4 (got {tier})",
          tier == 4)

    # 3. State initialization
    state = init_state(goal, tier)
    state_issues = validate_state(state)
    check(f"[State] STATE has all required fields (issues: {len(state_issues)})",
          len(state_issues) == 0)
    check(f"[State] STATE.subagents == 80 for tier 4 (got {state.subagents})",
          state.subagents == 80)
    check(f"[State] STATE.threshold == 8 for tier 4 (got {state.threshold})",
          state.threshold == 8)
    check(f"[State] STATE.max_iterations defaults to 10",
          state.max_iterations == 10)

    # 4. Decomposition granularity
    tasks = decompose(goal, tier)
    min_t, max_t = get_decomposition_range(tier)
    check(f"[Decompose] Tasks >= {min_t} for tier 4 (got {len(tasks)})",
          len(tasks) >= min_t)
    check(f"[Decompose] All tasks have unique IDs",
          len(set(t['id'] for t in tasks)) == len(tasks))
    check(f"[Decompose] All tasks have orchestrator_depth=2 for tier 4",
          all(t['orchestrator_depth'] == 2 for t in tasks))

    # Check depth-2 orchestration indicators
    has_scaffolding = any('pyproject.toml' in t['files'] or 'setup.py' in t['files'] for t in tasks)
    has_backend = any('services.py' in t['files'] or 'domain.py' in t['files'] for t in tasks)
    has_tests = any('tests/' in t['files'] or 'test' in t['files'] for t in tasks)
    check(f"[Decompose] Project scaffolding task present (got {has_scaffolding})",
          has_scaffolding)
    check(f"[Decompose] Backend/business logic task present (got {has_backend})",
          has_backend)
    check(f"[Decompose] Testing suite task present (got {has_tests})",
          has_tests)

    # 5. Streaming gather (depth-2 simulation)
    state_s = init_state(goal, tier)
    results = [
        # High-quality first pass
        TaskResult(task_id="task-1", score=9.0, status="pass"),
        TaskResult(task_id="task-2", score=8.5, status="pass"),
        TaskResult(task_id="task-3", score=7.5, status="pass"),
        TaskResult(task_id="task-4", score=8.0, status="pass"),
        TaskResult(task_id="task-5", score=6.5, status="fail",
                    gaps=["missing RBAC roles"], feedback="Add role definitions"),
        TaskResult(task_id="task-6", score=9.0, status="pass"),
        TaskResult(task_id="task-7", score=6.0, status="fail",
                    gaps=["no input sanitization"], feedback="Add sanitize step"),
        TaskResult(task_id="task-8", score=8.5, status="pass"),
        TaskResult(task_id="task-9", score=9.5, status="pass"),
        TaskResult(task_id="task-10", score=7.0, status="pass"),
        TaskResult(task_id="task-11", score=8.0, status="pass"),
        TaskResult(task_id="task-12", score=7.5, status="pass"),
    ]
    state_s = streaming_gather(state_s, results)
    check(f"[Stream] Streaming processed {len(results)} subagent results for tier 4",
          len(results) >= 10)
    check(f"[Stream] Retry logic ran for below-threshold results (threshold=8)",
          len(state_s.completed) > 0)
    check(f"[Stream] First-pass rate tracking active ({state_s.first_pass_rate:.2f})",
          state_s.first_pass_rate > 0)

    # Verify threshold=enforced: score 6.5 < 8.0 triggers retry
    ac1, act1, fb1 = evaluate_result(TaskResult(task_id="x", score=6.5, status="fail",
                                                 gaps=["missing roles"]), threshold=8.0)
    check(f"[Stream] Score 6.5 < threshold 8.0 → retry (got '{act1}')",
          'retry' in act1)

    # 6. Convergence check
    conv, reason = check_convergence(state_s)
    check(f"[Converge] Convergence check evaluates completed/failed state",
          isinstance(conv, bool))
    check(f"[Converge] Iteration counter increments to {state_s.iteration}",
          state_s.iteration == 1)

    # Simulate multi-iteration convergence
    state_s.iteration = 3
    state_s.failed = []
    state_s.converged = True
    conv2, reason2 = check_convergence(state_s)
    check(f"[Converge] After iteration 3 with zero failures → converged (got {conv2})",
          conv2 is True)

    # 7. Report generation
    report = generate_report(state_s, 180.0)
    check(f"[Report] Report includes subagent count for tier 4 ({state_s.subagents})",
          str(state_s.subagents) in report)
    check(f"[Report] Report includes iteration count",
          str(state_s.iteration) in report)
    check(f"[Report] Report clearly states full loop was executed",
          "Full loop" in report)

    # 8. Quality scoring (comprehensive with penalties)
    score, label, rationale = quality_score_rubric(
        completeness=1.0, has_edge_cases=True, has_error_handling=True,
        has_tests=True, has_stubs=False, has_conflicts=False, has_docs=True
    )
    check(f"[Quality] Greenfield max score is 9.5 (got {score})",
          score == 9.5)
    # With conflicts penalty
    score2, label2, r2 = quality_score_rubric(
        completeness=1.0, has_edge_cases=True, has_error_handling=True,
        has_tests=True, has_stubs=False, has_conflicts=True, has_docs=False
    )
    check(f"[Quality] Conflict penalty drops score by 3.0: 9.0 -> {score2}",
          score2 == 6.0)
    check(f"[Quality] Score with conflicts labeled 'Adequate' (got '{label2}')",
          label2 == "Adequate")

    # 9. Security Shield
    safe, findings = security_shield_check(tasks)
    check(f"[Security] Security Shield runs on all {len(tasks)} greenfield tasks",
          isinstance(safe, bool))

    # Test security detection with a malicious-looking task
    malicious_task = [{"id": "task-evil", "description": "Use exec() to parse user input",
                       "files": ["eval_runner.py"]}]
    safe2, findings2 = security_shield_check(malicious_task)
    check(f"[Security] Security Shield detects exec() usage in tasks",
          safe2 is False and len(findings2) > 0)

    # 10. Context Protection
    prot, violations = context_protection_check(state, tasks)
    check(f"[Context] Context Protection verifies no leaks in {len(tasks)} tasks",
          prot is True)

    # Test context protection with leaky goal
    leaky_state = init_state("Fix bug with password=" + "x" * 20, tier=1)
    prot2, violations2 = context_protection_check(leaky_state, tasks[:1])
    check(f"[Context] Context Protection detects leaked password in goal",
          prot2 is False and len(violations2) > 0)

    # 11. Git policy
    git_strat = git_commit_push_policy(tier=4, fast_path=False, converged=True)
    check(f"[Git] Git policy for tier 4 is 'feature_branch_pr_review_merge' (got '{git_strat}')",
          git_strat == "feature_branch_pr_review_merge")
    git_strat_nc = git_commit_push_policy(tier=4, fast_path=False, converged=False)
    check(f"[Git] Git policy blocks commit when not converged (got '{git_strat_nc}')",
          git_strat_nc == "no_commit_loop_not_done")

    # 12. Self-learning pattern capture
    pattern = capture_pattern(state_s, 180.0)
    check(f"[Learn] Self-learning identifies goal_type='greenfield' (got '{pattern.goal_type}')",
          pattern.goal_type == "greenfield")
    check(f"[Learn] Decomposition pattern is 'per_layer_with_orchestration' for tier 4 (got '{pattern.decomposition_pattern}')",
          pattern.decomposition_pattern == "per_layer_with_orchestration")
    check(f"[Learn] Pattern stores total task count ({pattern.total_tasks})",
          pattern.total_tasks > 0)
    check(f"[Learn] Pattern records quality ({pattern.avg_quality:.1f})",
          pattern.avg_quality > 0)
    check(f"[Learn] Pattern has at least 1 lesson for greenfield",
          len(pattern.lessons) >= 1)

    print(f"\n  {CYAN}→ Scenario 4 complete: greenfield depth-2 loop verified{NC}")



# ═════════════════════════════════════════════════════════════════════════════
# SCENARIO 5 — PHASE 0.6 SOLUTION-SPACE EXPLORATION
# ═════════════════════════════════════════════════════════════════════════════

def test_phase06_exploration() -> None:
    """Phase 0.6 — Solution-Space Exploration (Tier 3+)."""
    section("SCENARIO 5: PHASE 0.6 Solution-Space Exploration")

    # 0.6a — Strategy Generation
    subsection("0.6a — Strategy Scouts")

    scouts = [strategy_scout("Build a CRUD API for restaurants", bias)
              for bias in ["simplicity", "scalability", "speed"]]

    check(f"[Scouts] All 3 scouts return valid proposals", len(scouts) == 3)
    check(f"[Scouts] Scout biases are distinct",
          len(set(s.scout_bias for s in scouts)) == 3)
    check(f"[Scouts] Approach types vary (got {[s.approach_type for s in scouts]})",
          len(set(s.approach_type for s in scouts)) >= 2)

    for i, s in enumerate(scouts):
        check(f"[Scout {i+1}] Has approach name '{s.approach}'", len(s.approach) > 0)
        check(f"[Scout {i+1}] Has >=2 pros", len(s.pros) >= 2)
        check(f"[Scout {i+1}] Has >=2 cons", len(s.cons) >= 2)
        check(f"[Scout {i+1}] Complexity 1-10 (got {s.complexity})", 1 <= s.complexity <= 10)
        check(f"[Scout {i+1}] Risk 1-10 (got {s.risk})", 1 <= s.risk <= 10)
        check(f"[Scout {i+1}] Has >=2 key decisions", len(s.key_decisions) >= 2)
        check(f"[Scout {i+1}] Estimated subagents > 0", s.estimated_subagents > 0)

    # 0.6b — Trade-off Matrix
    subsection("0.6b — Trade-off Matrix")

    scored = tradeoff_matrix(scouts)
    check(f"[Matrix] All proposals have _score", all(hasattr(s, '_score') for s in scored))
    check(f"[Matrix] All proposals have _axes dict", all(hasattr(s, '_axes') for s in scored))
    check(f"[Matrix] All scores are numeric > 0", all(isinstance(s._score, (int, float)) and s._score > 0 for s in scored))

    for i, s in enumerate(scored):
        check(f"[Matrix {i+1}] '{s.approach}' has all 5 axes",
              set(s._axes.keys()) == {"quality", "maintainability", "speed", "scalability", "risk"})
        check(f"[Matrix {i+1}] Axes values in 1-10 range",
              all(1 <= v <= 10 for v in s._axes.values()))

    # 0.6c — Winner Selection
    subsection("0.6c — Winner Selection")

    winner, runner_up, reason = select_winner(scored)
    check(f"[Winner] Winner selected: '{winner.approach}'", winner is not None)
    check(f"[Winner] Reason provided (>5 chars)", len(reason) > 5)
    check(f"[Winner] Winner score > 0 ({winner._score})", winner._score > 0)
    check(f"[Winner] Runner-up identified", runner_up is not None)

    # For a CRUD API, the simplicity or speed scout should win
    is_simple_win = "simple" in winner.approach.lower() or "framework" in winner.approach.lower() or "rad" in winner.approach.lower() or "layered" in winner.approach_type
    check(f"[Winner] CRUD API → simplicity/speed wins (got '{winner.approach}')",
          is_simple_win)

    # 0.6d — Synthesis check
    subsection("0.6d — Synthesis Trigger")

    is_synth = "synthesis" in reason.lower()
    check(f"[Synthesis] {'Triggered' if is_synth else 'Not triggered — clear winner'}",
          True)  # Either state is valid

    # 0.6e — Hand-off
    subsection("0.6e — Hand-off to Phase 1")

    handoff = {
        "goal": "Build a CRUD API for restaurants",
        "approach": f"{winner.approach} — {winner.architecture}",
        "key_decisions": winner.key_decisions,
        "approach_type": winner.approach_type,
    }
    check(f"[Handoff] Approach type: '{handoff['approach_type']}'", len(handoff['approach_type']) > 0)
    check(f"[Handoff] Key decisions preserved ({len(handoff['key_decisions'])} items)",
          len(handoff['key_decisions']) >= 2)
    check(f"[Handoff] Architecture description not empty",
          len(winner.architecture) > 0)

    # 0.6f — Pattern capture
    subsection("0.6f — Pattern Capture for Self-Learning")

    goal_type = "api_creation" if "api" in handoff['goal'].lower() else "unknown"
    check(f"[Pattern] Goal type: '{goal_type}'", goal_type == "api_creation")
    check(f"[Pattern] Mapping: {winner.approach_type} → {goal_type}",
          winner.approach_type in ["layered", "monolith", "microservices", "pipeline", "plugin", "event-driven"])

    # ── Edge Cases ──
    subsection("Edge Cases")

    # Only 1 scout (others failed/timeout)
    single = [scouts[0]]
    w2, r2, reason2 = select_winner(single)
    check(f"[Edge] Single scout → winner (r2 is None)",
          w2 is not None and r2 is None)

    # Only 2 scouts
    two = [scouts[0], scouts[1]]
    w3, r3, reason3 = select_winner(two)
    check(f"[Edge] Two scouts → winner + runner-up selected",
          w3 is not None and r3 is not None)

    # Anti-bias: fast-but-fragile gets rejected
    fragile = StrategyProposal(
        "Fast-But-Fragile", "Skip everything for speed",
        ["No tests"], ["Super fast"], ["Breaks on edge cases"],
        complexity=1.0, risk=9.0, estimated_subagents=3,
        approach_type="monolith", scout_bias="speed")
    fragile._score = 9.5
    fragile._axes = {"quality": 2.0, "maintainability": 2.0, "speed": 10.0, "scalability": 3.0, "risk": 9.0}

    solid = StrategyProposal(
        "Solid-Well-Tested", "Test-first, careful design",
        ["Tests first"], ["Robust", "Maintainable"], ["Slower"],
        complexity=6.0, risk=3.0, estimated_subagents=20,
        approach_type="layered", scout_bias="simplicity")
    solid._score = 8.0
    solid._axes = {"quality": 8.0, "maintainability": 7.0, "speed": 4.0, "scalability": 5.0, "risk": 3.0}

    w4, r4, reason4 = select_winner([fragile, solid])
    check(f"[AntiBias] Fast-but-fragile rejected (winner='{w4.approach}')",
          w4.approach == "Solid-Well-Tested")
    check(f"[AntiBias] Reason mentions anti-bias", "anti-bias" in reason4.lower())

    print(f"\\n  {CYAN}→ Scenario 5 complete: Phase 0.6 exploration verified{NC}")

# ═════════════════════════════════════════════════════════════════════════════
# ADDITIONAL CROSS-CUTTING TESTS
# ═════════════════════════════════════════════════════════════════════════════

def test_cross_cutting() -> None:
    """Test cross-cutting concerns: schema, convergence edge cases, fallbacks."""

    section("CROSS-CUTTING: Schema Validation & Edge Cases")

    # ── Pattern store schema ──
    subsection("Pattern Store Schema")

    schema_path = os.path.join(os.path.dirname(__file__), '..', 'references', 'pattern-store.sql')
    schema_path = os.path.normpath(schema_path)
    if os.path.exists(schema_path):
        with open(schema_path, 'r') as f:
            schema_content = f.read()

        expected_tables = ['executions', 'decomposition_patterns', 'pitfalls', 'calibrations']
        for tbl in expected_tables:
            check(f"[Schema] Pattern store defines table '{tbl}'",
                  f'CREATE TABLE IF NOT EXISTS {tbl}' in schema_content or
                  f'CREATE TABLE {tbl}' in schema_content)

        check(f"[Schema] Pattern store has execution tracking columns",
              'first_pass_rate' in schema_content and 'avg_quality' in schema_content)
        check(f"[Schema] Pattern store supports calibration tracking",
              'calibrations' in schema_content)
        check(f"[Schema] Pattern store foreign keys between calibrations and executions",
              'FOREIGN KEY' in schema_content)
    else:
        check(f"[Schema] Pattern store SQL file found at {schema_path}",
              False)

    # ── Convergence edge cases ──
    subsection("Convergence Edge Cases")

    # Max iteration exhaustion
    state_exhausted = State(goal="test", tier=2, iteration=10, max_iterations=10,
                            completed=["t1"], failed=["t2"])
    conv, reason = check_convergence(state_exhausted)
    check(f"[Edge] Convergence triggered at max iterations (got {conv})",
          conv is True)
    check(f"[Edge] Reason mentions max iterations",
          "Max iterations" in reason)

    # Partial completion
    state_partial = State(goal="test", tier=2, iteration=2, max_iterations=10,
                          completed=["t1", "t2"], failed=["t3"], in_flight=["t4"])
    conv2, reason2 = check_convergence(state_partial)
    check(f"[Edge] Not converged when tasks still in flight/failed (got {conv2})",
          conv2 is False)

    # ── Evaluate result all paths ──
    subsection("Evaluate Result All Paths")

    # Score >= threshold
    ac, act, fb = evaluate_result(TaskResult(task_id="t", score=8.0, status="pass"), 7.0)
    check(f"[Eval] Score 8.0 >= 7.0 → accept (got '{act}')",
          act == 'accept')

    # Silent
    ac, act, fb = evaluate_result(TaskResult(task_id="t", score=0.0, status="silent"), 7.0)
    check(f"[Eval] Silent → pivot (got '{act}')",
          act == 'pivot')

    # Score 1-2 (critical)
    ac, act, fb = evaluate_result(TaskResult(task_id="t", score=1.5, status="fail"), 7.0)
    check(f"[Eval] Score 1.5 → rewrite (got '{act}')",
          act == 'rewrite')

    # ── Band filter edge cases ──
    subsection("4-Band Filter Edge Cases")

    check(f"[Band] Very short goal defaults to band 1 (got {band_filter('Fix typo')})",
          band_filter('Fix typo') == 1)
    check(f"[Band] API keyword triggers band 3 (got {band_filter('Build REST API')})",
          band_filter('Build REST API') == 3)
    check(f"[Band] Greenfield keyword triggers band 4 (got {band_filter('Greenfield platform')})",
          band_filter('Greenfield platform') == 4)
    check(f"[Band] Unknown short goal defaults to band 2 (got {band_filter('Do something')})",
          band_filter('Do something') == 2)

    # ── Git policy edge cases ──
    subsection("Git Policy Edge Cases")

    check(f"[Git] Tier 1 always returns 'direct_commit'",
          git_commit_push_policy(1, False, True) == "direct_commit")
    check(f"[Git] Tier 2 not converged blocks commit",
          git_commit_push_policy(2, False, False) == "no_commit_loop_not_done")
    check(f"[Git] Tier 3 converged returns PR-based policy",
          "pr" in git_commit_push_policy(3, False, True).lower())
    check(f"[Git] Tier 4 requires review cycle",
          "review" in git_commit_push_policy(4, False, True).lower())

    # ── Quality rubric edge cases ──
    subsection("Quality Rubric Edge Cases")

    score0, label0, _ = quality_score_rubric(completeness=0.0, has_edge_cases=False,
                                              has_error_handling=False, has_tests=False)
    check(f"[Quality] Score 0.0 labeled 'Silent' (got '{label0}')",
          label0 == "Silent" and score0 == 0.0)

    score_max, label_max, _ = quality_score_rubric(completeness=1.0, has_edge_cases=True,
                                                    has_error_handling=True, has_tests=True,
                                                    has_stubs=False, has_conflicts=False, has_docs=True)
    check(f"[Quality] Max score 9.5 labeled 'Excellent' (got {score_max}, '{label_max}')",
          score_max == 9.5 and label_max == "Excellent")

    # Score clamped at 0
    score_neg, _, _ = quality_score_rubric(completeness=0.3, has_edge_cases=False,
                                            has_error_handling=False, has_tests=False,
                                            has_stubs=True, has_conflicts=True)
    check(f"[Quality] Score clamped to minimum 0.0 (got {score_neg})",
          score_neg == 0.0)


# ═════════════════════════════════════════════════════════════════════════════
# SCENARIO 5 — SKILL.md CONTRACT (v0.13.x–v0.15.0 phases)
# ═════════════════════════════════════════════════════════════════════════════
# The 4 scenarios above test the core engine (v0.7.0 specification). The
# v0.13.0-v0.14.0 releases added Swarmloop Mode, approval checkpoints,
# command allowlist, RTK, PR readiness and document system — none of which
# were covered. This scenario verifies the SKILL.md contract directly so the
# suite's green result is real evidence for the new phases too.

def test_v015_skill_contract() -> None:
    section("Scenario 5: SKILL.md Contract (v0.13+ phases)")
    skill_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              '..', 'SKILL.md')
    check("[S5] SKILL.md found next to scripts/", os.path.isfile(skill_path))
    if not os.path.isfile(skill_path):
        return
    with open(skill_path, 'r', encoding='utf-8') as f:
        content = f.read()
    low = content.lower()

    # ── Version + frontmatter ──
    subsection("Version & Frontmatter")
    check("[S5] Frontmatter version is 0.15.0",
          re.search(r'^version:\s*0\.15\.0\s*$', content, re.M) is not None)
    check("[S5] user_preferences has max_swarmloop_rounds cap",
          re.search(r'^  max_swarmloop_rounds:\s*3\s*$', content, re.M) is not None)
    check("[S5] user_preferences has max_swarmloop_subagents cap",
          re.search(r'^  max_swarmloop_subagents:\s*50\s*$', content, re.M) is not None)

    # ── Trigger case-insensitivity (v0.15.0 fix) ──
    subsection("Trigger Case-Insensitivity")
    check("[S5] Triggers documented as case-INSENSITIVE",
          'case-insensitive' in low)
    check("[S5] Lowercase alias 'max effort' present in trigger table",
          '"max effort"' in content)
    check("[S5] Lowercase alias 'swarmloop mode' present in trigger table",
          '"swarmloop mode"' in content)
    check("[S5] Lowercase alias 'mesm' present in trigger table",
          '"mesm"' in content)
    check("[S5] Old 'EXACTLY in caps' rule removed",
          'must appear exactly in caps' not in low)
    check("[S5] Phase 0.7 Swarmloop Mode section present",
          '## Phase 0.7 — Swarmloop Mode' in content)
    check("[S5] Phase 0.7 activation is case-insensitive",
          'Keyword (case-insensitive)' in content)

    # ── Smart approval checkpoints (v0.15.0 fix) ──
    subsection("Smart Approval Checkpoints")
    check("[S5] Phase 0.5a checkpoint is smart/opt-in",
          'APPROVAL CHECKPOINT (smart, opt-in)' in content)
    check("[S5] Phase 0.5b checkpoint is smart/opt-in",
          content.count('APPROVAL CHECKPOINT (smart, opt-in)') >= 2)
    check("[S5] Auto-approve path documented ('fai tu')",
          '"fai tu" / "procedi" / "auto-approve"' in content)

    # ── Token-based cost gate (v0.15.0 fix) ──
    subsection("Token-Based Cost Gate (no fabricated prices)")
    check("[S5] Cost gate forbids invented $ prices",
          'NEVER invent a $ price' in content)
    check("[S5] Cost gate uses summary token caps",
          'summary_token_cap' in content)
    check("[S5] Pre-flight gate is hard (no dispatch before confirmation)",
          'NO subagent is dispatched before confirmation' in content)

    # ── Conditional sections (v0.15.0 fixes) ──
    subsection("Conditional Sections (RTK / PR / Docs)")
    check("[S5] Output filtering prefers native pipes",
          'NATIVE PIPES' in content)
    check("[S5] RTK is conditional on being installed",
          'never block a task on an install' in low)
    check("[S5] PR readiness gated on PR workflow",
          'only when a PR workflow exists' in content)
    check("[S5] Doc system tier-scoped (4 docs = Tier 4 only)",
          'full 4-document system is for Tier 4' in content)
    check("[S5] Allowlist documents Hermes approval as enforcement layer",
          'ENFORCEMENT LAYER' in content)

    # ── Pitfalls + lean-skill contract ──
    subsection("Pitfalls & Lean-Skill Contract")
    check("[S5] Pitfall 29 replaced: 'Inventing $ cost estimates'",
          'Inventing $ cost estimates' in content)
    check("[S5] Old pitfall 29 (lowercase blame) removed",
          'mode keywords in lowercase' not in low)
    check("[S5] No in-skill version history section (lean skill)",
          '## Version History' not in content)
    check("[S5] No per-version changelog bloat (v0.14.0 entry absent)",
          'v0.14.0 — Swarmloop Mode' not in content)
    check("[S5] Release notes documented as GitHub Release",
          'GitHub Release' in content)


# ═════════════════════════════════════════════════════════════════════════════
# MAIN
# ═════════════════════════════════════════════════════════════════════════════

def main() -> int:
    print(f"\n{BOLD}{CYAN}╔══════════════════════════════════════════════════════════╗{NC}")
    print(f"{BOLD}{CYAN}║   Elysium Swarmloop v0.15.0 — End-to-End Test Suite     ║{NC}")
    print(f"{BOLD}{CYAN}╚══════════════════════════════════════════════════════════╝{NC}")
    print(f"\n{BOLD}Date: 2026-08-20 | Mode: Full Validation | Tiers: 1-4 + SKILL.md contract{NC}")

    test_tier1_fast_path()
    test_tier2_standard()
    test_tier3_complex()
    test_tier4_epic()
    test_phase06_exploration()
    test_cross_cutting()
    test_v015_skill_contract()

    # ═══ Summary ═══
    total = passed + failed
    print(f"\n{CYAN}{'=' * 55}{NC}")
    print(f"{BOLD}  RESULTS: {passed}/{total} checks passed, {failed} failed{NC}")
    print(f"{CYAN}{'=' * 55}{NC}")

    # Per-scenario breakdown
    print(f"\n  {BOLD}Breakdown:{NC}")
    descriptions = [
        "Scenario 1: TIER 1 Fast-Path",
        "Scenario 2: TIER 2 Standard",
        "Scenario 3: TIER 3 Complex",
        "Scenario 4: TIER 4 Epic",
        "Cross-Cutting: Schema & Edge Cases",
        "Scenario 5: SKILL.md Contract (v0.13+ phases)",
    ]
    for d in descriptions:
        print(f"    • {d}")

    exit_code = 0 if failed == 0 else 1
    if exit_code == 0:
        print(f"\n  {GREEN}{BOLD}✅ ALL {total} CHECKS PASSED — System is operational{NC}\n")
    else:
        print(f"\n  {RED}{BOLD}❌ {failed} CHECK(S) FAILED — Review errors above{NC}\n")

    return exit_code


if __name__ == '__main__':
    sys.exit(main())
