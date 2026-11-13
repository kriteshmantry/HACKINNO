"""Knowledge graph built deterministically from the workspace DB, plus typed impact analysis.

Impact propagates along each edge type in a declared direction. `approves` propagates in
reverse: a change to a budget line affects the approval that signs off on it (v1 missed this).
"""
from __future__ import annotations

from collections import deque
from datetime import datetime

import networkx as nx

from .. import config, db

PROPAGATE = {
    "has_tier": "fwd", "entitles": "fwd", "funds": "fwd", "contributes_to": "fwd",
    "scheduled_as": "fwd", "pays_by": "fwd", "depicted_in": "fwd", "documented_in": "fwd",
    "owned_by": "fwd", "approves": "rev", "allocates": None,
}


def build() -> nx.MultiDiGraph:
    G = nx.MultiDiGraph()
    people = {p["id"]: p for p in db.query("SELECT * FROM people")}

    def person(pid: str | None, src: str) -> None:
        if pid and pid in people:
            p = people[pid]
            G.add_node(pid, type="Person", label=f"{p['name']} ({p['role']})")
            G.add_edge(src, pid, type="owned_by")

    G.add_node("budget-total", type="Budget", label="Total budget")
    for s in db.query("SELECT * FROM sponsors"):
        sid = s["id"]
        G.add_node(sid, type="Sponsor", label=f"{s['name']}", tier=s["tier"], amount=s["committed_amount"])
        tid = f"tier:{sid}"
        G.add_node(tid, type="Tier", label=f"{s['name'].split()[0]} tier: {s['tier']}")
        G.add_edge(sid, tid, type="has_tier")
        G.add_edge(sid, "budget-total", type="contributes_to")
    for d in db.query("SELECT * FROM deliverables"):
        G.add_node(d["id"], type="Deliverable", label=f"{d['kind'].replace('_', ' ')} ({d['spec']})",
                   deadline=d["deadline"], status=d["status"])
        G.add_edge(f"tier:{d['sponsor_id']}", d["id"], type="entitles")
        person(d["owner"], d["id"])
    for b in db.query("SELECT * FROM budget_lines"):
        G.add_node(b["id"], type="BudgetLine", label=f"{b['category']} ₹{b['amount']:,}", amount=b["amount"])
        G.add_edge("budget-total", b["id"], type="allocates")
        if b["funded_by"]:
            G.add_edge(b["funded_by"], b["id"], type="funds")
        person(b["owner"], b["id"])
    for oa in db.query("SELECT * FROM org_approvals"):
        G.add_node(oa["id"], type="OrgApproval", label=oa["subject"], status=oa["status"])
        if oa["linked_line"]:
            G.add_edge(oa["id"], oa["linked_line"], type="approves")
        person(oa["approver"], oa["id"])
    for ev in db.query("SELECT * FROM calendar_events"):
        G.add_node(ev["id"], type="CalendarEvent", label=f"{ev['title']} ({ev['date'][5:]})",
                   date=ev["date"], status=ev["status"])
        link = ev["linked_entity"]
        if link and link.startswith("d-"):
            G.add_edge(link, ev["id"], type="scheduled_as")
        elif link and link.startswith("s-"):
            G.add_edge(link, ev["id"], type="pays_by")
        person(ev["owner"], ev["id"])
    for p in db.query("SELECT * FROM promo_assets"):
        G.add_node(p["id"], type="PromoAsset", label=f"{p['kind']}: {p['text'][:40]}", published=p["published"])
        for sid in p["sponsor_ids"]:
            G.add_edge(sid, p["id"], type="depicted_in")
    for d in db.query("SELECT * FROM docs"):
        G.add_node(d["id"], type="Doc", label=d["title"])
        if d["sponsor_id"]:
            G.add_edge(d["sponsor_id"], d["id"], type="documented_in")
    return G


def severity(G: nx.MultiDiGraph, node: str) -> str:
    a = G.nodes[node]
    t = a.get("type")
    now = datetime.fromisoformat(config.SCENARIO_NOW)

    def soon(date: str | None) -> bool:
        return bool(date) and (datetime.fromisoformat(date) - now).total_seconds() <= 72 * 3600

    if t == "PromoAsset":
        return "high" if a.get("published") else "medium"
    if t == "OrgApproval":
        return "high" if a.get("status") == "pending" else "medium"
    if t == "CalendarEvent":
        return "high" if soon(a.get("date")) else "medium"
    if t == "Deliverable":
        return "high" if soon(a.get("deadline")) else "medium"
    if t in ("BudgetLine", "Tier", "Budget"):
        return "medium"
    return "low"


def impacted(G: nx.MultiDiGraph, root: str, max_depth: int = 4) -> list[dict]:
    """Breadth-first walk along propagating edges; returns each node with the path that explains it."""
    seen, out = {root}, []
    q = deque([(root, [root])])
    while q:
        node, path = q.popleft()
        if len(path) // 2 >= max_depth:
            continue
        nbrs = [(v, d["type"]) for _, v, d in G.out_edges(node, data=True) if PROPAGATE.get(d["type"]) == "fwd"]
        nbrs += [(u, d["type"]) for u, _, d in G.in_edges(node, data=True) if PROPAGATE.get(d["type"]) == "rev"]
        for nxt, et in nbrs:
            if nxt in seen:
                continue
            seen.add(nxt)
            p = path + [et, nxt]
            out.append({"node": nxt, "type": G.nodes[nxt]["type"], "label": G.nodes[nxt]["label"],
                        "path": p, "depth": len(p) // 2, "severity": severity(G, nxt)})
            q.append((nxt, p))
    order = {"high": 0, "medium": 1, "low": 2}
    return sorted(out, key=lambda n: (order[n["severity"]], n["depth"]))


def to_json(G: nx.MultiDiGraph, impacted_nodes: list[dict] | None = None) -> dict:
    imp = {n["node"]: n for n in (impacted_nodes or [])}
    on_path = set()
    for n in imp.values():
        p = n["path"]
        for i in range(0, len(p) - 2, 2):
            on_path.add((p[i], p[i + 2], p[i + 1]))
    nodes = [{"id": n, **{k: v for k, v in a.items()}, "impacted": n in imp,
              "severity": imp[n]["severity"] if n in imp else None,
              "path": imp[n]["path"] if n in imp else None} for n, a in G.nodes(data=True)]
    edges = []
    for u, v, d in G.edges(data=True):
        hot = (u, v, d["type"]) in on_path or (v, u, d["type"]) in on_path
        edges.append({"source": u, "target": v, "type": d["type"], "on_impact_path": hot})
    return {"nodes": nodes, "edges": edges}
