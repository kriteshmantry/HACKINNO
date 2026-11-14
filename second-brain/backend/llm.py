"""Structured-output LLM calls with a response cache and graceful fallback.

Providers (SB_LLM_PROVIDER, or picked from whichever key is set, in this order):
  anthropic  Claude via the Anthropic SDK (messages.parse)            ANTHROPIC_API_KEY
  gemini     Google Gemini, free tier, OpenAI-compatible endpoint     GEMINI_API_KEY
  groq       Groq, free tier, OpenAI-compatible endpoint              GROQ_API_KEY
  ollama     a local model through Ollama, no key                     (set SB_LLM_PROVIDER=ollama)

- No `temperature` on Claude: current Claude models reject sampling parameters. Determinism
  comes from the output schema plus the cache key (agent + schema + input).
- Modes (config.LLM_MODE): auto = call the provider when it is usable, else the cache;
  cache = never call out; off = caller uses rules.
- Every cached answer records the provider and model that wrote it.
- call_structured returns (parsed, source, model) where source is llm | cache | cache-fallback,
  or raises LLMUnavailable so the caller can drop to its rule-based path. Whatever the model
  says is still checked in code (amount must appear in the text, quote must be verbatim).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from typing import TypeVar

from pydantic import BaseModel

from . import config

T = TypeVar("T", bound=BaseModel)

OPENAI_COMPAT = {
    "gemini": {"base_url": "https://generativelanguage.googleapis.com/v1beta/openai", "key_env": "GEMINI_API_KEY",
               "model": "gemini-flash-latest"},
    "groq": {"base_url": "https://api.groq.com/openai/v1", "key_env": "GROQ_API_KEY",
             "model": "openai/gpt-oss-120b"},
    "ollama": {"base_url": "http://localhost:11434/v1", "key_env": None, "model": "qwen2.5:7b"},
}


class LLMUnavailable(Exception): ...


_client = None


def _get_client():
    global _client
    if _client is None:
        import anthropic
        _client = anthropic.Anthropic()
    return _client


# --- provider selection ---------------------------------------------------------------------
def provider() -> str:
    p = os.getenv("SB_LLM_PROVIDER", "").strip().lower()
    if p:
        return p
    for name, env in (("anthropic", "ANTHROPIC_API_KEY"), ("gemini", "GEMINI_API_KEY"), ("groq", "GROQ_API_KEY")):
        if os.getenv(env):
            return name
    return "anthropic"


def model_name(p: str | None = None) -> str:
    p = p or provider()
    if os.getenv("SB_LLM_MODEL"):
        return os.environ["SB_LLM_MODEL"]
    return config.MODEL if p == "anthropic" else OPENAI_COMPAT.get(p, {}).get("model", "unknown")


def usable(p: str | None = None) -> bool:
    """Can this provider be called right now (key present, or a local server)?"""
    p = p or provider()
    if p == "anthropic":
        return bool(os.getenv("ANTHROPIC_API_KEY"))
    spec = OPENAI_COMPAT.get(p)
    if spec is None:
        return False
    return spec["key_env"] is None or bool(os.getenv(spec["key_env"]))


# --- cache ------------------------------------------------------------------------------------
def cache_key(agent: str, schema: type[BaseModel], system: str, user: str) -> str:
    raw = json.dumps([agent, schema.__name__, system, user], sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def _cache_path(key: str):
    return config.CACHE_DIR / f"{key}.json"


def _cache_load(key: str) -> dict | None:
    p = _cache_path(key)
    if not p.exists():
        return None
    data = json.loads(p.read_text(encoding="utf-8"))
    return data if "answer" in data else {"answer": data, "model": "unknown"}


def _cache_save(key: str, answer: dict, p: str, model: str) -> None:
    config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _cache_path(key).write_text(json.dumps({"provider": p, "model": model, "answer": answer}, indent=2,
                                           ensure_ascii=False), encoding="utf-8")


# --- calls ------------------------------------------------------------------------------------
def _anthropic(system: str, user: str, schema: type[T], effort: str) -> T:
    resp = _get_client().messages.parse(
        model=model_name("anthropic"),
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_format=schema,
        output_config={"effort": effort},
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("model declined the request")
    if resp.parsed_output is None:
        raise RuntimeError(f"no parsed output (stop_reason={resp.stop_reason})")
    return resp.parsed_output


def json_schema(schema: type[BaseModel]) -> dict:
    """The model's JSON schema in the strict form structured outputs expect: every object closed
    (additionalProperties false), every property required, no titles."""
    def clean(node):
        if isinstance(node, dict):
            node = {k: clean(v) for k, v in node.items() if k != "title"}
            if node.get("type") == "object" and "properties" in node:
                node["additionalProperties"] = False
                node["required"] = list(node["properties"])
            return node
        if isinstance(node, list):
            return [clean(x) for x in node]
        return node
    return clean(schema.model_json_schema())


def _strip_fences(text: str) -> str:
    m = re.search(r"\{.*\}", text, re.S)
    return m.group(0) if m else text


def _post(url: str, body: dict, headers: dict):
    import httpx
    for attempt in range(3):
        r = httpx.post(url, json=body, headers=headers, timeout=30)
        if r.status_code == 429 and attempt < 2:      # free-tier rate limit: back off and retry
            time.sleep(6 * (attempt + 1))
            continue
        return r
    return r


def _openai_compat(p: str, system: str, user: str, schema: type[T]) -> T:
    spec = OPENAI_COMPAT[p]
    headers = {"Content-Type": "application/json"}
    if spec["key_env"]:
        headers["Authorization"] = f"Bearer {os.environ[spec['key_env']]}"
    url = spec["base_url"] + "/chat/completions"
    js = json_schema(schema)
    body = {"model": model_name(p),
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": schema.__name__, "schema": js, "strict": True}}}
    r = _post(url, body, headers)
    if r.status_code == 400:
        # the model does not take a JSON schema: ask for plain JSON and spell the schema out
        body["response_format"] = {"type": "json_object"}
        body["messages"][0]["content"] = (system + "\n\nReply with only one JSON object that matches this "
                                          "JSON Schema, with no other text:\n" + json.dumps(js))
        r = _post(url, body, headers)
    if r.status_code >= 400:
        raise RuntimeError(f"{p} returned {r.status_code}: {r.text[:300]}")
    msg = r.json()["choices"][0]["message"]
    if msg.get("refusal"):
        raise RuntimeError("model declined the request")
    return schema.model_validate_json(_strip_fences(msg.get("content") or ""))


def call_structured(agent: str, system: str, user: str, schema: type[T],
                    effort: str = "low") -> tuple[T, str, str]:
    mode = config.LLM_MODE
    if mode == "off":
        raise LLMUnavailable("LLM disabled")
    key = cache_key(agent, schema, system, user)
    p = provider()
    if not (mode == "auto" and usable(p)):
        hit = _cache_load(key)
        if hit is not None:
            return schema.model_validate(hit["answer"]), "cache", hit.get("model", "unknown")
        raise LLMUnavailable("no usable LLM provider and no cached response")
    try:
        if p == "anthropic":
            out = _anthropic(system, user, schema, effort)
        elif p in OPENAI_COMPAT:
            out = _openai_compat(p, system, user, schema)
        else:
            raise RuntimeError(f"unknown provider {p!r}")
        _cache_save(key, out.model_dump(), p, model_name(p))
        return out, "llm", model_name(p)
    except Exception as e:  # network, rate limit, refusal, schema mismatch
        hit = _cache_load(key)
        if hit is not None:
            return schema.model_validate(hit["answer"]), "cache-fallback", hit.get("model", "unknown")
        raise LLMUnavailable(f"{type(e).__name__}: {e}") from e
