"""tests/test_config.py — verifica caricamento config.yaml e gestione key mancante.

Redisci il client_factory: load_config legge la config dalla root, get_llm
solleva RuntimeError se nessuna API key è presente nell'environment.
"""
import os

import pytest

from api.client_factory import get_llm, load_config


def test_config_carica():
    cfg = load_config()
    assert cfg["llm"]["model"]
    assert cfg["llm"]["base_url"].startswith("https://")


def test_config_provider_opencode():
    cfg = load_config()
    assert cfg["llm"]["provider"] == "opencode-go"


def test_harness_params():
    cfg = load_config()
    h = cfg.get("harness", {})
    assert h.get("max_concurrent", 0) >= 1
    assert h.get("max_retries", 0) >= 1


def test_get_llm_senza_key():
    old = os.environ.get("OPTIMIZE_ENGINE_API_KEY")
    old2 = os.environ.get("OPENCODE_GO_API_KEY")
    os.environ["OPTIMIZE_ENGINE_API_KEY"] = ""
    os.environ["OPENCODE_GO_API_KEY"] = ""
    try:
        with pytest.raises(RuntimeError, match="key mancante"):
            get_llm()
    finally:
        if old:
            os.environ["OPTIMIZE_ENGINE_API_KEY"] = old
        if old2:
            os.environ["OPENCODE_GO_API_KEY"] = old2
