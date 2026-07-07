"""
Keyword classifier — turns a news headline/snippet into (crime_type, severity).

Why keywords and not an LLM? The GitHub Actions job runs every 30 minutes,
forever, for free. Keywords are deterministic, instant, and cost nothing.
Order matters: we check the MOST severe categories first, so an article
mentioning both "loot" and "murder" classifies as the worse crime.

Severity scale mirrors the database RPC:
  sexual_assault 10 · murder 10 · assault 6 · robbery/loot 5 ·
  stalking 4 · chain_snatching 3 · harassment 2 · theft 2 · suspicious 1
"""

# (type, severity, [keywords — english + hindi, lowercase])
RULES = [
    ("sexual_assault", 10, [
        "rape", "sexual assault", "molestation", "molested", "gang rape",
        "दुष्कर्म", "बलात्कार", "छेड़छाड़", "यौन शोषण", "गैंगरेप", "रेप",
    ]),
    ("murder", 10, [
        "murder", "killed", "homicide", "beaten to death", "shot dead", "stabbed to death",
        "हत्या", "मर्डर", "कत्ल", "गोली मारकर", "चाकू मारकर हत्या",
    ]),
    ("assault", 6, [
        "assault", "attacked", "beaten", "stabbed", "acid attack", "thrashed",
        "मारपीट", "हमला", "चाकूबाजी", "पिटाई", "जानलेवा हमला",
    ]),
    ("robbery", 5, [
        "robbery", "loot", "dacoity", "armed robbery", "robbed at gunpoint",
        "लूट", "डकैती", "लूटपाट", "हथियार के बल",
    ]),
    ("stalking", 4, [
        "stalking", "stalked", "followed her", "पीछा", "स्टॉकिंग",
    ]),
    ("chain_snatching", 3, [
        "chain snatching", "snatched", "snatching", "mobile snatch",
        "चेन स्नैचिंग", "झपटमार", "स्नैचिंग", "चैन लूट",
    ]),
    ("harassment", 2, [
        "harassment", "eve teasing", "eve-teasing", "obscene", "misbehaved",
        "छेड़खानी", "अश्लील", "बदसलूकी", "उत्पीड़न",
    ]),
    ("theft", 2, [
        "theft", "stolen", "burglary", "house break", "bike theft", "vehicle theft",
        "चोरी", "सेंधमारी", "बाइक चोरी", "वाहन चोरी",
    ]),
    ("suspicious", 1, [
        "suspicious", "kidnap attempt", "attempted abduction",
        "संदिग्ध", "अपहरण की कोशिश",
    ]),
]

# Articles matching these are about crime *statistics/policy*, not an incident
# at a place — we skip them so they don't pollute the map.
SKIP_PATTERNS = [
    "crime rate", "crime branch transfer", "police recruitment", "review meeting",
    "अपराध दर", "समीक्षा बैठक", "भर्ती",
]


def classify(text: str):
    """Return (type, severity) or (None, None) if the article isn't a mappable crime."""
    t = text.lower()
    for pat in SKIP_PATTERNS:
        if pat in t:
            return None, None
    for crime_type, severity, keywords in RULES:
        for kw in keywords:
            if kw in t:
                return crime_type, severity
    return None, None
