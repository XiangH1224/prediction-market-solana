import { ANALYSIS_PROMPT } from "./analysis-prompt.js";
import { analysisSchema, normalizeAnalysis, prepareEvidence } from "./analysis-contract.js";
const LOCAL_API = "http://127.0.0.1:1234/v1";
const GNEWS_API = "http://127.0.0.1:4178/search";
const KALSHI_PROXY_API = "http://127.0.0.1:4178/kalshi";
const coverageCache = new Map();
const COVERAGE_CACHE_MS = 5 * 60 * 1000;
const NEWS_MIN_INTERVAL_MS = 1500;
let newsNextRequestAt = 0;
let newsRequestQueue = Promise.resolve();

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
    throw new Error("Could not reach the local Kalshi relay. Start it with npm run news:proxy.");
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("The local relay does not support Kalshi market data. Restart it with npm run news:proxy, then click Refresh.");
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

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForNewsSlot() {
  const storage = globalThis.chrome?.storage?.local;
  let persistedNextRequestAt = 0;
  if (storage) {
    try {
      const saved = await storage.get("newsNextRequestAt");
      persistedNextRequestAt = Number(saved.newsNextRequestAt) || 0;
    } catch {
      persistedNextRequestAt = 0;
    }
  }
  const pause = Math.max(0, newsNextRequestAt, persistedNextRequestAt) - Date.now();
  if (pause > 0) await wait(pause);
  newsNextRequestAt = Date.now() + NEWS_MIN_INTERVAL_MS;
  if (storage) {
    try {
      await storage.set({ newsNextRequestAt });
    } catch {
      newsNextRequestAt = Date.now() + NEWS_MIN_INTERVAL_MS;
    }
  }
}

function retryDelay(response) {
  const value = response.headers.get("retry-after");
  if (!value) return 5000;
  const seconds = Number(value);
  const retryAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(value);
  return Math.max(NEWS_MIN_INTERVAL_MS, Number.isFinite(retryAt) ? retryAt - Date.now() : 5000);
}

function requestNewsFeed(url) {
  const request = newsRequestQueue.then(async () => {
    await waitForNewsSlot();
    let response = await fetchNewsResponse(url);
    if (response.status !== 429 && response.status !== 503) return response;

    const pauseAfterLimit = retryDelay(response);
    await wait(pauseAfterLimit);
    await waitForNewsSlot();
    response = await fetchNewsResponse(url);
    return response;
  });
  newsRequestQueue = request.then(() => undefined, () => undefined);
  return request;
}

async function fetchNewsResponse(url) {
  try {
    return await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 20000);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The local GNews relay did not respond within 20 seconds.");
    throw new Error("Could not reach the local GNews relay at 127.0.0.1:4178. Set GNEWS_API_KEY and start it with npm run news:proxy.");
  }
}

function parseNewsDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toISOString();
}

function articleUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    return url;
  } catch {
    return null;
  }
}

export function coverageQueries(event) {
  const original = String(event.newsQuery || event.title || "").trim();
  const topic = String(event.eventTitle || event.title || original).trim();
  const keywords = topic
    .replace(/\b(?:will|would|could|the|a|an|be|is|are|by|before|after|on|in|at|of|to|for|than|above|below|between|over|under|win|wins)\b/gi, " ")
    .replace(/[$€£]?\b\d[\d,.:/-]*%?\b/g, " ")
    .replace(/[?()]/g, " ").replace(/\s+/g, " ").trim();
  return [...new Set([original, topic, keywords].filter(Boolean))];
}

export async function fetchRecentCoverage(event) {
  try {
    const articles = await fetchGNewsCoverage(event);
    if (articles.length) return articles;
  } catch {
    // RSS remains available when the optional GNews relay/key is unavailable.
  }
  for (const query of coverageQueries(event)) {
    const articles = await fetchRssCoverage(query);
    if (articles.length) return articles;
  }
  return [];
}

async function fetchRssCoverage(search) {
  const query = new URLSearchParams({ q: search });
  let response;
  try {
    response = await fetchWithTimeout(`http://127.0.0.1:4178/rss?${query}`, {}, 15000);
  } catch {
    throw new Error("Could not reach the local news relay. Start it with npm run news:proxy, then retry analysis.");
  }
  if (response.status === 404) throw new Error("Restart the local relay with npm run news:proxy to enable Google News RSS, then retry analysis.");
  if (!response.ok) {
    const details = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
    throw new Error(details || `The news relay returned HTTP ${response.status}. Please retry.`);
  }
  const document = new DOMParser().parseFromString(await response.text(), "text/xml");
  if (document.querySelector("parsererror")) throw new Error("Google News returned an unreadable feed. Please retry.");
  const seen = new Set();
  return [...document.querySelectorAll("item")].flatMap((item) => {
    const title = item.querySelector("title")?.textContent?.trim();
    const url = articleUrl(item.querySelector("link")?.textContent || "");
    if (!title || !url || seen.has(title.toLowerCase())) return [];
    seen.add(title.toLowerCase());
    return [{ id: `RSS${seen.size}`, title: title.slice(0, 300), url: url.href,
      domain: item.querySelector("source")?.textContent || url.hostname,
      date: parseNewsDate(item.querySelector("pubDate")?.textContent),
      description: "", content: "", provider: "Google News RSS", searchQuery: search }];
  }).slice(0, 10);
}

