"""
Gazetteer geocoder — finds WHERE in Raipur an article happened.

Why not Nominatim/Google? News text says things like "टिकरापारा इलाके में
देर रात..." — general geocoders choke on that. A substring match against
our own curated list of ~60 localities is faster, free, offline, and more
accurate for exactly this city. When the scraper misses a locality that
keeps appearing in the news, add it to gazetteer.json and it's fixed forever.

Tie-breaking: if multiple localities match, prefer the one whose alias
appears EARLIEST in the text (news leads with the location that matters).
"""

import json
import pathlib

_GAZ = json.loads(
    (pathlib.Path(__file__).parent / "gazetteer.json").read_text(encoding="utf-8")
)["localities"]


def geocode(text: str):
    """Return (name, lat, lng) of the best-matching locality, or None."""
    t = text.lower()
    best = None
    best_pos = 10**9
    for loc in _GAZ:
        for alias in loc["aliases"]:
            pos = t.find(alias)
            if pos != -1 and pos < best_pos:
                best_pos = pos
                best = loc
    if best is None:
        return None
    return best["name"], best["lat"], best["lng"]
