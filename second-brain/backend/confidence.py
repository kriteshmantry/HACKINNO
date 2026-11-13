"""Amount normalisation, rule-based extraction and the composite confidence score.

The LLM's own confidence is logged but never trusted on its own: the score is built from
observable signals so it can be explained (and defended) line by line.
"""
from __future__ import annotations

import re

from . import config

_AMT = re.compile(
    r"(?P<cur>₹|\brs\.?|\binr)?\s*"
    r"(?P<num>\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
    r"\s*(?P<suf>lakhs?\b|lacs?\b|l\b|k\b|crores?\b|cr\b)?(?:/-)?",
    re.IGNORECASE)
_MULT = {"l": 1e5, "lakh": 1e5, "lakhs": 1e5, "lac": 1e5, "lacs": 1e5, "k": 1e3,
         "cr": 1e7, "crore": 1e7, "crores": 1e7}

HEDGES = re.compile(r"\b(around|approx\w*|roughly|tentative\w*|subject to|maybe|probably|might|"
                    r"likely|not final|tbc|to be confirmed)\b", re.IGNORECASE)


def find_amounts(text: str) -> list[tuple[int, int, int]]:
    """All money amounts in the text as (value, start, end). A bare number only counts
    when it carries a currency marker, a lakh/k/crore suffix, or Indian comma grouping."""
    out = []
    for m in _AMT.finditer(text):
        cur, num, suf = m.group("cur"), m.group("num"), m.group("suf")
        if not (cur or suf or "," in num):
            continue
        value = float(num.replace(",", ""))
        if suf:
            value *= _MULT[suf.lower()]
        out.append((int(round(value)), m.start(), m.end()))
    return out


def normalize_amount(text: str) -> int | None:
    found = find_amounts(text)
    return found[0][0] if found else None


def rule_extract(text: str) -> tuple[int | None, int | None, str]:
    """Pick (new, old, evidence_span) using phrase patterns. Fallback when no LLM is available."""
    amts = find_amounts(text)
    if not amts:
        return None, None, ""
    low = text.lower()
    for i, (val, s, e) in enumerate(amts):
        tail = low[e:e + 40]
        if i + 1 < len(amts) and re.match(r"\s*(instead of|rather than|down from|up from|in place of)", tail):
            nxt = amts[i + 1]
            return val, nxt[0], text[_sentence_start(text, s):nxt[2]].strip()
    m = re.search(r"from\s*$", low[:amts[0][1]])
    if len(amts) >= 2 and m:
        return amts[1][0], amts[0][0], text[_sentence_start(text, amts[0][1]):amts[1][2]].strip()
    val, s, e = amts[-1] if re.search(r"\bto\s*$", low[:amts[-1][1]]) else amts[0]
    return val, None, text[_sentence_start(text, s):_sentence_end(text, e)].strip()


def _sentence_start(text: str, idx: int) -> int:
    cut = max(text.rfind(". ", 0, idx), text.rfind(", ", 0, max(idx - 60, 0)), text.rfind(": ", 0, idx))
    return cut + 2 if cut >= 0 else 0


def _sentence_end(text: str, idx: int) -> int:
    nxt = text.find(".", idx)
    return nxt if nxt >= 0 else len(text)


def hedges_in(text: str) -> list[str]:
    seen = []
    for m in HEDGES.finditer(text):
        h = m.group(0).lower()
        if h not in seen:
            seen.append(h)
    return seen


def score(*, new_amount: int, text: str, resolution_method: str, sender_role: str | None,
          internal_relay: bool, corroborated: bool) -> tuple[float, list[str]]:
    s, why = 0.5, ["0.50 base"]
    if sender_role in ("CFO", "POC") and resolution_method in ("person", "domain", "alias"):
        s += 0.25
        why.append(f"+0.25 authoritative sender ({sender_role})")
    elif internal_relay:
        s += 0.10
        why.append("+0.10 relayed by an internal team member")
    regex_amounts = [a for a, _, _ in find_amounts(text)]
    if new_amount in regex_amounts:
        s += 0.15
        why.append("+0.15 amount found verbatim in the text")
    elif regex_amounts:
        s -= 0.30
        why.append("-0.30 extracted amount disagrees with the text")
    if corroborated:
        s += 0.10
        why.append("+0.10 corroborated by another source")
    for h in hedges_in(text):
        s -= 0.20
        why.append(f"-0.20 hedge: '{h}'")
    if resolution_method == "fuzzy":
        s -= 0.10
        why.append("-0.10 sponsor matched only fuzzily")
    s = round(max(0.0, min(1.0, s)), 2)
    return s, why


def band(conf: float) -> str:
    if conf >= config.BAND_AUTONOMOUS:
        return "autonomous"
    if conf >= config.BAND_SUPERVISED:
        return "supervised"
    return "clarify"