async function fetchGNewsCoverage(event) {
  const cacheKey = `gnewsCoverage:${event.newsQuery}`;
  let cached = coverageCache.get(event.newsQuery);
  if ((!cached || cached.expiresAt <= Date.now()) && globalThis.chrome?.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(cacheKey);
      cached = stored[cacheKey];
      if (cached) coverageCache.set(event.newsQuery, cached);
    } catch {
      cached = null;
    }
  }
  if (cached && cached.expiresAt > Date.now()) return cached.articles;

  const query = new URLSearchParams({
    q: event.newsQuery
  });
  const response = await requestNewsFeed(`${GNEWS_API}?${query}`);
  if (!response.ok) {
    const details = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 180);
    if (response.status === 429 || response.status === 503) {
      throw new Error(`GNews is temporarily unavailable or rate-limiting requests. ${details}`);
    }
    throw new Error(`GNews returned HTTP ${response.status}.${details ? ` ${details}` : ""}`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The GNews relay returned invalid JSON.");
  }
  if (!Array.isArray(data.articles)) throw new Error("The GNews relay returned an invalid article list.");
  const seen = new Set();
  const articles = data.articles.flatMap((article) => {
    const url = articleUrl(article.url || "");
    const title = String(article.title || "").trim();
    if (!url || !title || seen.has(url.href)) return [];
    seen.add(url.href);
    return [{
      id: String(article.id || `G${seen.size}`),
      title: title.slice(0, 300),
      description: String(article.description || "").slice(0, 1200),
      content: String(article.content || "").slice(0, 4000),
      url: url.href,
      domain: String(article.domain || url.hostname).slice(0, 100),
      date: parseNewsDate(article.date)
    }];
  }).slice(0, 10);
  cached = { articles, expiresAt: Date.now() + COVERAGE_CACHE_MS };
  coverageCache.set(event.newsQuery, cached);
  if (globalThis.chrome?.storage?.local) {
    try {
      await chrome.storage.local.set({ [cacheKey]: cached });
    } catch {
      coverageCache.set(event.newsQuery, cached);
    }
  }
  return articles;
}

export async function connectLocalModel() {
  let response;
  try {
    response = await fetchWithTimeout(`${LOCAL_API}/models`, { headers: { Accept: "application/json" } }, 5000);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("LM Studio did not respond within 5 seconds. Check that its local server is running.");
    throw new Error("Could not reach LM Studio at 127.0.0.1:1234. Start its local server and check local CORS settings.");
  }
  if (!response.ok) throw new Error(`LM Studio returned HTTP ${response.status} from /v1/models.`);
  const data = await response.json();
  const model = data.data?.find((item) => item.id)?.id;
  if (!model) throw new Error("LM Studio is reachable, but no model is listed. Load a model and try again.");
  return model;
}

function parseModelJson(content) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("The model response was not valid JSON. Try again or use a smaller response.");
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      throw new Error("The model returned malformed structured analysis. Try again.");
    }
  }
}

