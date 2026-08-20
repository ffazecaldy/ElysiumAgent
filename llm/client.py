"""llm/client.py — client OpenAI-compatible async con retry/backoff.

Distinzione critica (assunzione A7, finestra rolling 5h):
- 429/5xx TRANSITORIO   -> retry (onora Retry-After se presente, altrimenti backoff)
- 429 CON segnale quota -> QuotaExhaustedError AL PRIMO COLPO, senza consumare retry.
  Un retry cieco su quota morta brucia 3 tentativi per ore.
"""
from __future__ import annotations

import asyncio
import logging
import random
from typing import Any, Optional

import httpx

log = logging.getLogger(__name__)

# Segnali nel body che indicano QUOTA ESAURITA (non rate-limit transitorio)
_QUOTA_SIGNALS = (
    "quota", "exhausted", "insufficient", "5 hour",
    "limit reached", "usage limit", "reset in", "no balance",
)
# Header usato da opencode-go per marcare la quota esaurita
_QUOTA_HEADER = "x-quota-exhausted"


class QuotaExhaustedError(Exception):
    """Quota (finestra rolling 5h) esaurita. Intercettata dall'engine:
    stop del run + stato 'quota_exhausted'. MAI retry cieco."""


def _is_quota_signal(status: int, headers: httpx.Headers, body_text: str) -> bool:
    if status != 429:
        return False
    low = body_text.lower()
    if headers.get(_QUOTA_HEADER, "").lower() in ("1", "true", "yes"):
        return True
    return any(s in low for s in _QUOTA_SIGNALS)


class LLMClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str = "deepseek-v4-pro",
        max_retries: int = 3,
        timeout_s: float = 300,
        max_tokens_default: int = 2000,
        retry_backoff_s: float = 1.0,
        max_retry_after_s: float = 30.0,
        _transport: Optional[httpx.AsyncBaseTransport] = None,
    ):
        self.model = model
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._api_key = api_key
        self._max_retries = max_retries
        self._timeout_s = timeout_s
        self._max_tokens_default = max_tokens_default
        self._retry_backoff_s = retry_backoff_s
        self._max_retry_after_s = max_retry_after_s
        self._transport = _transport

    def _client(self) -> httpx.AsyncClient:
        kwargs: dict[str, Any] = {"timeout": self._timeout_s}
        if self._transport is not None:
            kwargs["transport"] = self._transport
        else:
            kwargs["headers"] = {
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            }
        return httpx.AsyncClient(**kwargs)

    async def complete(self, messages: list[dict], max_tokens: Optional[int] = None) -> dict:
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens or self._max_tokens_default,
        }
        attempt = 0
        while True:
            attempt += 1
            try:
                async with self._client() as client:
                    resp = await client.post(self._url, json=payload)
            except httpx.TransportError as exc:
                if attempt > self._max_retries:
                    raise
                delay = self._retry_backoff_s * (2 ** (attempt - 1)) + random.uniform(0, 0.1)
                log.warning("transport error %s, retry %d in %.2fs", exc, attempt, delay)
                await asyncio.sleep(delay)
                continue

            body_text = resp.text
            if resp.status_code == 429 and _is_quota_signal(resp.status_code, resp.headers, body_text):
                raise QuotaExhaustedError(f"quota esaurita (rolling 5h): {body_text[:300]}")

            if resp.status_code >= 500 or resp.status_code == 429:
                if attempt > self._max_retries:
                    resp.raise_for_status()
                retry_after = resp.headers.get("Retry-After")
                if retry_after:
                    try:
                        delay = min(float(retry_after), self._max_retry_after_s)
                    except ValueError:
                        delay = self._retry_backoff_s * (2 ** (attempt - 1))
                else:
                    delay = self._retry_backoff_s * (2 ** (attempt - 1)) + random.uniform(0, 0.1)
                log.warning("HTTP %d, retry %d in %.2fs", resp.status_code, attempt, delay)
                await asyncio.sleep(delay)
                continue

            resp.raise_for_status()
            return resp.json()
