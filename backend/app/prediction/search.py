import asyncio
import re
import time

import httpx

TAVILY_SEARCH_URL = "https://api.tavily.com/search"
GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc"

# GDELT asks for at most one request every five seconds.
GDELT_MIN_INTERVAL_S = 5.5
GDELT_MAX_KEYWORDS = 4
_gdelt_lock = asyncio.Lock()
_gdelt_last_call = 0.0

STOPWORDS = {
    "will", "the", "and", "for", "that", "this", "with", "from", "have", "has", "than", "more", "less", "over",
    "under", "above", "below", "before", "after", "what", "which", "who", "when", "how", "many", "much", "win",
    "any", "are", "was", "were", "been", "being", "does", "did", "its", "their", "there", "into", "between",
    "during", "least", "most", "next", "first", "new", "end", "yes", "not",
}


async def date_fenced_search(
    client: httpx.AsyncClient, api_key: str, query: str, days: int = 7, max_results: int = 6, topic: str = "news"
) -> list[dict]:
    """Search restricted to the last `days` days for news; `topic="general"` searches the wider web.

    Returns [{title, url, snippet, date}, ...]. Uses Tavily when a key is set and the
    keyless GDELT index otherwise. Raises on HTTP errors so the caller can skip the
    market instead of forecasting on a failed search.
    """
    if api_key:
        return await tavily_search(client, api_key, query, days, max_results, topic)
    return await gdelt_search(client, query, days, max_results)


async def tavily_search(
    client: httpx.AsyncClient, api_key: str, query: str, days: int, max_results: int, topic: str = "news"
) -> list[dict]:
    body = {"query": query[:400], "topic": topic, "max_results": max_results, "search_depth": "basic"}
    if topic == "news":
        body["days"] = days
    resp = await client.post(TAVILY_SEARCH_URL, headers={"Authorization": f"Bearer {api_key}"}, json=body, timeout=30)
    resp.raise_for_status()
    return [
        {
            "title": r.get("title", ""),
            "url": r.get("url", ""),
            "snippet": (r.get("content") or "")[:700],
            "date": r.get("published_date") or "",
        }
        for r in resp.json().get("results", [])
    ]


def gdelt_keywords(query: str) -> list[str]:
    """GDELT ANDs every term and rejects short ones, so keep a few distinctive words."""
    words = re.findall(r"[A-Za-z][A-Za-z'-]{2,}|\d{4}", query)
    seen: list[str] = []
    for word in words:
        key = word.lower()
        if key not in STOPWORDS and key not in (w.lower() for w in seen):
            seen.append(word)
    # Proper nouns and years identify the event better than common words.
    seen.sort(key=lambda w: not (w[0].isupper() or w.isdigit()))
    return seen[:GDELT_MAX_KEYWORDS]


async def gdelt_search(client: httpx.AsyncClient, query: str, days: int, max_results: int) -> list[dict]:
    """Headlines only: GDELT returns titles and dates but no article text."""
    global _gdelt_last_call
    keywords = gdelt_keywords(query)
    if not keywords:
        return []
    async with _gdelt_lock:
        wait = GDELT_MIN_INTERVAL_S - (time.monotonic() - _gdelt_last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            resp = await client.get(
                GDELT_DOC_URL,
                params={
                    "query": f"{' '.join(keywords)} sourcelang:english",
                    "mode": "artlist",
                    "format": "json",
                    "timespan": f"{days}d",
                    "maxrecords": max_results,
                    "sort": "datedesc",
                },
                timeout=30,
            )
        finally:
            _gdelt_last_call = time.monotonic()
    resp.raise_for_status()
    try:
        articles = resp.json().get("articles", [])
    except ValueError:
        # GDELT answers a query it dislikes with a plain-text message and status 200.
        return []
    return [
        {"title": a.get("title", ""), "url": a.get("url", ""), "snippet": "", "date": a.get("seendate", "")[:8]}
        for a in articles
    ]
