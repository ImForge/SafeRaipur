"""
News fetcher — Google News RSS instead of scraping newspaper HTML.

Why RSS beats the old scraper.py approach:
  • Patrika/Bhaskar redesign their HTML → CSS selectors break silently.
    Google News RSS format hasn't changed in a decade.
  • One endpoint aggregates ALL sources (Patrika, Bhaskar, TOI, Naidunia,
    ETV Bharat, IBC24...) — coverage we could never scrape ourselves.
  • Supports Hindi queries natively (hl=hi), which is where most Raipur
    crime reporting actually lives.

Each query is a separate RSS feed; we dedupe across them with md5(url).
"""

import hashlib
import re
import time
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import requests

QUERIES = [
    # English
    ("raipur crime",            "en-IN"),
    ("raipur theft",            "en-IN"),
    ("raipur assault",          "en-IN"),
    ("raipur robbery",          "en-IN"),
    ("raipur harassment woman", "en-IN"),
    ("raipur police arrest",    "en-IN"),
    ("raipur murder",           "en-IN"),
    ("raipur snatching",        "en-IN"),
    # Hindi — this is where the volume is
    ("रायपुर चोरी",             "hi-IN"),
    ("रायपुर लूट",              "hi-IN"),
    ("रायपुर हत्या",            "hi-IN"),
    ("रायपुर छेड़छाड़",          "hi-IN"),
    ("रायपुर मारपीट",           "hi-IN"),
    ("रायपुर अपराध",            "hi-IN"),
    ("रायपुर चाकूबाजी",         "hi-IN"),
    ("रायपुर स्नैचिंग",          "hi-IN"),
    ("रायपुर गिरफ्तार",         "hi-IN"),
]

UA = {"User-Agent": "SafeRaipurBot/2.0 (+https://saferaipur.vercel.app; civic safety project)"}


def _feed_url(query: str, lang: str) -> str:
    q = urllib.parse.quote(query)
    hl = lang
    gl = "IN"
    ceid = f"IN:{lang.split('-')[0]}"
    # when:2d → only articles from the last 2 days; the 30-min cron plus
    # url_hash dedupe means we never insert the same story twice.
    return (
        f"https://news.google.com/rss/search?q={q}+when:2d"
        f"&hl={hl}&gl={gl}&ceid={ceid}"
    )


def _strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", " ", s or "").strip()


def fetch_articles():
    """Yield dicts: {title, snippet, url, url_hash, published_at}. Deduped."""
    seen = set()
    for query, lang in QUERIES:
        try:
            resp = requests.get(_feed_url(query, lang), headers=UA, timeout=20)
            resp.raise_for_status()
            root = ET.fromstring(resp.content)
        except Exception as e:
            print(f"  ! feed failed [{query}]: {e}")
            continue

        for item in root.iter("item"):
            url = (item.findtext("link") or "").strip()
            title = _strip_html(item.findtext("title") or "")
            snippet = _strip_html(item.findtext("description") or "")
            if not url or not title:
                continue

            url_hash = hashlib.md5(url.encode()).hexdigest()
            if url_hash in seen:
                continue
            seen.add(url_hash)

            pub_raw = item.findtext("pubDate")
            try:
                published_at = parsedate_to_datetime(pub_raw).astimezone(timezone.utc)
            except Exception:
                published_at = datetime.now(timezone.utc)

            yield {
                "title": title,
                "snippet": snippet,
                "url": url,
                "url_hash": url_hash,
                "published_at": published_at,
            }
        time.sleep(1.5)  # be polite between feeds
