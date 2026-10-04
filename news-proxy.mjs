import { createServer } from "node:http";
import { fetchGoogleNewsRss } from "./rss-relay.mjs";

const host = "127.0.0.1";
const port = 4178;
const KALSHI_API = "https://external-api.kalshi.com/trade-api/v2";
const GNEWS_API = "https://gnews.io/api/v4/search";
const cache = new Map();
const cacheDurationMs = 60 * 60 * 1000;
const kalshiPageCache = new Map();
const kalshiPageCacheMs = 15 * 1000;
const seriesCacheMs = 6 * 60 * 60 * 1000;
const minimumIntervalMs = 1500;
let nextRequestAt = 0;
let requestQueue = Promise.resolve();
let seriesCatalogCache = null;

function send(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Cache-Control": "no-store",
    "Content-Type": contentType
  });
  response.end(body);
}

async function fetchKalshiJson(path) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${KALSHI_API}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Kalshi API returned HTTP ${response.status}.${text ? ` ${text.slice(0, 180)}` : ""}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Kalshi returned an invalid JSON response.");
    }
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Kalshi market data timed out after 12 seconds.");
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getSeriesCatalog() {
  if (seriesCatalogCache && seriesCatalogCache.expiresAt > Date.now()) return seriesCatalogCache;
  const byTicker = new Map();
  const categories = new Set();
  let cursor = "";
  do {
    const params = new URLSearchParams({ limit: "1000" });
    if (cursor) params.set("cursor", cursor);
    const data = await fetchKalshiJson(`/series?${params}`);
    for (const series of Array.isArray(data.series) ? data.series : []) {
      const seriesCategories = [...new Set((Array.isArray(series.categories) ? series.categories : [])
        .filter((category) => typeof category === "string" && category.trim()))];
      const primaryCategory = typeof series.category === "string" && series.category.trim()
        ? series.category.trim()
        : "Uncategorized";
      if (primaryCategory !== "Uncategorized") seriesCategories.unshift(primaryCategory);
      const uniqueCategories = [...new Set(seriesCategories)];
      for (const category of uniqueCategories) categories.add(category);
      byTicker.set(series.ticker, { category: primaryCategory, categories: uniqueCategories });
    }
    cursor = data.cursor || "";
  } while (cursor);

  seriesCatalogCache = {
    byTicker,
    categories: [...categories].sort((left, right) => left.localeCompare(right)),
    expiresAt: Date.now() + seriesCacheMs
  };
  return seriesCatalogCache;
}

function normalizeKalshiMarket(event, market, seriesMetadata, fetchedAt) {
  const title = market.title || [event.title, market.subtitle || market.yes_sub_title].filter(Boolean).join(" · ");
  const settlementSource = Array.isArray(event.settlement_sources) ? event.settlement_sources[0] : null;
  return {
    id: market.ticker,
    marketTicker: market.ticker,
    eventTicker: event.event_ticker,
    seriesTicker: event.series_ticker,
    title,
    eventTitle: event.title || title,
    subtitle: market.subtitle || market.yes_sub_title || event.sub_title || "",
    category: seriesMetadata?.category || "Uncategorized",
    categories: seriesMetadata?.categories || [],
    marketType: market.market_type,
    closes: market.close_time || "",
    quoteFetchedAt: fetchedAt,
    yesBid: market.yes_bid_dollars,
    yesAsk: market.yes_ask_dollars,
    noBid: market.no_bid_dollars,
    noAsk: market.no_ask_dollars,
    lastPrice: market.last_price_dollars,
    volume: market.volume_fp,
    openInterest: market.open_interest_fp,
    rules: [market.rules_primary, market.rules_secondary].filter(Boolean).join("\n\n") || "Kalshi has not provided resolution rules for this market.",
    sourceName: settlementSource?.name || "Kalshi settlement source",
    sourceUrl: settlementSource?.url || "",
    newsQuery: title
  };
}

async function getKalshiEventPage(cursor = "") {
  const cacheKey = cursor || "first";
  const cached = kalshiPageCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const catalog = await getSeriesCatalog();
  const params = new URLSearchParams({ status: "open", with_nested_markets: "true", limit: "200" });
  if (cursor) params.set("cursor", cursor);
  const data = await fetchKalshiJson(`/events?${params}`);
  const fetchedAt = new Date().toISOString();
  const markets = (Array.isArray(data.events) ? data.events : []).flatMap((event) => {
    const series = catalog.byTicker.get(event.series_ticker);
    return (Array.isArray(event.markets) ? event.markets : [])
      .filter((market) => market.status === "active" && market.market_type === "binary")
      .map((market) => normalizeKalshiMarket(event, market, series, fetchedAt));
  });
  const page = { markets, categories: catalog.categories, cursor: data.cursor || "", fetchedAt };
  kalshiPageCache.set(cacheKey, { data: page, expiresAt: Date.now() + kalshiPageCacheMs });
  return page;
}

