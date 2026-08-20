"""tests/test_stream.py — test del metodo stream() di LLMClient.

Usa httpx.MockTransport per simulare una risposta SSE (streaming OpenAI-compatible):
linee `data: {...}` con {choices:[{delta:{content: ...}}]}, terminate da `data: [DONE]`.
"""
import json

import httpx
import pytest

from llm.client import LLMClient, QuotaExhaustedError


def _sse_response(pieces):
    """Risposta 200 text/event-stream fatta di chunk di contenuto + [DONE]."""
    body = b""
    for p in pieces:
        body += b"data: " + json.dumps({"choices": [{"delta": {"content": p}}]}).encode() + b"\n\n"
    body += b"data: [DONE]\n\n"
    return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})


async def test_stream_yields_chunks():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return _sse_response(["ciao", " ", "mondo"])

    c = LLMClient(base_url="http://mock", api_key="k", model="m",
                  _transport=httpx.MockTransport(handler))
    out = []
    async for ch in c.stream([{"role": "user", "content": "x"}]):
        out.append(ch)
    assert "".join(out) == "ciao mondo"
    assert calls["n"] == 1


async def test_stream_onora_done():
    def handler(req):
        return _sse_response(["a"])

    c = LLMClient(base_url="http://mock", api_key="k", model="m",
                  _transport=httpx.MockTransport(handler))
    out = [ch async for ch in c.stream([{"role": "user", "content": "x"}])]
    assert out == ["a"]  # il [DONE] non produce chunk vuoto


async def test_stream_quota_exhausted():
    def handler(req):
        return httpx.Response(429, json={"error": {"message": "quota exhausted"}},
                              headers={"x-quota-exhausted": "true"})

    c = LLMClient(base_url="http://mock", api_key="k", model="m",
                  _transport=httpx.MockTransport(handler))
    with pytest.raises(QuotaExhaustedError):
        async for _ in c.stream([{"role": "user", "content": "x"}]):
            pass
