"""session_manager.py — Elysium Swarmloop v0.7.0

Long Session Management (Phase 11).
Tracks session state, quality trends, checkpoints, and interrupt recovery
for autonomous multi-agent orchestration sessions.

Compatible with Python 3.11+.  No external dependencies beyond stdlib.

Usage:
    manager = SessionManager(
        session_id="swarm-20260715-001",
        goal="Build REST API for restaurant booking",
    )
    summary = manager.track_turn(
        action="decompose", files=["routes.py", "models.py"], score=8.5,
    )
    if manager.should_checkpoint():
        cp = manager.checkpoint()
    context = manager.get_context_summary()
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ── Constants ──────────────────────────────────────────────────────────────

DEFAULT_SESSION_DIR: Path = Path.home() / ".hermes" / "sessions"
"""Default on-disk location for session state files."""

CHECKPOINT_TURN_INTERVAL: int = 8
"""Number of turns between automatic checkpoints."""

CHECKPOINT_TIME_INTERVAL: int = 600
"""Seconds (10 minutes) between automatic checkpoints."""

QUALITY_TREND_WINDOW: int = 5
"""Number of recent quality scores retained for trend analysis."""

CONTEXT_SUMMARY_MAX_CHARS: int = 800
"""Character budget for the context-window summary (~200 tokens)."""


# ── Exceptions ─────────────────────────────────────────────────────────────

class SessionError(Exception):
    """Base exception for session management errors."""


class SessionNotFoundError(SessionError):
    """Raised when a session file is not found on disk."""


class SessionCorruptedError(SessionError):
    """Raised when a session file is corrupted or unparseable."""


# ── SessionManager ─────────────────────────────────────────────────────────

class SessionManager:
    """Long-running session state tracker for autonomous agent loops.

    Manages session persistence, automatic checkpointing, quality trend
    monitoring, interrupt recovery, and context-window budget summaries
    for the Elysium Swarmloop orchestration engine.

    Attributes:
        session_id: Unique identifier for this session.
        goal: The high-level objective of this session.
        state: Mutable dictionary of the current session state.  Exposed
               for introspection; prefer the public API for mutations.
    """

    def __init__(
        self,
        session_id: str,
        goal: str,
        *,
        session_dir: Path | str | None = None,
    ) -> None:
        """Initialise a new session manager.

        Creates an in-memory state object with default values.  The state
        is **not** persisted until the first call to :meth:`track_turn`,
        :meth:`track_decision`, or :meth:`checkpoint`.

        Args:
            session_id: Unique identifier (e.g. ``"swarm-20260715-001"``).
            goal: High-level objective statement.
            session_dir: Override directory for session files.
                         Defaults to ``~/.hermes/sessions/``.

        Raises:
            ValueError: If *session_id* or *goal* are empty or whitespace.
        """
        if not session_id or not session_id.strip():
            raise ValueError("session_id must be a non-empty string")
        if not goal or not goal.strip():
            raise ValueError("goal must be a non-empty string")

        self.session_id: str = session_id.strip()
        self.goal: str = goal.strip()
        self._session_dir: Path = (
            Path(session_dir) if session_dir else DEFAULT_SESSION_DIR
        )
        self._session_path: Path = self._session_dir / f"{session_id}.json"

        now = _now_iso()
        self.state: dict[str, Any] = {
            # Identity
            "session_id": session_id,
            "goal": self.goal,
            "version": "0.7.0",
            # Progress
            "status": "active",
            "turn_count": 0,
            "completed_tasks": 0,
            "failed_tasks": 0,
            "files_modified": [],
            # Quality
            "quality_scores": [],
            "quality_trend": "stable",
            # Architectural decisions
            "decisions": [],
            # Checkpointing
            "start_time": now,
            "last_active": now,
            "last_checkpoint_time": now,
            "last_checkpoint_turn": 0,
            "checkpoint_count": 0,
            "checkpoints": [],
        }

    # ── Public API ───────────────────────────────────────────────────────

    def track_turn(
        self,
        action: str,
        files: list[str] | None = None,
        score: float | None = None,
    ) -> dict[str, Any]:
        """Record a turn and return the current state summary.

        Increments the turn counter, optionally records modified files and
        a quality score, updates the quality trend, and persists state to
        disk.  Call this after every subagent dispatch, retry, or gather
        cycle.

        Args:
            action: Description of the action taken (e.g. ``"decompose"``,
                    ``"scatter"``, ``"stream"``, ``"retry"``).
            files: List of file paths modified during this turn.
            score: Quality score for this turn (0.0 to 10.0).  Values
                   should follow the rubric in the Elysium Swarmloop
                   SKILL.md Quality Matrix.

        Returns:
            A summary dict with key progress metrics (see :meth:`get_summary`).

        Raises:
            ValueError: If *action* is empty or *score* is outside [0, 10].
        """
        if not action or not action.strip():
            raise ValueError("action must be a non-empty string")
        if score is not None and (score < 0.0 or score > 10.0):
            raise ValueError(f"score must be between 0.0 and 10.0, got {score}")

        self.state["turn_count"] += 1
        self.state["last_active"] = _now_iso()

        # Track modified files (deduplicated insertion order)
        if files:
            existing = set(self.state["files_modified"])
            for f in files:
                if f not in existing:
                    self.state["files_modified"].append(f)

        # Track quality score and update trend
        if score is not None:
            self.state["quality_scores"].append(score)
            if len(self.state["quality_scores"]) > QUALITY_TREND_WINDOW:
                self.state["quality_scores"] = (
                    self.state["quality_scores"][-QUALITY_TREND_WINDOW:]
                )
            self._update_quality_trend()

        # Persist after every turn so recovery is never stale
        self._save()

        return self.get_summary()

    def track_decision(self, decision: str, rationale: str) -> None:
        """Log an architectural decision at the current turn.

        Decisions are timestamped and associated with the turn number so
        the context summary and recovery report can reconstruct the
        reasoning chain.

        Args:
            decision: The decision made (e.g. ``"Use FastAPI over Flask"``).
            rationale: Why this decision was made.

        Raises:
            ValueError: If either argument is empty.
        """
        if not decision or not decision.strip():
            raise ValueError("decision must be a non-empty string")
        if not rationale or not rationale.strip():
            raise ValueError("rationale must be a non-empty string")

        self.state["decisions"].append({
            "turn": self.state["turn_count"],
            "decision": decision.strip(),
            "rationale": rationale.strip(),
            "timestamp": _now_iso(),
        })
        self._save()

    def should_checkpoint(self) -> bool:
        """Check whether a checkpoint is warranted.

        Returns ``True`` if **either** condition is met:

        * **Turn-based**: ``CHECKPOINT_TURN_INTERVAL`` (8) turns have
          elapsed since the last checkpoint.
        * **Time-based**: ``CHECKPOINT_TIME_INTERVAL`` (600 s / 10 min)
          have elapsed since the last checkpoint.

        Returns:
            ``True`` when a checkpoint should be created.
        """
        # Turn-based trigger
        turns_since = (
            self.state["turn_count"] - self.state["last_checkpoint_turn"]
        )
        if turns_since >= CHECKPOINT_TURN_INTERVAL:
            return True

        # Time-based trigger
        if self.state["last_checkpoint_time"]:
            try:
                last_cp = datetime.fromisoformat(
                    self.state["last_checkpoint_time"]
                )
                elapsed = (
                    datetime.now(timezone.utc) - last_cp
                ).total_seconds()
                if elapsed >= CHECKPOINT_TIME_INTERVAL:
                    return True
            except (ValueError, TypeError):
                # Malformed timestamp — checkpoint to be safe
                return True

        return False

    def checkpoint(self) -> dict[str, Any]:
        """Create a checkpoint, reset timers, and return a summary.

        Snapshots the current state into the ``checkpoints`` list,
        resets turn and time timers, and persists to disk.  Call this
        when :meth:`should_checkpoint` returns ``True``, or explicitly
        after a significant milestone.

        Returns:
            A summary dict with the checkpoint number, turn, timestamp,
            and a human-readable one-line summary.
        """
        now = _now_iso()
        cp_number = self.state["checkpoint_count"] + 1

        checkpoint_entry: dict[str, Any] = {
            "checkpoint": cp_number,
            "timestamp": now,
            "turn": self.state["turn_count"],
            "completed_tasks": self.state["completed_tasks"],
            "failed_tasks": self.state["failed_tasks"],
            "quality_scores": list(self.state["quality_scores"]),
            "quality_trend": self.state["quality_trend"],
            "files_modified_count": len(self.state["files_modified"]),
            "decision_count": len(self.state["decisions"]),
        }
        self.state["checkpoints"].append(checkpoint_entry)
        self.state["checkpoint_count"] = cp_number
        self.state["last_checkpoint_time"] = now
        self.state["last_checkpoint_turn"] = self.state["turn_count"]
        self._save()

        return {
            "checkpoint": cp_number,
            "turn": self.state["turn_count"],
            "timestamp": now,
            "summary": (
                f"Checkpoint #{cp_number} at turn "
                f"{self.state['turn_count']}: "
                f"{self.state['completed_tasks']} completed, "
                f"{self.state['failed_tasks']} failed"
            ),
        }

    def get_summary(self) -> dict[str, Any]:
        """Return the current state summary with quality trend analysis.

        This is the standard introspection method — call it after
        :meth:`track_turn` or at any point to get a compact view of
        session health.

        Returns:
            A dict containing:
            * ``session_id``, ``goal``, ``status``
            * ``turn_count``, ``completed_tasks``, ``failed_tasks``
            * ``files_modified`` (count), ``decisions_made`` (count)
            * ``checkpoints`` (count)
            * ``quality`` — nested dict with ``scores``, ``average``,
              ``trend``
        """
        scores = self.state["quality_scores"]
        avg_q = sum(scores) / len(scores) if scores else 0.0

        return {
            "session_id": self.session_id,
            "goal": self.goal,
            "status": self.state["status"],
            "turn_count": self.state["turn_count"],
            "completed_tasks": self.state["completed_tasks"],
            "failed_tasks": self.state["failed_tasks"],
            "files_modified": len(self.state["files_modified"]),
            "decisions_made": len(self.state["decisions"]),
            "checkpoints": self.state["checkpoint_count"],
            "quality": {
                "scores": list(scores),
                "average": round(avg_q, 2),
                "trend": self.state["quality_trend"],
            },
        }

    def recover(self) -> dict[str, Any]:
        """Recover a session after a crash or interrupt.

        Loads the persisted state from disk (if any) and returns a
        structured recovery payload with timing metrics and a
        human-readable next-action suggestion.

        Safe to call multiple times — does not mutate state unless
        it needs to initialise a brand-new session file on first run.

        Returns:
            Recovery dict with keys:

            * ``state`` — full session state dict.
            * ``elapsed_seconds`` — seconds since ``start_time``.
            * ``idle_seconds`` — seconds since ``last_active``.
            * ``suggestion`` — contextual recovery recommendation.
            * ``is_new`` — ``True`` if no prior persisted state existed.

        Raises:
            SessionCorruptedError: If the session file was found but
                could not be parsed.
        """
        loaded = self._load()
        if loaded is None:
            # Brand-new session — write initial state so subsequent
            # recover() calls find something.
            self._save()
            return {
                "state": dict(self.state),
                "elapsed_seconds": 0,
                "idle_seconds": 0,
                "suggestion": "No prior state found. Starting fresh session.",
                "is_new": True,
            }

        self.state = loaded

        now_dt = datetime.now(timezone.utc)
        elapsed = 0
        idle = 0

        try:
            start = datetime.fromisoformat(self.state["start_time"])
            elapsed = int((now_dt - start).total_seconds())
        except (ValueError, TypeError):
            pass

        try:
            last = datetime.fromisoformat(self.state["last_active"])
            idle = int((now_dt - last).total_seconds())
        except (ValueError, TypeError):
            pass

        suggestion = self._build_recovery_suggestion(elapsed, idle)

        return {
            "state": dict(self.state),
            "elapsed_seconds": elapsed,
            "idle_seconds": idle,
            "suggestion": suggestion,
            "is_new": False,
        }

    def get_context_summary(self) -> str:
        """Generate a compact summary for context-window injection.

        Designed to fit in ~200 tokens when the context window is >60%
        saturated.  Includes goal, progress, quality, recent decisions,
        file list, and checkpoint status.  Truncates at a word boundary
        if over budget.

        Returns:
            A single-line (pipe-separated) plain-text summary string.
        """
        parts: list[str] = []
        s = self.state

        # Goal + status (truncated goal to 80 chars)
        goal_trunc = self.goal[:80]
        parts.append(f"Session: {self.session_id} | Goal: {goal_trunc}")
        parts.append(
            f"Status: {s['status']} | Turns: {s['turn_count']} | "
            f"Done: {s['completed_tasks']} | Failed: {s['failed_tasks']}"
        )

        # Quality
        scores = s["quality_scores"]
        if scores:
            avg_q = sum(scores) / len(scores)
            parts.append(
                f"Quality: {round(avg_q, 1):.1f}/10 "
                f"(last {len(scores)} scores, trend: {s['quality_trend']})"
            )
        else:
            parts.append("Quality: not yet measured")

        # Files (show up to 5, indicate remainder)
        files = s["files_modified"]
        if files:
            file_list = ", ".join(files[:5])
            if len(files) > 5:
                file_list += f" (+{len(files) - 5} more)"
            parts.append(f"Files: {file_list}")

        # Recent decisions (last 3)
        decisions = s["decisions"]
        if decisions:
            recent = decisions[-3:]
            dec_lines = []
            for d in recent:
                dec = d["decision"][:60]
                dec_lines.append(f"T{d['turn']}: {dec}")
            parts.append("Decisions: " + " | ".join(dec_lines))

        # Checkpoints
        parts.append(
            f"Checkpoints: {s['checkpoint_count']} "
            f"(last at turn {s['last_checkpoint_turn']})"
        )

        text = " | ".join(parts)

        # Enforce character budget (approximate token budget)
        if len(text) > CONTEXT_SUMMARY_MAX_CHARS:
            text = text[: CONTEXT_SUMMARY_MAX_CHARS - 3]
            last_space = text.rfind(" ")
            if last_space > CONTEXT_SUMMARY_MAX_CHARS // 2:
                text = text[:last_space]
            text += "..."

        return text

    # ── Persistence helpers ───────────────────────────────────────────────

    def _save(self) -> None:
        """Persist the current state to ``~/.hermes/sessions/<id>.json``.

        Uses an atomic write pattern (write to ``.tmp``, then ``os.replace``)
        to avoid partial writes on crash.

        Raises:
            SessionError: If the file cannot be written.
        """
        try:
            self._session_dir.mkdir(parents=True, exist_ok=True)
            tmp_path = self._session_path.with_suffix(".tmp")
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(self.state, f, indent=2, ensure_ascii=False)
            # Atomic replace on POSIX; near-atomic on Windows NTFS
            os.replace(tmp_path, self._session_path)
        except OSError as e:
            raise SessionError(
                f"Failed to persist session {self.session_id}: {e}"
            ) from e

    def _load(self) -> dict[str, Any] | None:
        """Load session state from disk.

        Returns:
            The state dict if the file exists, or ``None`` if no prior
            state was persisted.

        Raises:
            SessionCorruptedError: If the file exists but is unparseable.
        """
        if not self._session_path.exists():
            return None

        try:
            with open(self._session_path, "r", encoding="utf-8") as f:
                data: dict[str, Any] = json.load(f)
            return data
        except (json.JSONDecodeError, OSError) as e:
            raise SessionCorruptedError(
                f"Session file {self._session_path} is corrupted: {e}"
            ) from e

    # ── Internal helpers ──────────────────────────────────────────────────

    def _update_quality_trend(self) -> None:
        """Recalculate the quality trend label from recent scores.

        Trend is one of ``"improving"``, ``"degrading"``, or ``"stable"``.
        With 4+ scores, compares the mean of the last 2 against the mean
        of the 2 before that.  With 2-3 scores, compares first to last.
        """
        scores = self.state["quality_scores"]
        if len(scores) < 2:
            self.state["quality_trend"] = "stable"
            return

        if len(scores) >= 4:
            recent = scores[-2:]
            prior = scores[-4:-2]
            recent_avg = sum(recent) / len(recent)
            prior_avg = sum(prior) / len(prior)

            if recent_avg < prior_avg - 0.5:
                self.state["quality_trend"] = "degrading"
            elif recent_avg > prior_avg + 0.5:
                self.state["quality_trend"] = "improving"
            else:
                self.state["quality_trend"] = "stable"
        else:
            # With only 2-3 scores, compare first and last
            if scores[-1] < scores[0] - 0.5:
                self.state["quality_trend"] = "degrading"
            elif scores[-1] > scores[0] + 0.5:
                self.state["quality_trend"] = "improving"
            else:
                self.state["quality_trend"] = "stable"

    def _build_recovery_suggestion(
        self, elapsed: int, idle: int
    ) -> str:
        """Build a human-readable recovery suggestion based on state."""
        s = self.state

        # Completed session
        if s["status"] == "completed":
            return (
                f"Session '{self.session_id}' is marked as completed "
                f"after {s['turn_count']} turns. "
                "No recovery needed."
            )

        # Extended idle (> 1 hour)
        if idle > 3600:
            return (
                f"Session was idle for {idle // 60} minutes. "
                f"Last active at turn {s['turn_count']}. "
                "Consider archiving this session and starting a new one."
            )

        # Moderate idle (> 10 min, ≤ 1 hour)
        if idle > 600:
            return (
                f"Session appears stale ({idle // 60} min idle). "
                f"Resuming at turn {s['turn_count']}. "
                f"Last checkpoint: #{s['checkpoint_count']} "
                f"(turn {s['last_checkpoint_turn']}). "
                "Consider creating a checkpoint and re-evaluating the goal."
            )

        # Recent interruption — build context-aware suggestion
        suggestion: str = (
            f"Resuming session at turn {s['turn_count']}. "
            f"Completed: {s['completed_tasks']}, "
            f"Failed: {s['failed_tasks']}. "
        )

        scores = s["quality_scores"]
        if scores:
            avg_q = sum(scores) / len(scores)
            suggestion += (
                f"Average quality: {avg_q:.1f}/10 "
                f"(trend: {s['quality_trend']}). "
            )
            if s["quality_trend"] == "degrading":
                suggestion += (
                    "⚠️  Quality is degrading — consider adjusting "
                    "decomposition granularity or retrying failed tasks. "
                )

        if s["checkpoint_count"] > 0:
            suggestion += (
                f"Last checkpoint: #{s['checkpoint_count']} "
                f"at turn {s['last_checkpoint_turn']}. "
            )

        suggestion += (
            "Suggested action: "
            f"{'continue streaming' if s['turn_count'] > 0 else 'decompose goal and dispatch tasks'}."
        )

        return suggestion


# ── Helpers ────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    """Return the current UTC time as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


__all__ = [
    "SessionManager",
    "SessionError",
    "SessionNotFoundError",
    "SessionCorruptedError",
]
