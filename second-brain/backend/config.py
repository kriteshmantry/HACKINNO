"""Runtime configuration. Everything is overridable via environment variables."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


def _load_dotenv(path: Path) -> None:
    """Read KEY=VALUE lines from second-brain/.env (gitignored) without overriding the real
    environment. Keeps the API key out of the code and out of git."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and value and not os.environ.get(key):
            os.environ[key] = value


_load_dotenv(BASE_DIR.parent / ".env")

DATA_DIR = Path(os.getenv("SB_DATA_DIR", BASE_DIR / "data"))
SEED_DIR = BASE_DIR / "seed"
CACHE_DIR = SEED_DIR / "cache"
DB_PATH = Path(os.getenv("SB_DB_PATH", DATA_DIR / "secondbrain.db"))

# LLM
MODEL = os.getenv("SB_MODEL", "claude-opus-5-5")
# "auto": use the API when ANTHROPIC_API_KEY is set, else cache, else rules.
# "cache": never call the API (offline demo). "off": rules only.
LLM_MODE = os.getenv("SB_LLM_MODE", "auto")

# Scenario clock (fixed so severity / deadline maths is reproducible)
SCENARIO_NOW = os.getenv("SB_NOW", "2026-11-14T00:00:00")

# Coordinator budgets
MAX_REPLANS = int(os.getenv("SB_MAX_REPLANS", 2))
APPROVAL_TIMEOUT_S = float(os.getenv("SB_APPROVAL_TIMEOUT_S", 600))
DEFAULT_OPTION_WAIT_S = float(os.getenv("SB_OPTION_WAIT_S", 0))

# Tool layer
TOOL_RETRIES = int(os.getenv("SB_TOOL_RETRIES", 3))
TOOL_BASE_DELAY_S = float(os.getenv("SB_TOOL_BASE_DELAY_S", 0.4))
TOOL_TIMEOUT_S = float(os.getenv("SB_TOOL_TIMEOUT_S", 5.0))
BREAKER_THRESHOLD = int(os.getenv("SB_BREAKER_THRESHOLD", 3))
BREAKER_COOLDOWN_S = float(os.getenv("SB_BREAKER_COOLDOWN_S", 30))

# Confidence bands (defaults; a person can move them at runtime through /api/trust/policy)
BAND_AUTONOMOUS = 0.80
BAND_SUPERVISED = 0.50
# Below this sender trust, the recommended verification is "ask the contact on file"
TRUST_LOW = 0.50
# Webmail domains: fine for a volunteer, odd for a sponsor's finance team
FREE_MAIL = {"gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "proton.me", "protonmail.com", "icloud.com"}
INTERNAL_DOMAIN = "innovision.in"

# Tier-boundary negotiation: what a sponsor can buy back on top of a lower tier.
# Workspace policy set by the sponsorship lead; the agent never invents prices.
ADDON_PRICES = {"keynote": 75_000, "banner_logo": 25_000, "social_posts": 10_000}
# Only suggest buying back the old tier when the top-up is at most this share of the new amount
NEGOTIATION_MAX_TOPUP_SHARE = 0.5

# Risk radar look-ahead
RADAR_HORIZON_DAYS = 14
RADAR_URGENT_DAYS = 3
FEST_DATE = os.getenv("SB_FEST_DATE", "2026-11-20")

# Policy
APPROVAL_RISK_THRESHOLD = 3
APPROVAL_MONEY_THRESHOLD = 25_000

TIERS = [("Gold", 4_00_000), ("Silver", 2_00_000), ("Bronze", 50_000)]
# kind -> spec per tier; None means the deliverable is not part of that tier
ENTITLEMENTS = {
    "Gold":   {"banner_logo": "L", "keynote": "20 min", "social_posts": "3"},
    "Silver": {"banner_logo": "M", "keynote": None,     "social_posts": "2"},
    "Bronze": {"banner_logo": None, "keynote": None,    "social_posts": None},
    "None":   {"banner_logo": None, "keynote": None,    "social_posts": None},
}


def tier_for(amount: int) -> str:
    for name, floor in TIERS:
        if amount >= floor:
            return name
    return "None"
