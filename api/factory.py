"""api/factory.py — costruzione dei componenti del run (iniettabile nei test).

Produzione: LLMClient da config.yaml + barra reale (pytest/perf).
Test: FakeLLM + FakeBar deterministiche (mai rete, mai subprocess).
"""
from __future__ import annotations

import asyncio
import os

import yaml

from engine.gauntlet import Gauntlet
from engine.state import detect_tier
from llm.client import LLMClient

CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.yaml")

_test_mode = False


def configure_for_tests() -> None:
    global _test_mode
    _test_mode = True


def reset_tests() -> None:
    global _test_mode
    _test_mode = False


def estimate_tokens_for(goal: str, max_rounds: int) -> int:
    """Phase 0.7a: stima token = subagents × rounds × summary_cap (mai $ inventati)."""
    tier = detect_tier(goal)
    caps = {1: 200, 2: 500, 3: 1000, 4: 2000}
    cap = caps.get(tier, 500)
    subagents = 2  # builder + critic per round
    return subagents * max_rounds * cap


def detect_tier_for(goal: str) -> int:
    return detect_tier(goal)


def build_gauntlet(
    goal: str,
    bar: str,
    max_rounds: int,
    workspace: str,
    status_store: dict,
    approval_event: asyncio.Event,
    stop_event: asyncio.Event,
) -> Gauntlet:
    """Costruisce la Gauntlet completa (LLM + barra) per il run."""
    if _test_mode:
        from api.fakes import FakeBar, FakeLLM  # noqa: PLC0415
        return Gauntlet(
            llm=FakeLLM(),
            bar=FakeBar(always_lose=True),
            max_rounds=max_rounds,
            bar_desc="barra fake (test)",
            status_store=status_store,
            workspace_root=workspace,
        )

    cfg = _load_config()
    llm_cfg = cfg.get("llm", {})
    api_key = os.environ.get(llm_cfg.get("api_key_env", "OPTIMIZE_ENGINE_API_KEY"), "")
    if not api_key:
        raise RuntimeError(
            f"API key mancante: imposta {llm_cfg.get('api_key_env', 'OPTIMIZE_ENGINE_API_KEY')}"
            " (es. OPENCODE_API_KEY)")

    llm = LLMClient(
        base_url=llm_cfg.get("base_url", "https://opencode.ai/zen/go/v1"),
        api_key=api_key,
        model=llm_cfg.get("model", "deepseek-v4-pro"),
        max_retries=llm_cfg.get("max_retries", 3),
        timeout_s=llm_cfg.get("timeout_s", 300),
    )

    if bar == "perf":
        from bar.perf_bar import PerfBar  # noqa: PLC0415
        bar_obj = PerfBar(iterations=5)
        bar_desc = "PerfBar: mediana runtime + memoria"
    else:
        from bar.pytest_bar import PytestBar  # noqa: PLC0415
        bar_obj = PytestBar(test_dir="tests", rootdir=workspace)
        bar_desc = "PytestBar: test pass"

    return Gauntlet(
        llm=llm,
        bar=bar_obj,
        max_rounds=max_rounds,
        bar_desc=bar_desc,
        status_store=status_store,
        workspace_root=workspace,
    )


def _load_config() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except FileNotFoundError:
        data = {}
    return data


def run_workspace(run_id: str) -> str:
    """Directory di lavoro isolata per il run (.sandbox/<run_id>)."""
    root = _load_config().get("sandbox", {}).get("workdir", ".sandbox")
    ws = os.path.join(root, run_id)
    os.makedirs(ws, exist_ok=True)
    return os.path.abspath(ws)
