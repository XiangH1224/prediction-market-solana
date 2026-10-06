// Market data for the panel comes from the local Kalshi relay; analysis comes from the orchestrator in backend/.
export { analyzeWithOrchestrator, fetchOrchestratorStatus } from "./orchestrator-client.js";
const KALSHI_PROXY_API = "http://127.0.0.1:4178/kalshi";

export async function fetchKalshiEventPage(cursor = "") {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  let response;
  try {
    response = await fetchWithTimeout(`${KALSHI_PROXY_API}/events?${params}`, {
      headers: { Accept: "application/json" }
    }, 15000);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Kalshi market data timed out. Try refreshing in a moment.");
    throw new Error("Could not reach the local Kalshi relay. Start it with npm start.");
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("The local relay does not support Kalshi market data. Restart it with npm start, then click Refresh.");
    }
    const details = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 180);
    throw new Error(`Kalshi market data returned HTTP ${response.status}.${details ? ` ${details}` : ""}`);
  }
  const page = await response.json();
  if (!Array.isArray(page.markets) || !Array.isArray(page.categories)) {
    throw new Error("The Kalshi relay returned an invalid market page.");
  }
  return page;
}

export async function fetchKalshiMarketQuote(market) {
  const params = new URLSearchParams({
    ticker: market.marketTicker,
    series_ticker: market.seriesTicker || ""
  });
  let response;
  try {
    response = await fetchWithTimeout(`${KALSHI_PROXY_API}/market?${params}`, {
      headers: { Accept: "application/json" }
    }, 12000);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The fresh Kalshi quote timed out. No practice purchase was recorded.");
    throw new Error("Could not refresh the Kalshi quote. No practice purchase was recorded.");
  }
  if (!response.ok) {
    const details = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 180);
    throw new Error(`Kalshi quote refresh returned HTTP ${response.status}.${details ? ` ${details}` : ""} No practice purchase was recorded.`);
  }
  const data = await response.json();
  if (!data.market || data.market.marketTicker !== market.marketTicker) {
    throw new Error("Kalshi returned no matching market quote. No practice purchase was recorded.");
  }
  return data.market;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
