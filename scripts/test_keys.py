"""test_keys.py — trova quale credenziale del pool opencode-go funziona davvero.

Solo per il Task 10 E2E. Nessun segreto stampato: solo status per indice.
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from llm.client import LLMClient  # noqa: E402


def _pool():
    p = os.path.expanduser("~/AppData/Local/hermes/auth.json")
    with open(p, "r", encoding="utf-8") as f:
        d = json.load(f)
    return (d.get("credential_pool") or {}).get("opencode-go", [])


async def try_key(idx, tok, base="https://opencode.ai/zen/go/v1", model="deepseek-v4-pro"):
    try:
        c = LLMClient(base_url=base, api_key=tok, model=model, timeout_s=60)
        resp = await c.complete([{"role": "user", "content": "Rispondi solo: OK"}], max_tokens=10)
        return f"[{idx}] OK -> {resp['choices'][0]['message']['content']!r}"
    except Exception as e:  # noqa: BLE001
        return f"[{idx}] FAIL -> {type(e).__name__}"


async def main():
    for idx, c in enumerate(_pool()):
        tok = c.get("access_token") or ""
        label = c.get("label")
        # prova anche la env OPENCODE_GO_API_KEY se presente
        print(f"{label}: len={len(tok)}, status={c.get('last_status')}")
        if not tok:
            continue
        print(await try_key(idx, tok))
    # prova env var classiche
    for envname in ("OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"):
        v = os.environ.get(envname)
        if v:
            print(f"env {envname}: " + await try_key(envname, v))


if __name__ == "__main__":
    asyncio.run(main())
