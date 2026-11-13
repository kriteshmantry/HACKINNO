"""Claude structured-output calls with a response cache and graceful fallback.

- No `temperature`: current Claude models reject sampling parameters. Determinism comes
  from the output schema plus the cache key (agent + schema + input).
- Modes (config.LLM_MODE): auto = API if ANTHROPIC_API_KEY is set, else cache;
  cache = never call the API; off = caller uses rules.
- Returns (parsed, source) where source is llm | cache | cache-fallback, or raises
  LLMUnavailable so the caller can drop to its rule-based path.
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import TypeVar

from pydantic import BaseModel

from . import config

T = TypeVar("T", bound=BaseModel)


class LLMUnavailable(Exception): ...


_client = None


def _get_client():
    global _client
    if _client is None:
        import anthropic
        _client = anthropic.Anthropic()
    return _client


def cache_key(agent: str, schema: type[BaseModel], system: str, user: str) -> str:
    raw = json.dumps([agent, schema.__name__, system, user], sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def _cache_path(key: str):
    return config.CACHE_DIR / f"{key}.json"


def _cache_load(key: str) -> dict | None:
    p = _cache_path(key)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def _cache_save(key: str, data: dict) -> None:
    config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _cache_path(key).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def call_structured(agent: str, system: str, user: str, schema: type[T],
                    effort: str = "low") -> tuple[T, str]:
    mode = config.LLM_MODE
    if mode == "off":
        raise LLMUnavailable("LLM disabled")
    key = cache_key(agent, schema, system, user)
    live = mode == "auto" and bool(os.getenv("ANTHROPIC_API_KEY"))
    if not live:
        hit = _cache_load(key)
        if hit is not None:
            return schema.model_validate(hit), "cache"
        raise LLMUnavailable("no API key and no cached response")
    try:
        resp = _get_client().messages.parse(
            model=config.MODEL,
            max_tokens=16000,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_format=schema,
            output_config={"effort": effort},
        )
        if resp.stop_reason == "refusal":
            raise RuntimeError("model declined the request")
        out = resp.parsed_output
        if out is None:
            raise RuntimeError(f"no parsed output (stop_reason={resp.stop_reason})")
        _cache_save(key, out.model_dump())
        return out, "llm"
    except Exception as e:  # network, rate limit, refusal, schema mismatch
        hit = _cache_load(key)
        if hit is not None:
            return schema.model_validate(hit), "cache-fallback"
        raise LLMUnavailable(f"{type(e).__name__}: {e}") from e