export async function analyzeLocally({ event, articles, model, previousAnalysis = null }) {
  if (!Array.isArray(articles) || articles.length === 0) {
    throw new Error("No usable news was found for this market. Try again later or select another market.");
  }
  const assessedAt = new Date().toISOString();
  const selected = prepareEvidence(articles, assessedAt);
  if (!selected.length) throw new Error("No usable evidence was supplied for this market.");
  const evidence = selected.map(article => ({
    id:article.id, title:article.title, description:article.description || "",
    content_excerpt:article.content || "", publisher:article.domain, published:article.date,
    url:article.url, discovery_provider:article.provider || "GNews", access:article.access,
    publication_age_hours:article.publicationAgeHours, publication_date_warning:article.publicationDateWarning
  }));
  const system = ANALYSIS_PROMPT + "\n\nAPPLICATION OUTPUT CONTRACT\n" + [
    "Implement the policy above as the JSON schema supplied in response_format; the interface renders the headings and source links. Return only JSON.",
    "You have NO browsing or retrieval tools. Use only the supplied inputs. RSS evidence is headline-only; GNews evidence contains only the supplied excerpts. Do not claim verification beyond those inputs.",
    "probability_percent is P(Yes), or null when not defensible. The interface derives P(No), labels all estimates uncalibrated, and displays market prices separately. Round defensible estimates to multiples of five. Do not put a numerical probability in explanation when probability_percent is null.",
    "method, assumptions and probability_citations must support any numerical forecast. Do not map sentiment or article counts into a probability. Empty strings are permitted when no method exists. Do not claim statistical calibration.",
    "LATEST PRESENTATION REQUIREMENTS OVERRIDE EARLIER OUTPUT LAYOUT: Keep resolution-rule interpretation, intermediate reasoning, search process, and source-screening work in the background unless a material exception is necessary to understand the conclusion.",
    "The interface displays Overall Conclusion first as up to FIVE numbered sentences. It supplies sentence 1: Yes XX% / No XX%, or probability unavailable. explanation supplies up to FOUR concise sentences in order: strongest Yes evidence; strongest No evidence; most important unknown; and the source-based takeaway driving the conclusion. Avoid repetition. Do not invent counterevidence or a numerical probability. If needed state that no strong evidence supports a side.",
    "supports_yes and supports_no contain only the strongest material evidence, each point a short sentence. critical_unknowns has at most three items, each one sentence saying what is unknown and why it matters. sources has at most three entries; point must succinctly highlight the precise fact, number or statement driving the assessment. Prefer primary, authoritative, recent, independent sources.",
    "When previous_analysis is supplied, changed_evidence is one sentence identifying the most important substantive change (not merely changed wording), and change_explanation is one sentence explaining why P(Yes) changed or stayed the same. Compare actual cited evidence, source URLs, assumptions and methods. Do not claim a new event occurred merely because a different source was selected. If no defensible causal explanation exists, say so. Leave both fields empty when there is no previous analysis.",
    "Every evidence point needs source IDs and kind: Verified fact, Reported claim or Inference. Headline claims are reported claims, not independently verified facts. RULES supports settlement definitions only.",
    "sources contains up to three independent news IDs ranked by relevance, with stance and limitations. Include counterevidence when available. Never create source IDs, URLs, or extra retrieved evidence.",
    "The application removes obvious duplicate titles and URLs, but you must still identify syndicated or repeated underlying reports. Publication time is not the event occurrence time. Flag missing event-specific statistics, official releases or live scores when material."
  ].join(" ");
  const price = value => value === null || value === undefined || String(value).trim() === "" || !Number.isFinite(Number(value)) ? null : Number(value);
  const user = JSON.stringify({
    assessment_as_of: assessedAt,
    previous_analysis: previousAnalysis ? {id:previousAnalysis.id, assessment_as_of:previousAnalysis.analysis.assessedAt,
      probability_percent:previousAnalysis.analysis.probabilityPercent, explanation:previousAnalysis.analysis.explanation,
      method:previousAnalysis.analysis.method, assumptions:previousAnalysis.analysis.assumptions,
      supports_yes:previousAnalysis.analysis.supportsYes, supports_no:previousAnalysis.analysis.supportsNo,
      sources:previousAnalysis.analysis.sources, articles:previousAnalysis.articles} : null,
    event: { question:event.title, ticker:event.marketTicker, deadline:event.closes,
      resolution_rules:event.rules, settlement_source:{name:event.sourceName || "Not supplied",url:event.sourceUrl || null} },
    market_data: { yes_bid:price(event.yesBid), yes_ask:price(event.yesAsk), no_bid:price(event.noBid), no_ask:price(event.noAsk), last_yes_trade:price(event.lastPrice),
      quote_as_of:event.quoteFetchedAt || null, units:"USD per contract; prices are NOT model forecasts", trading_costs:null },
    evidence:[{id:"RULES",kind:"event rules",text:event.rules},...evidence]
  });

  let response;
  try {
    response = await fetchWithTimeout(`${LOCAL_API}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 3200,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "market_verdict",
            strict: true,
            schema: analysisSchema(evidence.map(item => item.id))
          }
        },
        messages: [{ role: "system", content: system }, { role: "user", content: user }]
      })
    }, 120000);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Analysis timed out after 120 seconds. Try a smaller model or shorter context.");
    throw new Error("Could not send the analysis to LM Studio. Confirm its local server and CORS settings.");
  }
  if (!response.ok) throw new Error(`LM Studio returned HTTP ${response.status} while analyzing.`);
  const data = await response.json();
  const choice = data.choices?.[0];
  const message = choice?.message;
  const content = [message?.content, message?.reasoning_content]
    .find((value) => typeof value === "string" && value.trim());
  if (typeof content !== "string") throw new Error("LM Studio returned no analysis text.");
  let parsed;
  try {
    parsed = parseModelJson(content);
  } catch (error) {
    if (choice?.finish_reason === "length") {
      throw new Error("LM Studio truncated its response. Try a smaller context or increase the model's available context length.");
    }
    throw error;
  }
  return { ...normalizeAnalysis(parsed, selected, assessedAt), analyzedArticles: selected, comparisonPreviousId:previousAnalysis?.id || null };
}
