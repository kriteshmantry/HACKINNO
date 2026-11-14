"""Tier-boundary negotiation: turn a sponsor cut into a counter-offer.

"TechNova is ₹1,00,000 short of staying Gold." Everything here is computed from workspace data:
tier floors and entitlements (config.TIERS / ENTITLEMENTS), add-on prices set by the sponsorship
lead (config.ADDON_PRICES), the sponsor's deliverable deadlines (what can still be saved before
print), and the amount they committed before. The agent only drafts; a person sends.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta

from . import config, db, outreach

TIER_ORDER = ["None", "Bronze", "Silver", "Gold"]
FLOORS = dict(config.TIERS)
SIZE = {"L": "large", "M": "medium", "S": "small"}


def inr(n: int) -> str:
    s = str(abs(int(n)))
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        s = ",".join(parts) + "," + tail
    return ("-₹" if n < 0 else "₹") + s


def _fmt(d: str) -> str:
    x = date.fromisoformat(d[:10])
    return f"{x:%b} {x.day}"


def benefit_label(kind: str, spec: str | None) -> str:
    if kind == "keynote":
        return f"the {str(spec).replace(' min', '-minute')} keynote"
    if kind == "banner_logo":
        return f"the {SIZE.get(spec, spec)} main-banner logo ({spec})"
    if kind == "social_posts":
        return f"{spec} social posts"
    return f"{kind} {spec}"


def _today() -> date:
    return datetime.fromisoformat(config.SCENARIO_NOW).date()


def previous_amount(sponsor_id: str) -> int | None:
    """The commitment before the current one, from versioned memory."""
    hist = db.query("SELECT value FROM facts WHERE entity=? AND predicate='committed_amount' ORDER BY valid_from",
                    (sponsor_id,))
    return int(hist[-2]["value"]) if len(hist) >= 2 else None


def regained(target: str, current: str, sponsor_id: str) -> list[dict]:
    """What the sponsor gets back by moving from `current` up to `target`, with deadlines."""
    want, have = config.ENTITLEMENTS[target], config.ENTITLEMENTS[current]
    dels = {d["kind"]: d for d in db.query("SELECT * FROM deliverables WHERE sponsor_id=?", (sponsor_id,))}
    out = []
    for kind, spec in want.items():
        if spec is None or spec == have.get(kind):
            continue
        d = dels.get(kind)
        deadline = d["deadline"] if d else None
        days = (date.fromisoformat(deadline) - _today()).days if deadline else None
        if have.get(kind) is None:
            change = benefit_label(kind, spec)
        elif kind == "banner_logo":
            change = f"a {SIZE.get(spec, spec)} banner logo instead of {SIZE.get(have[kind], have[kind])}"
        else:
            change = f"{spec} {kind.replace('_', ' ')} instead of {have[kind]}"
        loss = (f"no {kind.replace('_', ' ')}" if have.get(kind) is None else
                f"a {SIZE.get(have[kind], have[kind])} banner logo instead of {SIZE.get(spec, spec)}" if kind == "banner_logo"
                else f"{have[kind]} {kind.replace('_', ' ')} instead of {spec}")
        ev = db.query_one("SELECT * FROM calendar_events WHERE linked_entity=?", (d["id"],)) if d else None
        out.append({"kind": kind, "spec": spec, "instead_of": have.get(kind), "label": benefit_label(kind, spec),
                    "change": change, "loss": loss, "event": ev["title"] if ev else None,
                    "price": config.ADDON_PRICES.get(kind), "deadline": deadline, "days_left": days,
                    "still_possible": days is None or days >= 1})
    return out


def analyze(sponsor_id: str, new_amount: int | None = None, old_amount: int | None = None) -> dict | None:
    sp = db.query_one("SELECT * FROM sponsors WHERE id=?", (sponsor_id,))
    if sp is None:
        return None
    new = sp["committed_amount"] if new_amount is None else new_amount
    cur_tier = config.tier_for(new)
    idx = TIER_ORDER.index(cur_tier)
    name = sp["name"].split()[0]
    base = {"sponsor_id": sponsor_id, "sponsor": name, "amount": new, "tier": cur_tier, "contact": sp["contact"]}
    if idx == len(TIER_ORDER) - 1:
        return {**base, "eligible": False, "reason": f"{name} is already at the top tier", "offers": []}
    prev = old_amount if old_amount is not None else previous_amount(sponsor_id)
    prev_tier = config.tier_for(prev) if prev else None
    target = TIER_ORDER[idx + 1]
    topup = FLOORS[target] - new
    dropped = bool(prev_tier and TIER_ORDER.index(prev_tier) > idx)
    near = topup <= config.NEGOTIATION_MAX_TOPUP_SHARE * new
    gains = regained(target, cur_tier, sponsor_id)
    headline = (f"{name} is {inr(topup)} short of {'staying' if dropped and prev_tier == target else 'reaching'} "
                f"{target}")
    if not (dropped or near):
        return {**base, "eligible": False, "headline": headline, "target_tier": target, "topup": topup,
                "reason": f"The top-up ({inr(topup)}) is more than {config.NEGOTIATION_MAX_TOPUP_SHARE:.0%} of the "
                          f"current amount, so a counter-offer is unlikely to land", "offers": []}

    saveable = [g for g in gains if g["still_possible"]]
    offers = [{"id": "restore", "title": f"{'Stay' if dropped and prev_tier == target else 'Move up to'} {target}",
               "add": topup, "total": FLOORS[target], "tier": target, "gets": [g["label"] for g in saveable],
               "lost_anyway": [g["label"] for g in gains if not g["still_possible"]]}]
    priced = sorted((g for g in saveable if g["price"] and g["price"] < topup), key=lambda g: -g["price"])
    if priced:
        g = priced[0]
        offers.append({"id": "addon", "title": f"{cur_tier} plus {g['label']}", "add": g["price"],
                       "total": new + g["price"], "tier": cur_tier, "gets": [g["label"]], "lost_anyway": []})
    offers.append({"id": "accept", "title": f"Accept {inr(new)} at {cur_tier}", "add": 0, "total": new,
                   "tier": cur_tier, "gets": [], "lost_anyway": [g["label"] for g in gains]})

    cut = (prev - new) if prev and prev > new else 0
    deadlines = sorted((g for g in saveable if g["deadline"]), key=lambda g: g["deadline"])
    reply_by = None
    if deadlines:
        first = date.fromisoformat(deadlines[0]["deadline"]) - timedelta(days=1)
        reply_by = max(first, _today()).isoformat()
    analysis = {
        **base, "eligible": True, "headline": headline, "previous_amount": prev, "previous_tier": prev_tier,
        "dropped": dropped, "target_tier": target, "topup": topup, "benefits": gains, "offers": offers,
        "reply_by": reply_by, "deadline_reason": (
            (f"The {deadlines[0]['event'].lower()} is on {_fmt(deadlines[0]['deadline'])}" if deadlines[0]["event"]
             else f"{deadlines[0]['label'][0].upper()}{deadlines[0]['label'][1:]} is due on "
                  f"{_fmt(deadlines[0]['deadline'])}") if deadlines else None),
        "budget_effect": ({"cut": cut, "restore_covers": min(topup, cut),
                           "text": f"Accepting the {target} offer funds back {inr(min(topup, cut))} of the "
                                   f"{inr(cut)} that this cut took out of the budget"} if cut else None),
    }
    analysis["draft"] = draft_email(analysis)
    return analysis


def draft_email(a: dict) -> dict:
    first = (db.query_one("SELECT sender_name FROM messages WHERE lower(sender)=? AND sender_name IS NOT NULL",
                          ((a["contact"] or "").lower(),)) or {}).get("sender_name") or "there"
    first = first.split()[0]
    me = db.query_one("SELECT name, role FROM people WHERE id='p-sponsorship'")
    losses = [b["loss"] for b in a["benefits"]]
    by_label = {b["label"]: b for b in a["benefits"]}
    lines = [f"Hi {first},", "",
             f"Thank you for confirming {inr(a['amount'])} for Innovision 2026."
             + (f" At that amount {a['sponsor']} moves from {a['previous_tier']} to {a['tier']}, which means "
                f"{_join(losses)}." if a["dropped"] else ""), "",
             "Two ways to keep what matters most to you:" if len(a["offers"]) > 2 else "One way to keep these benefits:"]
    n = 0
    for o in a["offers"]:
        if o["id"] == "accept":
            continue
        n += 1
        gets = _join([by_label[g]["change"] if g in by_label else g for g in o["gets"]])
        what = (f"to {'stay' if a['dropped'] and a['previous_tier'] == o['tier'] else 'move up to'} {o['tier']}: {gets}"
                if o["id"] == "restore" else f"to add {gets} to {o['tier']}")
        lines.append(f"{n}. Add {inr(o['add'])} ({inr(o['total'])} in total) {what}.")
    if a.get("reply_by") and a.get("deadline_reason"):
        today = a["reply_by"] == _today().isoformat()
        lines += ["", f"{a['deadline_reason']}, so a reply by {_fmt(a['reply_by'])}{' (today)' if today else ''} "
                      f"lets us include it."]
    lines += ["", "If neither works, we are glad to go ahead at the new amount.", "", "Best regards,",
              f"{me['name']}" if me else "Innovision 2026 team",
              f"{me['role']}, Innovision 2026" if me else ""]
    return {"to": a["contact"], "cc": [], "subject": f"Keeping {a['sponsor']} at {a['target_tier']} for Innovision 2026",
            "body": "\n".join(lines).rstrip()}


def _join(items: list[str]) -> str:
    if not items:
        return "nothing"
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


# --- records ------------------------------------------------------------------------------------
def latest(sponsor_id: str) -> dict | None:
    return db.query_one("SELECT * FROM negotiations WHERE sponsor_id=? ORDER BY created_at DESC LIMIT 1", (sponsor_id,))


async def send(sponsor_id: str, *, subject: str | None = None, body: str | None = None, run_id: str | None = None,
               by: str = "demo-user") -> dict:
    a = analyze(sponsor_id)
    if not a or not a.get("eligible"):
        raise ValueError((a or {}).get("reason", "no counter-offer applies"))
    open_ = latest(sponsor_id)
    if open_ and open_["status"] == "sent":
        raise ValueError("a counter-offer is already waiting for a reply")
    d = {**a["draft"], **({"subject": subject} if subject else {}), **({"body": body} if body else {})}
    sent = await outreach.send_approved(
        run_id=run_id, change_id=f"negotiation:{sponsor_id}:{a['amount']}", key="negotiation.counter_offer",
        to=d["to"], cc=d.get("cc", []), subject=d["subject"], body=d["body"],
        rationale=a["headline"] + ": counter-offer drafted from tier rules and add-on prices", evidence=[], by=by)
    nid = f"n-{uuid.uuid4().hex[:6]}"
    with db.tx() as conn:
        conn.execute("INSERT INTO negotiations (id, sponsor_id, run_id, status, analysis, draft, outbox_id, created_at) "
                     "VALUES (?,?,?,?,?,?,?,?)",
                     (nid, sponsor_id, run_id, "sent", json.dumps(a), json.dumps(d),
                      sent["outbox"]["id"] if sent["outbox"] else None, datetime.now().isoformat()))
    return db.query_one("SELECT * FROM negotiations WHERE id=?", (nid,))


def sponsor_reply(neg_id: str, choice: str) -> tuple[dict, dict]:
    """Demo: the sponsor answers the counter-offer. Returns (negotiation, reply message)."""
    n = db.query_one("SELECT * FROM negotiations WHERE id=?", (neg_id,))
    if n is None:
        raise KeyError(neg_id)
    if n["status"] != "sent":
        raise ValueError(f"negotiation {neg_id} is already {n['status']}")
    a = n["analysis"]
    offer = next((o for o in a["offers"] if o["id"] == choice), None)
    if choice not in ("restore", "decline") or (choice == "restore" and offer is None):
        raise ValueError("choice must be restore | decline")
    contact = a["contact"]
    name = (db.query_one("SELECT sender_name FROM messages WHERE lower(sender)=? AND sender_name IS NOT NULL",
                         (contact.lower(),)) or {}).get("sender_name") or contact
    sp = db.query_one("SELECT name FROM sponsors WHERE id=?", (n["sponsor_id"],))["name"]
    if choice == "restore":
        body = (f"Hi Priya, thanks for the options. {sp} will increase its commitment to {inr(offer['total'])} "
                f"to stay {offer['tier']}. Regards, {name.split()[0]}")
    else:
        body = f"Hi Priya, thanks, but we will stay at {inr(a['amount'])} this year. Regards, {name.split()[0]}"
    reply = outreach.inject_message(sender=contact, sender_name=name, subject=f"Re: {n['draft']['subject']}",
                                    body=body)
    status = "accepted" if choice == "restore" else "declined"
    db.execute("UPDATE negotiations SET status=?, reply_message_id=?, outcome=?, decided_at=? WHERE id=?",
               (status, reply["id"], choice, datetime.now().isoformat(), neg_id))
    return db.query_one("SELECT * FROM negotiations WHERE id=?", (neg_id,)), reply


def set_reply_run(neg_id: str, run_id: str) -> None:
    db.execute("UPDATE negotiations SET reply_run_id=? WHERE id=?", (run_id, neg_id))