async function getKalshiMarket(ticker, seriesTicker) {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(ticker)) throw new Error("Invalid Kalshi market ticker.");
  const [data, catalog] = await Promise.all([
    fetchKalshiJson(`/markets/${encodeURIComponent(ticker)}`),
    getSeriesCatalog()
  ]);
  const market = data.market;
  if (!market) throw new Error("Kalshi did not return that market.");
  const eventTicker = market.event_ticker;
  const eventData = await fetchKalshiJson(`/events/${encodeURIComponent(eventTicker)}`);
  const event = eventData.event || {};
  const nestedMarket = (eventData.markets || []).find((item) => item.ticker === ticker) || market;
  const resolvedSeriesTicker = seriesTicker || event.series_ticker;
  const series = catalog.byTicker.get(resolvedSeriesTicker);
  return normalizeKalshiMarket(event, nestedMarket, series, new Date().toISOString());
}

async function routeKalshi(url, response) {
  try {
    if (url.pathname === "/kalshi/events") {
      const page = await getKalshiEventPage(url.searchParams.get("cursor") || "");
      send(response, 200, JSON.stringify(page), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/kalshi/market") {
      const ticker = url.searchParams.get("ticker") || "";
      const seriesTicker = url.searchParams.get("series_ticker") || "";
      const market = await getKalshiMarket(ticker, seriesTicker);
      send(response, 200, JSON.stringify({ market }), "application/json; charset=utf-8");
      return;
    }
    send(response, 404, "Not found");
  } catch (error) {
    send(response, 502, error.message || "Could not retrieve Kalshi market data");
  }
}

async function fetchFeed(query) {
  const apiKey = process.env.GNEWS_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("GNews is not configured. Set GNEWS_API_KEY before starting the local relay."), { status: 503 });
  }
  const normalizedQuery = query.trim().slice(0, 200);
  const cached = cache.get(normalizedQuery);
  if (cached && cached.expiresAt > Date.now()) return cached.articles;

  const operation = requestQueue.then(async () => {
    const remaining = nextRequestAt - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    nextRequestAt = Date.now() + minimumIntervalMs;

    const feedUrl = new URL(GNEWS_API);
    feedUrl.search = new URLSearchParams({ q: normalizedQuery, lang: "en", max: "10", apikey: apiKey });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(feedUrl, { headers: { Accept: "application/json" }, signal: controller.signal });
    } catch (error) {
      if (error.name === "AbortError") throw Object.assign(new Error("GNews timed out after 15 seconds."), { status: 503 });
      throw Object.assign(new Error("Could not reach GNews."), { status: 503 });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      const details = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 180);
      const message = response.status === 403
        ? "GNews rejected the API key or its daily quota is exhausted."
        : response.status === 429
          ? "GNews is rate-limiting requests. Try again later."
          : `GNews returned HTTP ${response.status}.${details ? ` ${details}` : ""}`;
      throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502 });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw Object.assign(new Error("GNews returned invalid JSON."), { status: 502 });
    }
    if (!Array.isArray(payload.articles)) {
      throw Object.assign(new Error("GNews returned an invalid article list."), { status: 502 });
    }
    const seen = new Set();
    const articles = payload.articles.flatMap((article) => {
      let url;
      try {
        url = new URL(article.url || "");
      } catch {
        return [];
      }
      if ((url.protocol !== "https:" && url.protocol !== "http:") || !article.title || seen.has(url.href)) return [];
      seen.add(url.href);
      return [{
        id: `G${seen.size}`,
        title: String(article.title).trim().slice(0, 300),
        description: String(article.description || "").trim().slice(0, 1200),
        content: String(article.content || "").trim().slice(0, 4000),
        url: url.href,
        domain: String(article.source?.name || url.hostname).slice(0, 100),
        date: article.publishedAt || ""
      }];
    }).slice(0, 10);
    cache.set(normalizedQuery, { articles, expiresAt: Date.now() + cacheDurationMs });
    return articles;
  });
  requestQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    send(response, 204, "");
    return;
  }
  if (request.method !== "GET") {
    send(response, 405, "Method not allowed");
    return;
  }

  const url = new URL(request.url, `http://${host}:${port}`);
  if (url.pathname === "/rss") {
    try {
      const xml = await fetchGoogleNewsRss(url.searchParams.get("q"));
      send(response, 200, xml, "application/rss+xml; charset=utf-8");
    } catch (error) {
      send(response, error.status || 502, error.message || "Could not retrieve Google News.");
    }
    return;
  }
  if (url.pathname.startsWith("/kalshi/")) {
    await routeKalshi(url, response);
    return;
  }
  if (url.pathname !== "/search") {
    send(response, 404, "Not found");
    return;
  }
  const query = (url.searchParams.get("q") || "").trim().slice(0, 240);
  if (!query) {
    send(response, 400, "A search query is required");
    return;
  }

  try {
    const articles = await fetchFeed(query);
    send(response, 200, JSON.stringify({ articles }), "application/json; charset=utf-8");
  } catch (error) {
    send(response, error.status || 502, error.message || "Could not retrieve GNews articles");
  }
});

server.listen(port, host, () => {
  console.log(`GNews and Kalshi relay listening on http://${host}:${port}`);
});
