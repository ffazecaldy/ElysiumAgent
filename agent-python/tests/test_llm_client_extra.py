"""Test extra del client LLM — casi a supporto di test_llm_client.py:
- retry su 500 transitorio che poi va a buon fine
- 429 con segnale quota -> QuotaExhaustedError al primo colpo (no retry cieco)
- last_tokens() riflette il usage reale dell'ultima risposta
"""
import httpx
import pytest

from llm.client import LLMClient, QuotaExhaustedError


async def test_retry_500_poi_ok():
    n = {'c': 0}

    def h(req):
        n['c'] += 1
        if n['c'] < 2:
            return httpx.Response(500, json={'error': 'x'})
        return httpx.Response(200, json={'choices': [{'message': {'content': 'ok'}}]})

    c = LLMClient(base_url='http://m', api_key='k', model='m', max_retries=3,
                  retry_backoff_s=0.01, _transport=httpx.MockTransport(h))
    r = await c.complete([{'role': 'user', 'content': 'x'}])
    assert r['choices'][0]['message']['content'] == 'ok'


async def test_quota_non_ritenta():
    n = {'c': 0}

    def h(req):
        n['c'] += 1
        return httpx.Response(429, json={'error': {'message': 'quota out, retry in 5h'}})

    c = LLMClient(base_url='http://m', api_key='k', model='m', max_retries=3,
                  _transport=httpx.MockTransport(h))
    with pytest.raises(QuotaExhaustedError):
        await c.complete([{'role': 'user', 'content': 'x'}])
    assert n['c'] == 1  # mai retry cieco su quota morta


async def test_last_tokens_usage():
    def h(req):
        return httpx.Response(200, json={'choices': [{'message': {'content': 'ok'}}],
                                         'usage': {'total_tokens': 77}})

    c = LLMClient(base_url='http://m', api_key='k', model='m',
                  _transport=httpx.MockTransport(h))
    await c.complete([{'role': 'user', 'content': 'x'}])
    assert c.last_tokens() == 77
