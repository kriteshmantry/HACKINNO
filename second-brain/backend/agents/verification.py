"""Verification agent (code only): re-reads the workspace and checks invariants V1-V10.
Checks tied to an action the human explicitly rejected are reported as waived, not failed."""
from __future__ import annotations

from collections import Counter

from .. import config, db
from ..models import Plan, ResolvedChange, VerificationCheck, VerificationReport

FINAL_OK = {"done", "skipped_duplicate", "rejected_by_human", "replaced"}
WAIVERS = {"V1": ("sponsor.committed",), "V2": ("sponsor.tier",), "V3": ("sponsor.tier", "deliverable."),
           "V5": ("calendar.", "deliverable."), "V10": ("memory.",)}


def verify(rc: ResolvedChange, plan: Plan | None, run_id: str, rejected_keys: list[str]) -> VerificationReport:
    checks: list[VerificationCheck] = []

    def check(cid: str, name: str, ok: bool, expected=None, actual=None) -> None:
        if not ok and any(k.startswith(p) for k in rejected_keys for p in WAIVERS.get(cid, ())):
            checks.append(VerificationCheck(id=cid, name=f"{name} (waived: human rejected the change)",
                                            ok=True, expected=expected, actual=actual))
            return
        checks.append(VerificationCheck(id=cid, name=name, ok=ok, expected=expected, actual=actual))

    sp = db.query_one("SELECT * FROM sponsors WHERE id=?", (rc.sponsor_id,))
    check("V1", "Sponsor committed amount matches the change", sp["committed_amount"] == rc.new_amount,
          rc.new_amount, sp["committed_amount"])
    check("V2", "Sponsor tier follows the tier rules", sp["tier"] == config.tier_for(sp["committed_amount"]),
          config.tier_for(sp["committed_amount"]), sp["tier"])

    ent = config.ENTITLEMENTS[sp["tier"]]
    bad = []
    for d in db.query("SELECT * FROM deliverables WHERE sponsor_id=?", (rc.sponsor_id,)):
        want = ent.get(d["kind"])
        if (want is None and d["status"] != "removed") or (want is not None and (d["status"], d["spec"]) != ("active", want)):
            bad.append(f"{d['id']}={d['spec']}/{d['status']} (want {want or 'removed'})")
    check("V3", "Deliverables match tier entitlements", not bad, "all match", bad or "all match")

    b = db.budget_summary()
    uncovered = max(0, b["shortfall"])
    check("V4", "Budget balances, or the gap is recorded / pending", uncovered == b["recorded_gap"] + b["pending_reductions"],
          uncovered, {"recorded_gap": b["recorded_gap"], "pending": b["pending_reductions"]})

    stale = db.query("SELECT c.id FROM calendar_events c JOIN deliverables d ON c.linked_entity=d.id "
                     "WHERE d.status='removed' AND c.status='active'")
    check("V5", "No active event for a removed deliverable", not stale, [], [s["id"] for s in stale])

    unfinished = [f"{a.id}:{a.status}" for a in (plan.actions if plan else []) if a.status not in FINAL_OK]
    check("V6", "Every planned action reached a final state", not unfinished, [], unfinished)

    evs = db.query("SELECT payload_json FROM events WHERE run_id=? AND type='tool.success'", (run_id,))
    keys = Counter(e["payload_json"].get("key") for e in evs if e["payload_json"].get("key"))
    dupes = [k for k, n in keys.items() if n > 1]
    emails = Counter((r["change_id"], r["recipient"]) for r in db.query("SELECT * FROM outbox WHERE channel='email'"))
    dupes += [f"email {k}" for k, n in emails.items() if n > 1]
    check("V7", "No write applied twice", not dupes, [], dupes)

    unapproved = db.query("SELECT o.id FROM outbox o LEFT JOIN approvals_queue a ON o.approval_id=a.id "
                          "WHERE o.external=1 AND (a.status IS NULL OR a.status NOT IN ('approved','edited'))")
    check("V8", "Every external message was approved", not unapproved, [], [u["id"] for u in unapproved])

    msg_ids = {m["id"] for m in db.query("SELECT id FROM messages")}
    no_chain = [a.id for a in (plan.actions if plan else [])
                if a.status == "done" and not (set(a.evidence_refs) & msg_ids)]
    check("V9", "Every write traces back to a source message", not no_chain, [], no_chain)

    cur = db.query("SELECT * FROM facts WHERE entity=? AND predicate='committed_amount' AND valid_to IS NULL",
                   (rc.sponsor_id,))
    hist = db.query("SELECT * FROM facts WHERE entity=? AND predicate='committed_amount'", (rc.sponsor_id,))
    ok10 = len(cur) == 1 and cur[0]["value"] == str(rc.new_amount) and (len(hist) >= 2 or not rc.contradiction)
    check("V10", "Memory: one current fact, old version kept", ok10,
          {"current": str(rc.new_amount), "history>=2": bool(rc.contradiction)},
          {"current": [c["value"] for c in cur], "versions": len(hist)})

    return VerificationReport(ok=all(c.ok for c in checks), checks=checks)
