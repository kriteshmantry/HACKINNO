"""Deterministic planner for `sponsor_amount_change`.

Plan = diff(current workspace state, target state). Because it diffs against the *current*
DB, a replan after partial execution (or a newer message) contains only what is left to do.
This is the offline fallback and the reference the LLM planner is validated against.
"""
from __future__ import annotations

from datetime import datetime

from .. import config, db
from ..models import Option, PlannedAction, ResolvedChange
from ..tools.registry import idem_key

DEGRADED = {"budget.set_lines"}


def _inr(n: int) -> str:
    s = str(abs(n))
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


def target_gap(gap_now: int, option: Option | None, budget_rejected: bool) -> int:
    """The open gap to record: what the chosen option leaves uncovered, or everything when
    there is no option (or the human rejected the budget change)."""
    if option is not None and not budget_rejected:
        return option.open_gap
    return max(0, gap_now)


# Declarative "set X, expecting Y" writes. Re-applying one is safe when the live value has
# drifted from the target, which is how a verification failure gets repaired in the same run.
REPAIRABLE = {"tracker.set_committed", "tracker.set_tier", "tracker.set_gap", "budget.set_lines",
              "approvals.update", "deliverables.set", "calendar.set_status"}


def build(run_id: str, version: int, rc: ResolvedChange, option: Option | None, *,
          rejected_keys: set[str], degraded_tools: set[str], done_keys: set[str],
          repair: bool = False, gap_now: int | None = None) -> list[PlannedAction]:
    """repair=True when replanning after a failed verification: a write already applied in
    this run is planned again (under a fresh idempotency scope) if its target has drifted."""
    if gap_now is None:
        gap_now = rc.shortfall
    sid, ev = rc.sponsor_id, [rc.change_id]
    sponsor = db.query_one("SELECT * FROM sponsors WHERE id=?", (sid,))
    name = sponsor["name"].split()[0]
    actions: list[PlannedAction] = []
    n = 0

    def add(key: str, tool: str, args: dict, rationale: str, deps: list[str] | None = None,
            money: int | None = None, extra_ev: list[str] | None = None) -> str | None:
        nonlocal n
        if key in rejected_keys:
            return None
        # cross-run convergence: identical write already applied for this change -> nothing to do
        identity = {k: v for k, v in args.items() if k != "approval_id"}
        applied = key in done_keys or bool(
            db.query_one("SELECT 1 FROM idempotency WHERE key=?", (idem_key(tool, identity, rc.change_id),)))
        scope = None
        if applied:
            # The planner only reaches this line when the live value differs from the target.
            # After a failed verification that means drift (an outside edit): apply it again.
            if not (repair and tool in REPAIRABLE):
                return None
            scope = f"repair-v{version}"
        n += 1
        aid = f"a{version}-{n}"
        live_deps = [d for d in (deps or []) if d]
        actions.append(PlannedAction(id=aid, key=key, tool=tool, args=args, depends_on=live_deps,
                                     rationale=rationale if not scope else f"Repair after an outside edit: {rationale}",
                                     evidence_refs=ev + (extra_ev or []), money_delta=money, idem_scope=scope))
        return aid

    # 1. sponsor record
    a_commit = None
    if sponsor["committed_amount"] != rc.new_amount:
        a_commit = add("sponsor.committed", "tracker.set_committed",
                       {"sponsor_id": sid, "new": rc.new_amount, "expect": sponsor["committed_amount"]},
                       f"{name} now commits {_inr(rc.new_amount)} (was {_inr(sponsor['committed_amount'])}).")
    # 2. tier
    a_tier = None
    if sponsor["tier"] != rc.new_tier:
        a_tier = add("sponsor.tier", "tracker.set_tier",
                     {"sponsor_id": sid, "new": rc.new_tier, "expect": sponsor["tier"]},
                     f"{_inr(rc.new_amount)} falls in the {rc.new_tier} band (tier rules: Gold ≥ ₹4L, "
                     f"Silver ≥ ₹2L, Bronze ≥ ₹50k).", [a_commit])

    # 3. budget lines (or the degraded path)
    budget_rejected = "budget.lines" in rejected_keys
    a_budget = None
    pending = {p["line_id"]: p["intended_amount"]
               for p in db.query("SELECT line_id, intended_amount FROM pending_updates WHERE status='pending'")}
    desired_pending: dict[str, int] = {}
    if option and not budget_rejected:
        lines = {l["id"]: l for l in db.query("SELECT * FROM budget_lines")}
        changes = [{"line_id": k, "new": v, "expect": lines[k]["amount"]}
                   for k, v in sorted(option.cuts.items()) if lines[k]["amount"] != v]
        money = -sum(c["expect"] - c["new"] for c in changes)
        desc = ", ".join(f"{lines[c['line_id']]['category']} {_inr(c['expect'])}→{_inr(c['new'])}" for c in changes)
        if changes and "budget.set_lines" in degraded_tools:
            # the pending set is replaced as a whole, so intents from an earlier change never linger
            desired_pending = {c["line_id"]: c["new"] for c in changes}
            if desired_pending != pending:
                a_budget = add("budget.pending", "tracker.flag_pending_update",
                               {"changes": changes, "note": f"Budget sheet unavailable; apply option {option.id} "
                                                            f"manually ({rc.change_id})"},
                               "Budget tool is failing; record the intended changes as pending (degraded path).",
                               [a_commit], money)
                add("comms.treasurer_pending", "comms.chat",
                    {"channel": "#finance", "body": f"@Meera budget sheet update failed after retries. Please "
                     f"apply manually: {desc}. Source: {rc.change_id}.", "approval_id": None},
                    "Hand the failed budget change to the treasurer.", [a_budget])
        elif changes:
            a_budget = add("budget.lines", "budget.set_lines", {"changes": changes},
                           f"Cover the {_inr(max(gap_now, 0))} shortfall with option {option.id} "
                           f"({option.name}): {desc}.", [a_commit], money)
    if pending and not a_budget and pending != desired_pending:
        # an earlier fallback left intents that no longer match any target: withdraw them
        a_budget = add("budget.pending_clear", "tracker.flag_pending_update",
                       {"changes": [], "note": f"Superseded by {rc.change_id}"},
                       "Withdraw budget changes left pending by an earlier fallback; they no longer apply.",
                       [a_commit])

    # 4. open gap in the tracker
    gap = target_gap(gap_now, option, budget_rejected)
    cur_gap = db.query_one("SELECT amount FROM gaps WHERE sponsor_id=?", (sid,))
    if (cur_gap["amount"] if cur_gap else 0) != gap:
        add("tracker.gap", "tracker.set_gap",
            {"sponsor_id": sid, "amount": gap, "source_ref": rc.change_id,
             "note": f"Uncovered after {name} change{f' and option {option.id}' if option else ''}"},
            f"Record the {_inr(gap)} that the chosen option does not cover." if gap else "Clear the open gap.",
            [a_commit])

    # 5. organisational approvals tied to affected budget lines
    for oa in db.query("SELECT * FROM org_approvals WHERE status IN ('pending','approved','on_hold')"):
        line = db.query_one("SELECT * FROM budget_lines WHERE id=?", (oa["linked_line"],))
        if option and oa["linked_line"] in option.cuts and not budget_rejected:
            new_amt = option.cuts[oa["linked_line"]]
            note = (f"Amended to {_inr(new_amt)} after {name} revised its commitment ({rc.change_id}); "
                    f"needs re-approval.")
            if oa["amount"] != new_amt or note not in oa["notes"]:
                add(f"approval.{oa['id']}", "approvals.update",
                    {"org_approval_id": oa["id"], "amount": new_amt, "status": "on_hold", "note": note,
                     "expect_amount": oa["amount"]},
                    f"{oa['subject']} no longer matches the budget line.", [a_budget], new_amt - oa["amount"],
                    [oa["id"]])
        elif line and line["funded_by"] == sid:
            note = (f"Funding source changed: {name} commitment {_inr(rc.old_amount)}→{_inr(rc.new_amount)} "
                    f"({rc.change_id}); amount unchanged.")
            if note not in oa["notes"]:
                add(f"approval.{oa['id']}", "approvals.update",
                    {"org_approval_id": oa["id"], "amount": oa["amount"], "status": oa["status"], "note": note,
                     "expect_amount": oa["amount"]},
                    f"{oa['subject']} was funded by {name}; flag the change for the approver.", [a_commit], 0,
                    [oa["id"]])

    # 6-7. deliverables and their calendar entries
    ent = config.ENTITLEMENTS[rc.new_tier]
    for d in db.query("SELECT * FROM deliverables WHERE sponsor_id=?", (sid,)):
        target_spec = ent.get(d["kind"])
        t_spec, t_status = (d["spec"], "removed") if target_spec is None else (target_spec, "active")
        a_del = None
        if (d["spec"], d["status"]) != (t_spec, t_status):
            what = "removed" if t_status == "removed" else f"{d['spec']} → {t_spec}"
            a_del = add(f"deliverable.{d['id']}", "deliverables.set",
                        {"deliverable_id": d["id"], "spec": t_spec, "status": t_status,
                         "expect_spec": d["spec"], "expect_status": d["status"]},
                        f"{d['kind'].replace('_', ' ')}: {what} under {rc.new_tier} entitlements.", [a_tier],
                        extra_ev=[d["id"]])
        for e in db.query("SELECT * FROM calendar_events WHERE linked_entity=?", (d["id"],)):
            if t_status == "removed" and e["status"] != "cancelled":
                add(f"calendar.{e['id']}.status", "calendar.set_status",
                    {"event_id": e["id"], "status": "cancelled", "expect": e["status"]},
                    f"'{e['title']}' belongs to a deliverable {name} is no longer entitled to.", [a_del],
                    extra_ev=[e["id"]])
            elif t_status == "active" and t_spec != d["spec"]:
                note = f"Artwork change: {name} logo {d['spec']} → {t_spec} before this date ({rc.change_id})."
                if note not in e["notes"]:
                    add(f"calendar.{e['id']}.note", "calendar.add_note", {"target_id": e["id"], "note": note},
                        f"'{e['title']}' must use the revised artwork.", [a_del], extra_ev=[e["id"]])
    for e in db.query("SELECT * FROM calendar_events WHERE linked_entity=? AND title LIKE '%payment%'", (sid,)):
        note = f"Expected amount now {_inr(rc.new_amount)} (was {_inr(rc.old_amount)}), per {rc.change_id}."
        if note not in e["notes"]:
            add(f"calendar.{e['id']}.note", "calendar.add_note", {"target_id": e["id"], "note": note},
                "Payment reminder must show the new amount.", [a_commit], extra_ev=[e["id"]])

    # 8. promotional assets
    if rc.new_tier != rc.old_tier:
        for p in db.query("SELECT * FROM promo_assets WHERE published=1"):
            if sid in p["sponsor_ids"] and rc.old_tier.lower() in p["text"].lower():
                note = f"{name} is now {rc.new_tier} (was {rc.old_tier}); correct the partner listing."
                if note not in p["flags"]:
                    add(f"promo.{p['id']}", "promo.flag_correction", {"target_id": p["id"], "note": note},
                        f"Published {p['kind']} still lists {name} as {rc.old_tier}.", [a_tier], extra_ev=[p["id"]])

    # 9. agreement doc
    for d in db.query("SELECT * FROM docs WHERE sponsor_id=?", (sid,)):
        note = (f"Revised per {rc.change_id}: commitment {_inr(rc.old_amount)} → {_inr(rc.new_amount)}, "
                f"tier {rc.old_tier} → {rc.new_tier}.")
        if note not in d["notes"]:
            add(f"doc.{d['id']}", "docs.append_note", {"target_id": d["id"], "note": note},
                "Keep the agreement record consistent with the tracker.", [a_commit], extra_ev=[d["id"]])

    # 10. long-term memory
    msg = db.query_one("SELECT received_at FROM messages WHERE id=?", (rc.change_id,))
    valid_from = msg["received_at"] if msg else datetime.now().isoformat(timespec="seconds")
    for pred, val, dep in (("committed_amount", str(rc.new_amount), a_commit), ("tier", rc.new_tier, a_tier)):
        cur = db.query_one("SELECT value FROM facts WHERE entity=? AND predicate=? AND valid_to IS NULL", (sid, pred))
        if not cur or cur["value"] != val:
            add(f"memory.{pred}", "memory.supersede_fact",
                {"entity": sid, "predicate": pred, "value": val, "source_ref": rc.change_id,
                 "confidence": rc.confidence, "valid_from": valid_from},
                f"Supersede the remembered {pred} (kept as history, not deleted).", [dep])

    # 11-12. communications (last: irreversible / outward-facing)
    internal = [a.id for a in actions if not a.tool.startswith("comms.")]
    if rc.shortfall != 0 or rc.new_tier != rc.old_tier:
        benefits = {k: v for k, v in ent.items() if v}
        perks = ", ".join(f"{k.replace('_', ' ')} ({v})" for k, v in benefits.items()) or "website listing"
        body = (f"Dear {sponsor['contact'].split('.')[0].title()},\n\nThank you for letting us know. We have "
                f"updated {name}'s commitment to {_inr(rc.new_amount)} for Innovision 2026. At this level the "
                f"partnership moves to our {rc.new_tier} tier, which includes: {perks}."
                f"\n\nCould you confirm this is final so we can lock the print run?\n\nRegards,\nPriya, Sponsorship lead")
        already = db.query_one("SELECT 1 FROM outbox WHERE change_id=? AND recipient=?", (rc.change_id, sponsor["contact"]))
        if not already:
            add("comms.sponsor_email", "comms.email",
                {"to": sponsor["contact"], "cc": [], "subject": "Re: Revised sponsorship commitment",
                 "body": body, "approval_id": None},
                f"Confirm the new terms with {name} in writing.", internal)
        if not db.query_one("SELECT 1 FROM outbox WHERE change_id=? AND recipient='#core-team'", (rc.change_id,)):
            add("comms.team_chat", "comms.chat",
            {"channel": "#core-team",
             "body": f"{name} revised to {_inr(rc.new_amount)} ({rc.old_tier} → {rc.new_tier}). "
                     f"Shortfall {_inr(rc.shortfall)}"
                     + (f", covered by option {option.id} ({option.name}), open gap {_inr(gap)}" if option else "")
                     + ". Design: banner artwork; Programme: keynote slot; Marketing: posts. "
                     f"Source: {rc.change_id}.", "approval_id": None},
            "Tell the owners of every affected item.", internal)
    return actions
