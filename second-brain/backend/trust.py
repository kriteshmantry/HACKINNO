"""Email Trust Score.

Every message gets two scores built from observable signals, never from the model's opinion:

  trust     is the sender who they claim to be?   (identity, lookalike domain, reply-to, history,
                                                    pressure, sensitive requests, track record)
  certainty is the change itself clear and final?  (confidence.score: authority, verbatim amount,
                                                    hedges, corroboration, size of the change)

The gate is the weaker of the two. A precise email from an impostor and a hedged email from the
real CFO both stop for a person, but for different reasons, and the person is told which.
Human verdicts feed back into a per-sender track record, so the score learns.
"""
from __future__ import annotations

import re
from datetime import datetime

from rapidfuzz import fuzz

from . import confidence, config, db
from .agents.communication import INJECTION
from .knowledge import memory
from .knowledge.resolve import resolve, sender_info, sponsor_mentions
from .models import TrustReport, TrustSignal

_HOMOGLYPHS = str.maketrans({"0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "$": "s", "@": "a"})
PRESSURE = re.compile(r"\b(urgent\w*|immediately|asap|right away|today|within the hour|final notice|act now)\b", re.I)
SENSITIVE = re.compile(
    r"((send|share|email|forward|provide|update|change|confirm)\b[^.]{0,40}\b(bank|account number|ifsc|"
    r"password|credentials|otp)|new (bank )?account|gift cards?|wire transfer)", re.I)
SECRECY = re.compile(r"(reply (only )?to this (address|email)|do not (contact|call|cc|copy)|"
                     r"keep this (confidential|between us)|only (reply|write) (to|on) this)", re.I)


# --- runtime policy -----------------------------------------------------------------------
def thresholds() -> dict[str, float]:
    rows = {r["key"]: float(r["value"]) for r in db.query("SELECT * FROM settings")}
    return {"autonomous": rows.get("band_autonomous", config.BAND_AUTONOMOUS),
            "supervised": rows.get("band_supervised", config.BAND_SUPERVISED)}


def set_thresholds(autonomous: float, supervised: float) -> dict[str, float]:
    if not 0 < supervised < autonomous <= 1:
        raise ValueError("need 0 < supervised < autonomous <= 1")
    with db.tx() as conn:
        conn.execute("INSERT OR REPLACE INTO settings VALUES ('band_autonomous', ?)", (str(autonomous),))
        conn.execute("INSERT OR REPLACE INTO settings VALUES ('band_supervised', ?)", (str(supervised),))
    return thresholds()


# --- track record ---------------------------------------------------------------------------
def reputation(sender: str) -> dict | None:
    r = db.query_one("SELECT * FROM sender_reputation WHERE sender=?", (sender.lower(),))
    if not r:
        return None
    genuine = r["confirmed"] + r["corrected"]
    total = genuine + r["rejected"]
    return {**r, "genuine": genuine, "total": total, "reliability": round((genuine + 1) / (total + 2), 2)}


def all_reputations() -> list[dict]:
    return [reputation(r["sender"]) for r in db.query("SELECT sender FROM sender_reputation ORDER BY updated_at DESC")]


def record_verdict(sender: str, kind: str) -> None:
    """kind: confirmed (genuine, read right) | corrected (genuine, amount fixed) | rejected (not genuine)."""
    if kind not in ("confirmed", "corrected", "rejected"):
        raise ValueError(kind)
    with db.tx() as conn:
        conn.execute("INSERT OR IGNORE INTO sender_reputation (sender, updated_at) VALUES (?, ?)",
                     (sender.lower(), datetime.now().isoformat()))
        conn.execute(f"UPDATE sender_reputation SET {kind} = {kind} + 1, updated_at=? WHERE sender=?",
                     (datetime.now().isoformat(), sender.lower()))


# --- sender signals ---------------------------------------------------------------------------
def _norm(label: str) -> str:
    s = label.lower().translate(_HOMOGLYPHS).replace("rn", "m").replace("vv", "w")
    return re.sub(r"[^a-z]", "", s)


def _trusted_domains() -> list[str]:
    doms = [r["domain"] for r in db.query("SELECT domain FROM sponsors WHERE domain IS NOT NULL")]
    return sorted(set(doms + [config.INTERNAL_DOMAIN]))


def lookalike(domain: str | None) -> str | None:
    """The trusted domain this one imitates (techn0va-billing.com -> technova.io), or None."""
    if not domain:
        return None
    domain = domain.lower()
    trusted = _trusted_domains()
    if domain in trusted or any(domain.endswith("." + t) for t in trusted):
        return None
    labels = domain.split(".")[:-1] or [domain]
    parts = {p for lab in labels for p in re.split(r"[-_]", lab) if p} | {"".join(labels)}
    for t in trusted:
        base = _norm(t.split(".")[0])
        for p in parts:
            n = _norm(p)
            if len(n) >= 4 and (n == base or fuzz.ratio(n, base) >= 85):
                return t
    return None


def _sponsor_name(sid: str | None) -> str:
    row = db.query_one("SELECT name FROM sponsors WHERE id=?", (sid,)) if sid else None
    return row["name"].split()[0] if row else "the sponsor"


def sender_trust(msg: dict) -> tuple[float, list[TrustSignal]]:
    sender = (msg["sender"] or "").lower()
    info = sender_info(sender)
    domain = sender.split("@")[-1] if "@" in sender else None
    out: list[TrustSignal] = []

    def add(signal: str, delta: float, detail: str) -> None:
        out.append(TrustSignal(signal=signal, delta=round(delta, 2), detail=detail))

    method = info["method"]
    if method == "person":
        add("known_contact", 0.35, f"Sender is {_sponsor_name(info['entity_id'])}'s contact on file ({info['role']})")
    elif method == "domain":
        add("sponsor_domain", 0.20, f"Sender domain {domain} belongs to {_sponsor_name(info['entity_id'])}")
    elif method == "internal":
        person = db.query_one("SELECT * FROM people WHERE id=? OR email=?", (sender, sender))
        if person:
            add("team_member", 0.30, f"Internal team member ({person['name']}, {person['role']})")
        else:
            add("internal_domain", 0.15, f"Internal {config.INTERNAL_DOMAIN} address, not on the team list")
    else:
        add("unknown_sender", 0.0, f"Not a known contact or sponsor domain ({domain or sender})")

    look = lookalike(domain)
    if look:
        add("lookalike_domain", -0.45, f"{domain} imitates {look}")
    elif domain in config.FREE_MAIL and method not in ("person", "internal"):
        add("free_mail", -0.10, f"Webmail address ({domain}) on a sponsor matter")

    reply_to = (msg.get("reply_to") or "").lower()
    if reply_to and reply_to != sender:
        rd = reply_to.split("@")[-1]
        add("reply_to_mismatch", -0.25, f"Replies would go to {reply_to}, not the sender"
            + (" (a webmail address)" if rd in config.FREE_MAIL else ""))

    earlier = db.query_one("SELECT COUNT(*) n FROM messages WHERE lower(sender)=? AND received_at < ? AND id != ?",
                           (sender, msg["received_at"], msg["id"]))["n"]
    if earlier and method in ("person", "domain", "internal"):
        add("history", 0.05, f"{earlier} earlier message{'s' if earlier > 1 else ''} from this sender on record")
    elif not earlier and method in ("unknown", "domain"):
        add("first_contact", -0.10, "First message ever from this sender")

    text = f"{msg.get('subject') or ''}\n{msg['body']}"
    if INJECTION.search(text):
        add("instructions", -0.40, "Contains instructions aimed at the system")
    sens = sorted({m.group(0).strip().lower() for m in SENSITIVE.finditer(text)})
    if sens:
        add("sensitive_request", -0.30, f"Asks about money movement or secrets: {', '.join(sens)}")
    pres = sorted({m.group(0).lower() for m in PRESSURE.finditer(text)})
    if pres:
        add("pressure", -0.10, f"Pressure wording: {', '.join(pres)}")
    if SECRECY.search(text):
        add("secrecy", -0.15, "Asks to keep the reply away from the usual contacts")

    rep = reputation(sender)
    if rep and rep["total"]:
        d = round((rep["reliability"] - 0.5) * 0.4, 2)
        if d:
            add("track_record", d, f"Past human verdicts on this sender: {rep['genuine']} genuine, "
                                   f"{rep['rejected']} not genuine")

    score = round(max(0.0, min(1.0, 0.5 + sum(s.delta for s in out))), 2)
    return score, out


# --- the full report (inbox badges) -----------------------------------------------------------
def route_for(band: str, trust: float, triage_label: str | None = None, contact: str | None = None) -> str:
    if triage_label == "suspicious":
        return "Quarantined: never reaches the planner"
    if triage_label == "noise":
        return "Not a sponsor change: ignored"
    if band == "autonomous":
        return "Acts on its own (risky steps still need approval)"
    if band == "supervised":
        return "Acts only with your approval on every change"
    if trust < config.TRUST_LOW:
        return f"Held for verification with {contact or 'the contact on file'}"
    return "Held until a person confirms the amount"


def assess(msg: dict, triage_label: str | None = None) -> TrustReport:
    """Rule-based report for one message, usable before any run starts (the inbox badge)."""
    t, tsig = sender_trust(msg)
    mentions = sponsor_mentions(msg["body"])
    sid, _, method = resolve(mentions[0][0] if mentions else "", msg["sender"])
    new, _, _ = confidence.rule_extract(msg["body"])
    certainty, csig, contact = None, [], None
    if sid:
        sp = db.query_one("SELECT * FROM sponsors WHERE id=?", (sid,))
        contact = sp["contact"]
        if new:
            info = sender_info(msg["sender"])
            certainty, csig = confidence.score(
                new_amount=new, text=msg["body"], resolution_method=method,
                sender_role=info["role"] if not info["internal"] else None, internal_relay=info["internal"],
                corroborated=bool(memory.corroborated(sid, new, msg["id"])), old_amount=sp["committed_amount"])
    overall = min(t, certainty) if certainty is not None else t
    band = confidence.band(overall, **thresholds())
    return TrustReport(message_id=msg["id"], sender=msg["sender"], sponsor_id=sid, trust=t, trust_signals=tsig,
                       certainty=certainty, certainty_signals=csig, overall=round(overall, 2), band=band,
                       route=route_for(band, t, triage_label, contact), known_contact=contact, claimed_amount=new)


def calibration() -> dict:
    """How often people agreed a message was genuine, per score bucket. Built only from real verdicts."""
    rows = db.query("SELECT overall, status FROM verifications WHERE status IN ('confirmed','corrected','rejected')")
    bins = [(0.0, 0.25), (0.25, 0.5), (0.5, 0.8), (0.8, 1.01)]
    out = []
    for lo, hi in bins:
        inb = [r for r in rows if lo <= (r["overall"] or 0) < hi]
        genuine = sum(r["status"] != "rejected" for r in inb)
        out.append({"range": [lo, min(hi, 1.0)], "n": len(inb),
                    "genuine_rate": round(genuine / len(inb), 2) if inb else None})
    return {"n": len(rows), "bins": out,
            "note": "Only messages a person verified are counted; auto-processed messages have no label."}
