"""test_connect.py — verifica connettività LLM (usata solo nel Task 10 E2E).

Legge la credenziale dal credential pool di Hermes (in memoria, MAI scritta su
disco né stampata) e fa una chiamata di test al provider opencode-go.
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _load_key():
    p = os.path.join(os.environ.get("LOCALAPPDATA", ""), "hermes", "auth.json")
    if not os.path.exists(p):
        p = os.path.expanduser("~/AppData/Local/hermes/auth.json")
    with open(p, "r", encoding="utf-8") as f:
        d = json.load(f)
    pool = d.get("credential_pool") or {}
    for c in pool.get("opencode-go", []):
        tok = c.get("access_token") or ""
        if c.get("last_status") == "ok" and tok.startswith("sk-"):
            return tok
    raise RuntimeError("nessuna credenziale sk- valida nel pool opencode-go")


async def main():
    from llm.client import LLMClient
    key = _load_key()
    cfg = {"base_url": "https://opencode.ai/zen/go/v1", "model": "deepseek-v4-pro"}
    c = LLMClient(base_url=cfg["base_url"], api_key=key, model=cfg["model"], timeout_s=120)
    resp = await c.complete(
        [{"role": "user", "content": "Rispondi solo: OK"}], max_tokens=10)
    print("CONNECT_OK:", resp["choices"][0]["message"]["content"])


if __name__ == "__main__":
    asyncio.run(main())
