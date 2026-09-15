"""api/client_factory.py — costruzione del client LLM per l'harness.

Legge config.yaml (provider opencode-go, modello deepseek-v4-flash) e la key
dall'environment OPTIMIZE_ENGINE_API_KEY (valorizzata con OPENCODE_GO_API_KEY).
"""
from __future__ import annotations

import os

import yaml

from llm.client import LLMClient

CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.yaml")


def load_config() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except FileNotFoundError:
        return {}


def get_llm() -> LLMClient:
    cfg = (load_config().get("llm") or {})
    key_env = cfg.get("api_key_env", "OPTIMIZE_ENGINE_API_KEY")
    api_key = os.environ.get(key_env, "") or os.environ.get("OPENCODE_GO_API_KEY", "")
    if not api_key:
        raise RuntimeError(
            f"API key mancante: imposta {key_env} (o OPENCODE_GO_API_KEY)")
    return LLMClient(
        base_url=cfg.get("base_url", "https://opencode.ai/zen/go/v1"),
        api_key=api_key,
        model=cfg.get("model", "deepseek-v4-flash"),
        max_retries=cfg.get("max_retries", 3),
        timeout_s=cfg.get("timeout_s", 300),
    )
