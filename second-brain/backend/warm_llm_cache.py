"""Call the LLM once for every message that reaches extraction, and save the answers to
backend/seed/cache/ so the demo replays real model output offline (SB_LLM_MODE=cache, or
auto without a key).

    .venv\\Scripts\\python -m backend.warm_llm_cache            # needs one key in second-brain/.env:
                                                              # GEMINI_API_KEY or GROQ_API_KEY (free tiers),
                                                              # or ANTHROPIC_API_KEY
    .venv\\Scripts\\python -m backend.warm_llm_cache --check    # offline: report what is cached

Runs against a throwaway database, so the demo workspace is untouched. Six calls at low effort.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# a scratch DB and live mode, set before the backend reads its config
os.environ["SB_DB_PATH"] = (str(Path(tempfile.mkdtemp(prefix="sb-warm-")) / "warm.db"))
CHECK = "--check" in sys.argv
os.environ["SB_LLM_MODE"] = "cache" if CHECK else "auto"

from . import config, db, llm  # noqa: E402
from .agents import communication  # noqa: E402
from .confidence import rule_extract  # noqa: E402
from .events import RunCtx  # noqa: E402
from .models import LLMExtraction  # noqa: E402


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if not CHECK and not llm.usable():
        print("No LLM key found. Put GEMINI_API_KEY or GROQ_API_KEY (free tiers) or ANTHROPIC_API_KEY in "
              "second-brain/.env (see .env.example).")
        return 2
    db.reset()
    print(f"Provider {llm.provider()}, model {llm.model_name()}, mode {config.LLM_MODE}, cache {config.CACHE_DIR}\n")
    failures = 0
    for m in db.query("SELECT * FROM messages ORDER BY received_at"):
        t = communication.triage(m)
        if t.label != "relevant":
            why = "quarantined at triage: never shown to the model" if t.label == "suspicious" else "noise"
            if t.label == "suspicious":
                print(f"{m['id']:5}  skipped ({why})")
            continue
        key = llm.cache_key("communication", LLMExtraction, communication.SYSTEM, communication.prompt_for(m))
        ctx = RunCtx(None, m["id"], "Communication")
        ex = communication.extract(m, ctx)
        r_new, r_old, _ = rule_extract(m["body"])
        ok = ex.source in ("llm", "cache")
        failures += not ok
        flag = "" if ex.new_amount == r_new else f"   <- rules read {r_new}"
        print(f"{m['id']:5}  {ex.source:6} sponsor={ex.sponsor_mention!r:12} new={ex.new_amount} old={ex.old_amount}"
              f" self={ex.llm_confidence}{flag}")
        print(f"       span: {ex.evidence_span!r}")
        if ex.ambiguity_notes:
            print(f"       ambiguity: {ex.ambiguity_notes}")
        print(f"       cache: {key}.json")
    print(f"\n{'All' if not failures else 'Not all'} extraction answers {'are' if not failures else 'were'} "
          f"from the model{' (cached)' if CHECK else ''}. {failures} fell back to rules.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
