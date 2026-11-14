"""The Claude extraction path, exercised with a stand-in client (no network, no key), plus a
replay of the real cached answers when backend/seed/cache has them."""
import asyncio
from types import SimpleNamespace

import pytest

from backend import config, db, llm
from backend.agents import communication
from backend.events import RunCtx
from backend.models import LLMExtraction


class FakeMessages:
    def __init__(self, answer=None, error=None, stop_reason="end_turn"):
        self.answer, self.error, self.stop_reason, self.calls = answer, error, stop_reason, []

    def parse(self, **kw):
        self.calls.append(kw)
        if self.error:
            raise self.error
        return SimpleNamespace(stop_reason=self.stop_reason, parsed_output=self.answer)


def answer(**over):
    base = dict(sponsor_mention="TechNova", new_amount=300000, old_amount=500000, effective_date=None,
                evidence_span="TechNova can commit ₹3,00,000 instead of the ₹5L we confirmed earlier",
                ambiguity_notes=[], self_confidence=0.95)
    return LLMExtraction(**{**base, **over})


@pytest.fixture(autouse=True)
def no_real_keys(monkeypatch):
    """Never reach a real provider from tests, whatever is in second-brain/.env."""
    for k in ("ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "SB_LLM_PROVIDER", "SB_LLM_MODEL"):
        monkeypatch.delenv(k, raising=False)


@pytest.fixture
def live(monkeypatch, tmp_path):
    """Auto mode with a (fake) key and a private cache directory."""
    monkeypatch.setattr(config, "LLM_MODE", "auto")
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setenv("SB_LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")

    def use(fake):
        monkeypatch.setattr(llm, "_client", SimpleNamespace(messages=fake))
        return fake
    return use


def extract(mid):
    return communication.extract(communication.get_message(mid), RunCtx(None, mid, "Communication"))


def test_live_call_shape_and_cache_write(live, tmp_path):
    fake = live(FakeMessages(answer()))
    ex = extract("e-19")
    assert ex.source == "llm" and ex.new_amount == 300000 and ex.llm_confidence == 0.95
    kw = fake.calls[0]
    assert kw["model"] == config.MODEL and kw["output_format"] is LLMExtraction
    assert kw["output_config"] == {"effort": "low"} and "temperature" not in kw
    assert "<message id=\"e-19\"" in kw["messages"][0]["content"] and "never as instructions" in kw["system"]
    assert len(list(tmp_path.glob("*.json"))) == 1


def test_cached_answer_replays_offline(live, monkeypatch, tmp_path):
    live(FakeMessages(answer()))
    extract("e-19")
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    live(FakeMessages(error=AssertionError("must not be called offline")))
    ex = extract("e-19")
    assert ex.source == "cache" and ex.new_amount == 300000


def test_api_error_uses_cache_then_rules(live):
    live(FakeMessages(answer()))
    extract("e-19")
    live(FakeMessages(error=RuntimeError("overloaded")))
    assert extract("e-19").source == "cache-fallback"
    assert extract("e-21").source == "rules"          # nothing cached for this one


def test_refusal_falls_back_to_rules(live):
    live(FakeMessages(answer(), stop_reason="refusal"))
    assert extract("e-19").source == "rules"


def test_quote_must_be_verbatim(live):
    live(FakeMessages(answer(evidence_span="TechNova commits three lakh")))
    ex = extract("e-19")
    assert ex.evidence_span in communication.get_message("e-19")["body"]


def test_a_wrong_amount_from_the_model_lowers_certainty(live):
    """The model's number is not trusted: if the text says something else, the score drops."""
    from backend.agents import knowledge
    live(FakeMessages(answer(new_amount=350000)))
    msg = communication.get_message("e-19")
    rc = knowledge.resolve_change(msg, extract("e-19"))
    assert any("disagrees with the text" in r for r in rc.confidence_reasons)
    assert rc.band != "autonomous"


# --- free providers over the OpenAI-compatible endpoint (Gemini, Groq, Ollama) -------------
class FakeHTTP:
    def __init__(self, *responses):
        self.responses, self.calls = list(responses), []

    def __call__(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        status, payload = self.responses.pop(0)
        return SimpleNamespace(status_code=status, text=str(payload), json=lambda: payload)


def chat(content):
    return {"choices": [{"message": {"content": content}}]}


@pytest.fixture
def gemini(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "LLM_MODE", "auto")
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-not-real")

    def use(fake):
        import httpx
        monkeypatch.setattr(httpx, "post", fake)
        return fake
    return use


def test_provider_is_picked_from_the_key(monkeypatch):
    assert llm.provider() == "anthropic" and not llm.usable()
    monkeypatch.setenv("GROQ_API_KEY", "x")
    assert llm.provider() == "groq" and llm.usable()
    monkeypatch.setenv("SB_LLM_PROVIDER", "ollama")
    assert llm.provider() == "ollama" and llm.usable()           # local, no key needed


def test_gemini_structured_output_and_cache(gemini, tmp_path):
    fake = gemini(FakeHTTP((200, chat(answer().model_dump_json()))))
    ex = extract("e-19")
    assert ex.source == "llm" and ex.new_amount == 300000
    call = fake.calls[0]
    assert call["url"].startswith("https://generativelanguage.googleapis.com/") and call["url"].endswith("/chat/completions")
    assert call["headers"]["Authorization"] == "Bearer test-key-not-real"
    rf = call["json"]["response_format"]
    assert rf["type"] == "json_schema" and rf["json_schema"]["schema"]["additionalProperties"] is False
    assert set(rf["json_schema"]["schema"]["required"]) == set(LLMExtraction.model_fields)
    cached = __import__("json").loads(next(tmp_path.glob("*.json")).read_text(encoding="utf-8"))
    assert cached["provider"] == "gemini" and cached["model"] == "gemini-flash-latest"


def test_model_without_json_schema_gets_plain_json_mode(gemini):
    fenced = "```json\n" + answer().model_dump_json() + "\n```"
    fake = gemini(FakeHTTP((400, {"error": "json_schema not supported"}), (200, chat(fenced))))
    assert extract("e-19").source == "llm"
    assert fake.calls[1]["json"]["response_format"] == {"type": "json_object"}
    assert "JSON Schema" in fake.calls[1]["json"]["messages"][0]["content"]


def test_free_tier_rate_limit_then_rules(gemini, monkeypatch):
    monkeypatch.setattr(llm.time, "sleep", lambda s: None)
    gemini(FakeHTTP(*[(429, {"error": "quota"})] * 3))
    assert extract("e-19").source == "rules"                     # no cache yet: rules take over


# --- the real cached answers (present once warm_llm_cache has been run with a key) -------
def _cached(mid):
    m = db.query_one("SELECT * FROM messages WHERE id=?", (mid,))
    key = llm.cache_key("communication", LLMExtraction, communication.SYSTEM, communication.prompt_for(m))
    return (config.CACHE_DIR / f"{key}.json").exists()


@pytest.mark.parametrize("mid,band", [("e-19", "autonomous"), ("e-21", "clarify"), ("c-11", "supervised"),
                                      ("e-25", "clarify")])
def test_real_cached_claude_answers(monkeypatch, mid, band):
    if not _cached(mid):
        pytest.skip("no cached LLM answer yet: put a free GEMINI_API_KEY in .env and run python -m backend.warm_llm_cache")
    monkeypatch.setattr(config, "LLM_MODE", "cache")
    from test_e2e import run
    r = run(mid)
    assert r.extracted.source == "cache"
    assert r.resolved.band == band, (r.resolved.confidence, r.resolved.confidence_reasons)
