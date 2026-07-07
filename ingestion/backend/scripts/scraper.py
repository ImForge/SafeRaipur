"""
News scraper template for Raipur crime articles.

This is a *starting point* — you'll need to inspect each site's HTML
and adjust the selectors. Sites change. Be a good citizen:
  - respect robots.txt
  - throttle with delays
  - cache responses
  - check terms of service

Pipeline:
  1. Fetch the index page of the crime section
  2. Extract article URLs
  3. Fetch each article
  4. Extract: date, title, body
  5. NLP-extract: location text, crime type
  6. Geocode the location → lat/lng
  7. Insert into incidents table

Run with:
    cd backend
    python -m scripts.scraper
"""

import re
import time
import pathlib
import sys
from datetime import datetime
import requests
from bs4 import BeautifulSoup

sys.path.append(str(pathlib.Path(__file__).resolve().parent.parent))

from sqlalchemy import func
from database import SessionLocal
from models import Incident


# Sites to scrape — add more as you build out coverage.
SOURCES = [
    {
        "name": "Patrika Raipur",
        "index_url": "https://www.patrika.com/raipur-news/crime",
        # CSS selector for article links on the index page — verify in browser inspector
        "link_selector": "article a",
        "article_title_selector": "h1",
        "article_body_selector": "div.article-content",
    },
    # Add: Dainik Bhaskar, Times of India Raipur, etc.
]


# Known Raipur localities with approximate coordinates.
# In production, use a real geocoder (Nominatim / Google).
LOCALITY_GAZETTEER = {
    # Core Raipur
    "telibandha":        (21.2362, 81.6498),
    "vip road":          (21.2400, 81.6700),
    "marine drive":      (21.2367, 81.6562),
    "civil lines":       (21.2587, 81.6378),
    "kotwali":           (21.2371, 81.6358),
    "devendra nagar":    (21.2473, 81.6557),
    "gol bazar":         (21.2390, 81.6432),
    "ghadi chowk":       (21.2375, 81.6379),
    "tikrapara":         (21.2538, 81.6234),
    "boriyakhurd":       (21.2520, 81.6215),
    "pandri":            (21.2467, 81.6442),
    "mowa":              (21.2790, 81.6815),
    "khamhardih":        (21.2533, 81.6759),
    "gudhiyari":         (21.2364, 81.6111),
    "mandir hasaud":     (21.2156, 81.7372),
    "ganj":              (21.2415, 81.6450),
    "shankar nagar":     (21.2555, 81.6428),
    "nehru nagar":       (21.2685, 81.6388),
    "avanti vihar":      (21.2508, 81.6328),
    "kabir nagar":       (21.2628, 81.6562),
    "fafadih":           (21.2248, 81.6358),
    "labhandi":          (21.2658, 81.6228),
    "katora talab":      (21.2390, 81.6360),
    "pachpedi naka":     (21.2180, 81.6180),
    "vidhan sabha":      (21.2570, 81.6310),
    # Surrounding areas
    "new raipur":        (21.1400, 81.7300),
    "naya raipur":       (21.1400, 81.7300),
    "atal nagar":        (21.1400, 81.7300),
    "mantralaya":        (21.1370, 81.7390),
    "devpuri":           (21.2170, 81.5870),
    "tatibandh":         (21.2850, 81.6490),
    "urla":              (21.2720, 81.5760),
    "birgaon":           (21.2900, 81.7100),
    "bhanpuri":          (21.3050, 81.6500),
    "sarona":            (21.2100, 81.7100),
    "rawabhata":         (21.1900, 81.6150),
    "amleshwar":         (21.1750, 81.5660),
    "kumhari":           (21.3500, 81.6800),
    "siltara":           (21.3200, 81.6700),
    "saddu":             (21.1900, 81.6540),
    "rajatalab":         (21.1980, 81.5900),
    "kota":              (21.2780, 81.5880),
}


CRIME_TYPE_KEYWORDS = {
    "sexual_assault":   ["rape", "molest", "sexual assault", "gangrape", "gang rape"],
    "chain_snatching":  ["chain snatch", "chain-snatching", "snatched"],
    "assault":          ["stabbed", "attacked", "beaten", "knife", "assault"],
    "theft":            ["theft", "stolen", "robbery", "burglary", "robbed"],
    "harassment":       ["eve-teasing", "harassment", "harass", "stalk"],
    "stalking":         ["stalking", "followed home", "stalker"],
}

