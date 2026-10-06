import { createServer } from "node:http";

const host = "127.0.0.1";
const port = 4178;
const KALSHI_API = "https://external-api.kalshi.com/trade-api/v2";
const kalshiPageCache = new Map();
const kalshiPageCacheMs = 15 * 1000;
const seriesCacheMs = 6 * 60 * 60 * 1000;
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
  if (url.pathname === "/health") {
    send(response, 200, JSON.stringify({ service: "predictflow-relay" }), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname.startsWith("/kalshi/")) {
    await routeKalshi(url, response);
    return;
  }
  send(response, 404, "Not found");
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Stop the older relay with Ctrl+C in its terminal, then run npm start again.`);
    console.error(`To identify the listener: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  } else {
    console.error(`Relay could not start: ${error.code || "unknown error"}`);
  }
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Kalshi market relay listening on http://${host}:${port}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
