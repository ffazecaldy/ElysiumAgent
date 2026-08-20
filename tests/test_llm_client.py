import time

import httpx
import pytest

from llm.client import LLMClient, QuotaExhaustedError


async def test_completion_usa_config():
    c = LLMClient(base_url="http://mock", api_key="k", model="deepseek-v4-pro")
    assert c.model == "deepseek-v4-pro"


async def test_retry_su_5xx_transitorio():
    n = {"count": 0}

    def handler(request):
        n["count"] += 1
        if n["count"] < 3:
            return httpx.Response(500, json={"error": "boom"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    c = LLMClient(base_url="http://mock", api_key="k", max_retries=3,
                  retry_backoff_s=0.05, _transport=httpx.MockTransport(handler))
    resp = await c.complete([{"role": "user", "content": "x"}])
    assert resp["choices"][0]["message"]["content"] == "ok"
    assert n["count"] == 3


async def test_quota_esaurita_non_ritenta():
    call_count = {"n": 0}

    def handler(request):
        call_count["n"] += 1
        return httpx.Response(429, json={"error": {"message": "quota exhausted, retry in 5 hours"}},
                              headers={"x-quota-exhausted": "true"})

    c = LLMClient(base_url="http://mock", api_key="k", max_retries=3,
                  retry_backoff_s=0.01, _transport=httpx.MockTransport(handler))
    with pytest.raises(QuotaExhaustedError):
        await c.complete([{"role": "user", "content": "x"}])
    assert call_count["n"] == 1  # mai retry cieco su quota morta


async def test_429_transitorio_rispetta_retry_after():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, json={"error": "rate limited"},
                                  headers={"Retry-After": "1"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    c = LLMClient(base_url="http://mock", api_key="k", max_retries=3,
                  retry_backoff_s=0.1, max_retry_after_s=2,
                  _transport=httpx.MockTransport(handler))
    t0 = time.monotonic()
    resp = await c.complete([{"role": "user", "content": "x"}])
    elapsed = time.monotonic() - t0
    assert resp["choices"][0]["message"]["content"] == "ok"
    assert elapsed >= 0.9  # ha rispettato Retry-After ~1s (con margine)