DEFAULT_SEVERITY = {
    "harassment": 2, "stalking": 4, "chain_snatching": 3,
    "theft": 2, "assault": 6, "sexual_assault": 10, "suspicious_death": 8,
}


def detect_type(text: str) -> str:
    """Match article text against keyword lists. First hit wins."""
    text_lower = text.lower()
    for crime_type, keywords in CRIME_TYPE_KEYWORDS.items():
        if any(kw in text_lower for kw in keywords):
            return crime_type
    return "other"


def extract_location(text: str):
    """Look for known locality names in the text. Return (name, lat, lng) or None."""
    text_lower = text.lower()
    for locality, (lat, lng) in LOCALITY_GAZETTEER.items():
        if locality in text_lower:
            return (locality.title(), lat, lng)
    return None


def detect_time_of_day(text: str) -> datetime:
    """
    Very rough: look for words like 'night', 'midnight', '9 pm', '23:30' etc.
    Default to current date at 10pm (most underreported time).
    """
    now = datetime.utcnow()
    text_lower = text.lower()
    if "midnight" in text_lower or "late night" in text_lower:
        return now.replace(hour=0, minute=30)
    if "morning" in text_lower:
        return now.replace(hour=9, minute=0)
    if "afternoon" in text_lower:
        return now.replace(hour=14, minute=0)
    if "evening" in text_lower:
        return now.replace(hour=18, minute=30)
    # default to night since that's most common reporting bias
    return now.replace(hour=22, minute=0)


def scrape_source(source: dict):
    """Scrape one news source. Returns list of dicts ready to insert."""
    print(f"  Scraping {source['name']} …")
    try:
        resp = requests.get(source["index_url"], timeout=10,
                            headers={"User-Agent": "RaipurSafeMap/0.1 (educational)"})
        resp.raise_for_status()
    except Exception as e:
        print(f"  ! failed to fetch: {e}")
        return []

    soup = BeautifulSoup(resp.text, "lxml")
    links = soup.select(source["link_selector"])[:20]  # cap per run
    print(f"  Found {len(links)} candidate article links")

    incidents = []
    for a in links:
        url = a.get("href")
        if not url:
            continue
        if not url.startswith("http"):
            url = re.sub(r"/+$", "", source["index_url"].split("/raipur")[0]) + url

        try:
            ar = requests.get(url, timeout=10, headers={"User-Agent": "RaipurSafeMap/0.1"})
            ar.raise_for_status()
            asoup = BeautifulSoup(ar.text, "lxml")
            title_el = asoup.select_one(source["article_title_selector"])
            body_el = asoup.select_one(source["article_body_selector"])
            if not (title_el and body_el):
                continue
            title = title_el.get_text(strip=True)
            body = body_el.get_text(" ", strip=True)
            full_text = title + " " + body
        except Exception as e:
            print(f"  ! {url}: {e}")
            continue

        crime_type = detect_type(full_text)
        if crime_type == "other":
            continue

        loc = extract_location(full_text)
        if not loc:
            continue
        area_name, lat, lng = loc

        incidents.append({
            "type": crime_type,
            "severity": DEFAULT_SEVERITY.get(crime_type, 3),
            "area": area_name,
            "description": title[:300],
            "source": "news",
            "source_url": url,
            "occurred_at": detect_time_of_day(full_text),
            "lat": lat, "lng": lng,
        })
        time.sleep(1)  # polite throttle

    return incidents


def main():
    db = SessionLocal()
    total = 0
    try:
        for source in SOURCES:
            results = scrape_source(source)
            for r in results:
                # Avoid duplicates by source_url
                existing = db.query(Incident).filter_by(source_url=r["source_url"]).first()
                if existing:
                    continue
                db.add(Incident(
                    type=r["type"], severity=r["severity"],
                    area=r["area"], description=r["description"],
                    source=r["source"], source_url=r["source_url"],
                    occurred_at=r["occurred_at"],
                    location=func.ST_SetSRID(func.ST_MakePoint(r["lng"], r["lat"]), 4326),
                ))
                total += 1
        db.commit()
        print(f"✓ Inserted {total} new incidents.")
    finally:
        db.close()


if __name__ == "__main__":
    main()