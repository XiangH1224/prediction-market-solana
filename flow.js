import {
  analyzeWithOrchestrator,
  fetchKalshiEventPage,
  fetchKalshiMarketQuote,
  fetchOrchestratorStatus
} from "./integrations.js";

const ANALYSIS_HISTORY_KEY = "savedMarketAnalyses";
const FOLLOWED_KEY = "followedKalshiMarketTickers";
const CACHED_MARKETS_KEY = "cachedKalshiMarkets";
const SELECTED_REFRESH_MS = 30000;
const PRACTICE_QUOTE_MAX_AGE_MS = 15000;

const state = {
  sourceStatus: [],
  stage: "search",
  view: "markets",
  query: "",
  category: "All categories",
  categories: [],
  markets: [],
  results: [],
  cursor: "",
  hasMore: true,
  loadingMarkets: false,
  searchingMarkets: false,
  searchPages: 0,
  marketError: "",
  marketUpdatedAt: "",
  followed: new Set(),
  event: null,
  refreshingQuote: false,
  quoteFreshConfirmed: false,
  quoteConfirmedAt: 0,
  articles: [],
  coverageError: "",
  analysis: null,
  model: "",
  purchaseOutcome: null,
  quantity: 1,
  busy: false,
  message: "",
  receipt: null,
  history: [],
  analysisId: null,
  savingAnalysis: false,
  simulation: null
};

const flow = document.querySelector("#flow");
let selectedQuoteTimer = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function formatCents(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "—";
  const price = Number(value);
  return Number.isFinite(price) ? `${Math.round(price * 100)}¢` : "—";
}

function formatDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime())
    ? "Not available"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function getOutcomePrice(outcome = state.purchaseOutcome, market = state.event) {
  if (!market || !["Yes", "No"].includes(outcome)) return null;
  const dollars = outcome === "No" ? market.noAsk : market.yesAsk;
  if (dollars === null || dollars === undefined || String(dollars).trim() === "") return null;
  const price = Number(dollars);
  return Number.isFinite(price) && price >= 0 && price <= 1 ? Math.round(price * 100) : null;
}

function clearSelectedQuoteTimer() {
  if (selectedQuoteTimer) clearInterval(selectedQuoteTimer);
  selectedQuoteTimer = null;
}

function syncSelectedQuoteTimer() {
  clearSelectedQuoteTimer();
  if (state.event && ["selected", "purchase"].includes(state.stage)) {
    selectedQuoteTimer = setInterval(() => refreshSelectedQuote({ silent: true }), SELECTED_REFRESH_MS);
  }
}

function searchableText(market) {
  return `${market.title} ${market.subtitle} ${market.marketTicker} ${market.eventTicker} ${market.rules} ${(market.categories || []).join(" ")} ${market.category}`.toLowerCase();
}

function getFilteredMarkets() {
  const terms = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const catalog = new Map(state.markets.map(market=>[market.marketTicker,market]));
  if (state.view === "following") for (const entry of state.history) if (!catalog.has(entry.market.marketTicker)) catalog.set(entry.market.marketTicker,entry.market);
  return [...catalog.values()].filter((market) => {
    if (state.category !== "All categories" && !(market.categories || []).includes(state.category)) return false;
    if (state.view === "following" && !state.followed.has(market.marketTicker)) return false;
    const text = searchableText(market);
    return terms.every((term) => text.includes(term));
  });
}

function render() {
  if (state.stage === "search") renderSearch();
  if (state.stage === "selected") renderSelected();
  if (state.stage === "analyzing") renderAnalyzing();
  if (state.stage === "analysis-error") renderAnalysisError();
  if (state.stage === "verdict") renderVerdict();
  if (state.stage === "purchase") renderPurchase();
  if (state.stage === "simulation") renderSimulation();
  if (state.stage === "complete") renderComplete();
  syncSelectedQuoteTimer();
}

function renderMarketRow(market) {
  const followed = state.followed.has(market.marketTicker);
  return `
    <article class="event-row market-row">
      <button class="market-select" type="button" data-market-ticker="${escapeHtml(market.marketTicker)}">
        <span class="event-row-top"><span class="event-category">${escapeHtml(market.category)}</span><span class="event-deadline">Closes ${escapeHtml(formatDate(market.closes))}</span></span>
        <h3>${escapeHtml(market.title)}</h3>
        <span class="row-bottom"><span class="event-subtitle">${escapeHtml(market.marketTicker)} · Yes ${formatCents(market.yesBid)} / ${formatCents(market.yesAsk)}</span><span class="price-pill">No ${formatCents(market.noBid)} / ${formatCents(market.noAsk)}</span></span>
      </button>
      <button class="follow-button" type="button" data-follow-ticker="${escapeHtml(market.marketTicker)}" aria-pressed="${followed}" aria-label="${followed ? "Unfollow" : "Follow"} ${escapeHtml(market.title)}">${followed ? "Following" : "Follow"}</button>
    </article>
  `;
}

function renderSearch() {
  state.results = getFilteredMarkets();
  const results = state.results.length
    ? `<div class="event-list">${state.results.map(renderMarketRow).join("")}</div>`
    : state.loadingMarkets
      ? '<p class="empty-note">Loading Kalshi events…</p>'
      : state.marketError
        ? `<p class="empty-note" role="alert">${escapeHtml(state.marketError)}</p>`
        : state.view === "following" && !state.followed.size
          ? '<p class="empty-note">Follow markets to keep them here for research.</p>'
          : state.query || state.category !== "All categories"
            ? state.hasMore
              ? '<p class="empty-note">No match yet. Searching more Kalshi events…</p>'
              : '<p class="empty-note">No matching Kalshi markets were found.</p>'
            : '<p class="empty-note">No open Kalshi markets were returned.</p>';

  flow.innerHTML = `
    <div class="flow-step"><span>01</span><span>KALSHI MARKETS</span><span class="step-rule"></span></div>
    <div class="section-heading"><div><p class="eyebrow">PUBLIC MARKET DATA · READ ONLY</p><h2>Find an event</h2></div><div class="market-heading-actions"><span class="count-label">${state.markets.length} LOADED</span><button id="refresh-markets" class="market-refresh" type="button" ${state.loadingMarkets ? "disabled" : ""}>Refresh</button></div></div>
    <div class="market-tabs" role="tablist" aria-label="Market views">
      <button class="market-tab ${state.view === "markets" ? "is-active" : ""}" type="button" data-market-view="markets" role="tab" aria-selected="${state.view === "markets"}">Markets</button>
      <button class="market-tab ${state.view === "following" ? "is-active" : ""}" type="button" data-market-view="following" role="tab" aria-selected="${state.view === "following"}">Following ${state.followed.size ? `(${state.followed.size})` : ""}</button>
    </div>
    <form id="search-form" class="search-form">
      <label class="search-field"><span class="search-glyph" aria-hidden="true">⌕</span><input id="event-search" name="topic" type="search" value="${escapeHtml(state.query)}" placeholder="Search Kalshi markets" aria-label="Search Kalshi markets" autocomplete="off"><kbd>/</kbd></label>
      <button class="primary-button search-submit" type="submit">Search</button>
    </form>
    <label class="category-filter"><span>Category</span><select id="category-filter" aria-label="Filter by Kalshi category"><option value="All categories">All categories</option>${state.categories.map((category) => `<option value="${escapeHtml(category)}" ${state.category === category ? "selected" : ""}>${escapeHtml(category)}</option>`).join("")}</select></label>
    ${state.marketUpdatedAt ? `<p class="market-update">Snapshot updated ${escapeHtml(formatDate(state.marketUpdatedAt))}</p>` : ""}
    ${state.searchingMarkets ? `<p class="market-update" role="status">Searching Kalshi… ${state.searchPages} additional pages checked.</p>` : ""}
    ${state.marketError ? `<p class="integration-message is-error" role="alert">${escapeHtml(state.marketError)}</p>` : ""}
    ${state.message ? `<p class="flow-message" role="status">${escapeHtml(state.message)}</p>` : ""}
    ${results}
    ${state.hasMore && state.view === "markets" ? `<button id="load-more-markets" class="secondary-button full-button" type="button" ${state.loadingMarkets ? "disabled" : ""}>${state.loadingMarkets ? "Loading…" : "Load more markets"}</button>` : ""}
    <p class="fine-print">Kalshi public market data. Quotes are snapshots; no real orders are submitted.</p>
  `;
}

function renderSelected() {
  const market = state.event;
  flow.innerHTML = `
    <div class="flow-step"><button class="back-button" data-action="back-search" type="button" aria-label="Back to markets">←</button><span>02</span><span>SELECTED MARKET</span><span class="step-rule"></span></div>
    <article class="event-detail">
      <p class="detail-kicker">${escapeHtml((market.categories || []).join(" · ") || market.category)} · ${escapeHtml(market.marketTicker)}</p>
      <h2>${escapeHtml(market.title)}</h2>
      ${market.subtitle ? `<p class="detail-value">${escapeHtml(market.subtitle)}</p>` : ""}
      <div class="detail-grid"><div class="detail-cell"><span class="detail-label">Closes</span><span class="detail-value">${escapeHtml(formatDate(market.closes))}</span></div><div class="detail-cell"><span class="detail-label">Yes bid / ask</span><span class="detail-value">${formatCents(market.yesBid)} / ${formatCents(market.yesAsk)}</span></div><div class="detail-cell"><span class="detail-label">No bid / ask</span><span class="detail-value">${formatCents(market.noBid)} / ${formatCents(market.noAsk)}</span></div><div class="detail-cell"><span class="detail-label">Last Yes trade</span><span class="detail-value">${formatCents(market.lastPrice)}</span></div><div class="detail-cell"><span class="detail-label">Quote updated</span><span class="detail-value">${escapeHtml(formatDate(market.quoteFetchedAt))}</span></div></div>
      ${state.message ? `<p class="integration-message" role="status">${escapeHtml(state.message)}</p>` : ""}
      <span class="detail-label">Resolution rules</span><p class="detail-value">${escapeHtml(market.rules)}</p>
      ${market.sourceUrl ? `<a class="source-link" href="${escapeHtml(market.sourceUrl)}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(market.sourceName)} · settlement source</span><span aria-hidden="true">↗</span></a>` : `<p class="fine-print">${escapeHtml(market.sourceName)}.</p>`}
    </article>
    ${state.history.some(entry=>entry.market.marketTicker===market.marketTicker) ? `<details class="saved-analyses"><summary>Saved Analyses</summary>${state.history.filter(entry=>entry.market.marketTicker===market.marketTicker).slice().reverse().map(entry=>`<button type="button" class="secondary-button full-button" data-saved-analysis="${escapeHtml(entry.id)}">${escapeHtml(formatDate(entry.savedAt))} · ${escapeHtml(probabilityLabel(entry.analysis))}</button>`).join("")}</details>` : ""}
    <button id="analyze-event" class="primary-button full-button" type="button" ${state.busy ? "disabled" : ""}>Analyze this market</button>
    ${renderSourceStatus()}
    <p class="fine-print">Analysis uses market rules and recent coverage. No funds move.</p>
  `;
}

function renderSourceStatus() {
  const rows=state.stage === "verdict" ? state.analysis?.researchStatus || state.sourceStatus : state.sourceStatus;
  return `<section class="source-status"><h3>Sources</h3>${rows?.length ? `<ul>${rows.map(row=>`<li><strong>${escapeHtml(row.source)}</strong> <span>${escapeHtml(row.status)}</span>${row.retrievedAt?`<small>Last retrieved: ${escapeHtml(formatDate(row.retrievedAt))}</small>`:''}${row.reason?`<small>${escapeHtml(row.reason)}</small>`:''}</li>`).join('')}</ul>`:'<p class="fine-print">Analyze to retrieve relevant sources.</p>'}</section>`;
}

function renderAnalyzing() {
  flow.innerHTML = `
    <div class="flow-step"><span>03</span><span>RESEARCH & ANALYSIS</span><span class="step-rule"></span></div>
    <div class="working-state" role="status"><span class="working-mark"></span><h2>Reviewing the evidence</h2><p>Your assessment will appear here shortly.</p></div>${renderSourceStatus()}
  `;
}

function renderAnalysisError() {
  flow.innerHTML = `<section class="event-detail"><h2>Analysis could not finish</h2>${renderSourceStatus()}
    <p class="integration-message is-error" role="alert">${escapeHtml(state.message)}</p>
    <button id="analyze-event" class="primary-button full-button" type="button">Retry analysis</button>
    <button class="secondary-button full-button" data-action="back-selected" type="button">Back to market</button></section>`;
}

function conclusionLead(analysis) {
  const probability = analysis.probabilityPercent;
  if (!Number.isInteger(probability)) return "No defensible Yes/No decision — Probability unavailable—insufficient evidence.";
  const decision = probability > 50 ? "Favors Yes" : probability < 50 ? "Favors No" : "No favored side";
  return `${decision} — ${probabilityLabel(analysis)}.`;
}

function conclusionSentences(analysis) {
  // Orchestrator analyses supply their conclusion ready to display.
  if (Array.isArray(analysis.conclusionLines)) return analysis.conclusionLines.slice(0,4);
  if (analysis.conclusion) return ["marketSignal", "counterSignal", "criticalUnknowns", "uncertaintyDecision"]
    .map(key => analysis.conclusion[key]).filter(Boolean)
    .map(value => [...new Intl.Segmenter("en", {granularity:"sentence"}).segment(value)][0]?.segment.trim()).filter(Boolean);
  return [...new Intl.Segmenter("en", {granularity:"sentence"}).segment(analysis.explanation || "")].slice(0,4).map(item=>item.segment.trim());
}

function probabilityLabel(analysis) {
  return Number.isInteger(analysis.probabilityPercent) ? `Yes ${analysis.probabilityPercent}% / No ${100-analysis.probabilityPercent}%` : "Probability unavailable—insufficient evidence";
}

function previousSavedAnalysis() {
  return state.history.filter(entry=>entry.market.marketTicker === state.event?.marketTicker && entry.id !== state.analysisId && (!state.analysis?.assessedAt || entry.analysis.assessedAt <= state.analysis.assessedAt)).at(-1);
}

function renderComparison(previous) {
  const current = state.analysis;
  const selectedSources = entry => (entry.analysis.sources || []).map(source=>entry.articles.find(article=>article.id === source.id)).filter(Boolean);
  const oldSources = selectedSources(previous);
  const newSources = selectedSources({analysis:current, articles:state.articles});
  const added = newSources.filter(article=>!oldSources.some(old=>old.url===article.url));
  const removed = oldSources.filter(article=>!newSources.some(now=>now.url===article.url));
  const oldPoints = [...(previous.analysis.supportsYes || []), ...(previous.analysis.supportsNo || [])].map(point=>point.text);
  const newPoints = [...(current.supportsYes || []), ...(current.supportsNo || [])].map(point=>point.text);
  const changedPoints = newPoints.filter(point=>!oldPoints.includes(point)).slice(0,2);
  const matches = current.comparisonPreviousId === previous.id;
  const reason = matches && current.changeExplanation ? current.changeExplanation : current.probabilityPercent === previous.analysis.probabilityPercent ? "The numerical assessment is unchanged." : "A change is recorded, but its cause was not established against this saved analysis; rerun analysis to assess the difference.";
  const names = values => values.slice(0,2).map(article=>`<a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.domain)} — ${escapeHtml(article.title)}</a>`).join("; ");
  return `<details class="analysis-comparison"><summary>Compare with Previous Analysis</summary><p><strong>${escapeHtml(probabilityLabel(previous.analysis))} → ${escapeHtml(probabilityLabel(current))}</strong></p><p><strong>Changed evidence:</strong> ${escapeHtml(matches && current.changedEvidence ? current.changedEvidence : changedPoints.join(" ") || "No new supporting evidence identified.")}</p><p><strong>Changed sources:</strong> ${added.length || removed.length ? `${added.length ? `Added: ${names(added)}. ` : ""}${removed.length ? `Replaced: ${names(removed)}.` : ""}` : "No change to the selected sources."}</p><p>${escapeHtml(reason)}</p></details>`;
}

function renderVerdict() {
  const analysis = state.analysis;
  const chosen = new Set((analysis.sources || []).map(source=>source.id));
  const additional = state.articles.filter(article=>!chosen.has(article.id));
  const sourceLink = id => { const article = state.articles.find(item=>item.id===id); return article ? `<a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">[${escapeHtml(id)}]</a>` : ""; };
  const points = values => values?.length ? `<ul class="evidence-points">${values.slice(0,3).map(point=>`<li>${escapeHtml(point.text)} ${(point.citations || []).map(sourceLink).join(" ")}</li>`).join("")}</ul>` : '<p class="fine-print">No strong supporting evidence identified.</p>';
  const card = (article, source, index) => `<article class="evidence-card"><strong>${index + 1}. ${escapeHtml(article.domain)} — ${escapeHtml(formatDate(article.date))}</strong><a class="source-link" href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.title)} ↗</a><p>Key evidence: <strong>${escapeHtml(source?.point || article.description || article.title)}</strong></p></article>`;
  const sources = (analysis.sources || []).slice(0,3).map((source,index)=>{ const article=state.articles.find(item=>item.id===source.id); return article ? card(article,source,index) : ""; }).join("");
  const previous = previousSavedAnalysis();
  const saved = state.history.some(entry=>entry.id===state.analysisId);
  // Orchestrator analyses give one conclusion; older saved analyses also carry per-side evidence lists.
  const evidenceSections = !Array.isArray(analysis.conclusionLines);
  flow.innerHTML = `<div class="flow-step"><button class="back-button" data-action="back-selected" type="button" aria-label="Back to market">←</button><span>${escapeHtml(state.event.title)}</span></div>
    <article class="verdict-sheet"><h2>Overall Conclusion</h2><ol class="overall-conclusion"><li><strong>${escapeHtml(conclusionLead(analysis))}</strong></li>${conclusionSentences(analysis).map(sentence=>`<li>${escapeHtml(sentence)}</li>`).join("")}</ol>
    ${evidenceSections ? `<h3>Supports Yes</h3>${points(analysis.supportsYes)}
    <h3>Supports No</h3>${points(analysis.supportsNo)}
    <h3>Critical Unknowns</h3>${analysis.criticalUnknowns?.length ? `<ol>${analysis.criticalUnknowns.slice(0,3).map(item=>`<li>${escapeHtml(item)}</li>`).join("")}</ol>` : '<p class="fine-print">No specific critical unknowns established.</p>'}` : ""}
    <h3>Most Relevant Sources</h3>${sources || '<p class="fine-print">No reliable sources available.</p>'}
    ${additional.length ? `<details><summary>Load More Sources (${additional.length})</summary><p class="fine-print">Already retrieved evidence; expanding this list makes no network request.</p>${additional.map((article,index)=>card(article,null,index+chosen.size)).join("")}</details>` : ""}
    <div class="analysis-history-actions"><button id="save-analysis" type="button" class="secondary-button full-button" ${saved || state.savingAnalysis ? "disabled" : ""}>${state.savingAnalysis ? "Saving…" : saved ? "Analysis Saved" : "Save Analysis"}</button>${previous ? renderComparison(previous) : ""}</div>
    ${state.message ? `<p class="fine-print" role="status">${escapeHtml(state.message)}</p>` : ""}</article>
    ${renderSourceStatus()}
    <div class="decision-actions"><button id="practice-purchase" class="primary-button" type="button">Buy position</button><button id="skip-event" class="secondary-button" type="button">Back to markets</button></div>`;
}

async function saveAnalysis() {
  if (state.savingAnalysis || !state.analysis || !state.event?.marketTicker) return;
  if (state.analysisId && state.history.some(entry=>entry.id===state.analysisId)) return;
  state.savingAnalysis = true;
  state.message = "";
  renderVerdict();
  try {
    if (!globalThis.chrome?.storage?.local) throw new Error("Saving requires the Chrome extension's local storage.");
    const id = state.analysisId || crypto.randomUUID();
    const {analyzedArticles, ...analysis} = state.analysis;
    const entry = { id, savedAt:new Date().toISOString(), market:structuredClone(state.event), analysis:structuredClone(analysis), articles:state.articles.map(({id,title,url,domain,date,provider,publishedAt,observationAt,retrievedAt,vintage,originUrl,access,settlementSource,units,limitations,seasonalAdjustment,frequency})=>({id,title,url,domain,date,provider,publishedAt,observationAt,retrievedAt,vintage,originUrl,access,settlementSource,units,limitations,seasonalAdjustment,frequency})) };
    const stored = await chrome.storage.local.get([ANALYSIS_HISTORY_KEY,FOLLOWED_KEY]);
    const existing = Array.isArray(stored[ANALYSIS_HISTORY_KEY]) ? stored[ANALYSIS_HISTORY_KEY] : state.history;
    const history = [...existing.filter(item=>item.id!==id),entry];
    const followed = new Set([...state.followed,...(stored[FOLLOWED_KEY] || []),state.event.marketTicker]);
    await chrome.storage.local.set({[ANALYSIS_HISTORY_KEY]:history,[FOLLOWED_KEY]:[...followed],cachedKalshiMarkets:state.markets});
    state.history = history; state.followed = followed; state.analysisId = id;
    state.message = "Analysis saved. This event is in Following.";
  } catch (error) { state.message = error.message || "Analysis could not be saved. Please retry."; }
  finally { state.savingAnalysis = false; renderVerdict(); }
}

function renderPurchase() {
  const priceCents = getOutcomePrice();
  const totalCents = priceCents === null ? null : priceCents * state.quantity;
  const chooseOutcome = !state.purchaseOutcome;
  const canConfirm = state.quoteFreshConfirmed && Date.now() - state.quoteConfirmedAt <= PRACTICE_QUOTE_MAX_AGE_MS;
  flow.innerHTML = `
    <div class="flow-step"><button class="back-button" data-action="back-verdict" type="button" aria-label="Back to forecast">←</button><span>04</span><span>PURCHASE CONFIRMATION</span><span class="step-rule"></span></div>
    <article class="event-detail purchase-event"><p class="detail-kicker">${escapeHtml(state.event.marketTicker)}</p><h2>${escapeHtml(state.event.title)}</h2></article>
    <div class="wait-purchase-choice"><p class="detail-label">Choose an outcome</p><div class="outcome-picker" role="group" aria-label="Choose outcome">${["Yes", "No"].map((outcome) => `<button class="outcome-button ${state.purchaseOutcome === outcome ? "is-selected" : ""}" data-purchase-outcome="${outcome}" type="button" aria-pressed="${state.purchaseOutcome === outcome}">${outcome}</button>`).join("")}</div></div>
    <label class="quantity-label" for="quantity-input"><span>Quantity</span><input class="quantity-input" id="quantity-input" type="number" min="1" max="1000" step="1" value="${state.quantity}"></label>
    ${priceCents !== null ? `<div class="purchase-quote"><span>${escapeHtml(state.purchaseOutcome)} position · purchase amount</span><strong>${priceCents}¢ × ${state.quantity} = $${(totalCents / 100).toFixed(2)}</strong><p>Current market price: ${priceCents}¢ (${priceCents}% implied probability) · Estimated position: ${state.quantity} ${escapeHtml(state.purchaseOutcome)} units</p></div>` : state.purchaseOutcome ? '<p class="fine-print" role="status">No price is currently available for this outcome.</p>' : ""}
    <p class="market-update">Quote updated ${escapeHtml(formatDate(state.event.quoteFetchedAt))}</p>
    ${state.message ? `<p class="integration-message ${canConfirm ? "" : "is-error"}" role="status">${escapeHtml(state.message)}</p>` : ""}
    <button id="complete-simulated-purchase" class="primary-button full-button" type="button" ${state.busy || chooseOutcome || priceCents === null ? "disabled" : ""}>Confirm Purchase</button>
    <button id="skip-purchase" class="secondary-button full-button" type="button" ${state.busy ? "disabled" : ""}>Cancel</button>
    <p class="fine-print">No funds move.</p>
  `;
}

function renderComplete() {
  const receipt = state.receipt;
  flow.innerHTML = `<section class="complete-state"><p class="eyebrow">DFLOW · NO FUNDS MOVE</p>
    <div class="complete-mark">✓</div><h2>Purchase complete</h2><p>${escapeHtml(receipt.eventTitle)}</p>
    <dl><div><dt>Outcome</dt><dd>${escapeHtml(receipt.outcome)}</dd></div><div><dt>Received</dt><dd>${receipt.quantity} units</dd></div><div><dt>Total</dt><dd>${(receipt.totalCents / 100).toFixed(2)} USDC</dd></div></dl>
    <div class="receipt-details"><div><span>Reference</span><strong>${escapeHtml(receipt.reference)}</strong></div><div><span>Available balance</span><strong>${((receipt.simulation?.balanceCents || 0) / 100).toFixed(2)} USDC</strong></div><div><span>Completed</span><strong>${escapeHtml(formatDate(receipt.completedAt || receipt.createdAt))}</strong></div></div>
    ${receipt.saveWarning ? `<p role="alert">${escapeHtml(receipt.saveWarning)}</p>` : ""}
    <details><summary>Activity</summary><ol class="simulation-log">${(receipt.simulation?.log || []).map(entry => `<li><strong>${escapeHtml(entry.action)}</strong><p>${escapeHtml(entry.response)}</p></li>`).join("")}</ol></details>
    <div class="decision-actions"><button id="back-buy-position" class="primary-button" type="button">Back to Buy position</button><button id="new-search" class="secondary-button" type="button">Back to markets</button></div></section>`;
}

function searchEvents(query = state.query) {
  state.query = query;
  state.results = getFilteredMarkets();
  state.message = "";
  renderSearch();
  if (!state.results.length && state.view === "markets" && (state.query.trim() || state.category !== "All categories") && state.hasMore) searchRemainingMarkets();
}

async function searchRemainingMarkets() {
  if (state.searchingMarkets || state.loadingMarkets || state.view !== "markets") return;
  state.searchingMarkets = true;
  state.searchPages = 0;
  renderSearch();
  try {
    while (!getFilteredMarkets().length && state.hasMore && (state.query.trim() || state.category !== "All categories")) {
      const page = await fetchKalshiEventPage(state.cursor);
      appendMarketPage(page);
      state.searchPages += 1;
      state.results = getFilteredMarkets();
      renderSearch();
    }
  } catch (error) {
    state.marketError = error.message || "Kalshi search could not be completed.";
  } finally {
    state.searchingMarkets = false;
    renderSearch();
  }
}

function appendMarketPage(page) {
  const existing = new Set(state.markets.map((market) => market.marketTicker));
  state.markets.push(...page.markets.filter((market) => !existing.has(market.marketTicker)));
  state.categories = [...new Set([...state.categories, ...page.categories])].sort((left, right) => left.localeCompare(right));
  state.cursor = page.cursor;
  state.hasMore = Boolean(page.cursor);
  state.marketUpdatedAt = page.fetchedAt;
  saveMarketSnapshot();
}

async function loadMoreMarkets() {
  if (state.loadingMarkets || state.searchingMarkets || !state.hasMore) return;
  state.loadingMarkets = true;
  state.marketError = "";
  renderSearch();
  try {
    const page = await fetchKalshiEventPage(state.cursor);
    appendMarketPage(page);
    state.results = getFilteredMarkets();
  } catch (error) {
    state.marketError = error.message || "Kalshi markets could not be loaded.";
  } finally {
    state.loadingMarkets = false;
    renderSearch();
    if (!state.results.length && state.view === "markets" && (state.query.trim() || state.category !== "All categories") && state.hasMore) searchRemainingMarkets();
  }
}

async function saveMarketSnapshot() {
  if (!globalThis.chrome?.storage?.local) return;
  try {
    await chrome.storage.local.set({
      cachedKalshiMarkets: state.markets,
      followedKalshiMarketTickers: [...state.followed]
    });
  } catch {
    state.message = "Market data is available for this session but could not be saved locally.";
  }
}

function updateMarket(market) {
  state.event = market;
  const index = state.markets.findIndex((item) => item.marketTicker === market.marketTicker);
  if (index >= 0) state.markets[index] = market;
  state.marketUpdatedAt = market.quoteFetchedAt;
  saveMarketSnapshot();
}

async function refreshSelectedQuote({ silent = false } = {}) {
  const selectedMarket = state.event;
  if (!selectedMarket || state.refreshingQuote === selectedMarket) return null;
  state.refreshingQuote = selectedMarket;
  if (!silent) {
    state.message = "Refreshing Kalshi quote…";
    if (state.stage === "selected") renderSelected();
    if (state.stage === "purchase") renderPurchase();
  }
  try {
    const fresh = await fetchKalshiMarketQuote(selectedMarket);
    if (state.event !== selectedMarket) return null;
    updateMarket({ ...selectedMarket, ...fresh });
    state.quoteFreshConfirmed = true;
    state.quoteConfirmedAt = Date.now();
    state.message = silent ? "" : "Quote refreshed. Review the updated price.";
    return state.event;
  } catch (error) {
    if (state.event === selectedMarket) state.quoteFreshConfirmed = false;
    if (!silent && state.event === selectedMarket) state.message = error.message || "Could not refresh the quote.";
    return null;
  } finally {
    if (state.refreshingQuote === selectedMarket) {
      state.refreshingQuote = false;
      if (state.stage === "selected") renderSelected();
      if (state.stage === "purchase") renderPurchase();
    }
  }
}

async function analyzeEvent() {
  if (state.busy || !state.event) return;
  state.analysisId = null;
  state.message = "";
  state.stage = "analyzing";
  state.busy = true;
  state.coverageError = "";
  state.sourceStatus = [];
  render();
  try {
    // Research and forecasting run in the local orchestrator (backend/); the panel only displays the result.
    const result = await analyzeWithOrchestrator(state.event, rows=>{state.sourceStatus=rows;if(state.stage==="analyzing")renderAnalyzing();});
    state.articles = result.articles;
    state.analysis = result.analysis;
    state.model = "";
    state.stage = "verdict";
    state.message = "";
  } catch (error) {
    state.stage = "analysis-error";
    state.message = error.message || "Analysis could not be completed.";
  } finally {
    state.busy = false;
    render();
  }
}

function buildSimulatedDFlowRoute({ marketTicker, outcome, quantity, unitPriceCents, quoteFetchedAt }) {
  if (!marketTicker || !["Yes", "No"].includes(outcome) || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000 || !Number.isInteger(unitPriceCents) || unitPriceCents < 0 || unitPriceCents > 100) {
    throw new Error("Select a valid market, outcome, quantity, and price.");
  }
  return {
    provider: "DFlow", mode: "simulation", status: "preview-only",
    marketTicker, outcome, quoteFetchedAt, quoteSource: "Kalshi snapshot",
    input: { asset: "USDC", simulated: true, amountBaseUnits: String(unitPriceCents * quantity * 10000), decimals: 6, mint: null },
    output: { outcome, quantity, simulated: true, mint: null },
    fees: null, slippageBps: null, liquidityVerified: false,
    executable: false, orderSent: false, transaction: null, signature: null,
    steps: [
      { label: "1. Simulated funding", detail: `${(unitPriceCents * quantity / 100).toFixed(2)} USDC from a practice balance; no wallet debit.`, status: "simulated" },
      { label: "2. DFlow routing preview", detail: `Illustrative route to ${marketTicker}, ${outcome} outcome; no DFlow request.`, status: "simulated" },
      { label: "3. Simulated outcome", detail: `${quantity} practice outcome units recorded locally; no execution or token minting.`, status: "simulated" }
    ]
  };
}

async function completeSimulatedPurchase() {
  if (state.busy || state.refreshingQuote || !state.purchaseOutcome || state.stage !== "purchase") return;
  if (!state.quoteFreshConfirmed || Date.now() - state.quoteConfirmedAt > PRACTICE_QUOTE_MAX_AGE_MS) {
    const previousPrice = getOutcomePrice();
    const ticker = state.event.marketTicker;
    state.busy = true;
    state.message = "";
    renderPurchase();
    const fresh = await refreshSelectedQuote({ silent: true });
    state.busy = false;
    if (state.stage !== "purchase" || state.event?.marketTicker !== ticker) return;
    if (!fresh) {
      state.quoteFreshConfirmed = false;
      state.message = "Quote refresh failed. No purchase was recorded.";
      renderPurchase();
      return;
    }
    state.quoteFreshConfirmed = true;
    state.quoteConfirmedAt = Date.now();
    if (getOutcomePrice() !== previousPrice) {
      state.message = "The price changed. Review the updated total, then confirm.";
      renderPurchase();
      return;
    }
  }

  const unitPriceCents = getOutcomePrice();
  if (unitPriceCents === null) {
    state.message = "No executable quote is available. No purchase was recorded.";
    renderPurchase();
    return;
  }
  const receipt = {
    reference: `ORDER-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    marketTicker: state.event.marketTicker,
    eventTicker: state.event.eventTicker,
    eventTitle: state.event.title,
    outcome: state.purchaseOutcome,
    quantity: state.quantity,
    unitPriceCents,
    totalCents: unitPriceCents * state.quantity,
    quoteFetchedAt: state.event.quoteFetchedAt,
    createdAt: new Date().toISOString(),
    simulated: true,
    onChain: false,
    orderSent: false
  };
  try {
    receipt.route = buildSimulatedDFlowRoute(receipt);
  } catch (error) {
    state.message = error.message;
    renderPurchase();
    return;
  }
  clearSelectedQuoteTimer();
  state.receipt = receipt;
  state.quoteFreshConfirmed = false;
  state.simulation = {
    step: "wallet", scenario: "success", balanceCents: 100000, reservedCents: 0,
    position: 0, signature: null, orderId: null, log: [], expiresAt: 0
  };
  state.stage = "simulation";
  logSimulation("User", "Confirmed purchase details", "System", "Purchase details ready for wallet connection.");
  render();
}

function logSimulation(actor, action, responder, response) {
  state.simulation.log.push({ action: `${actor}: ${action}`, response: `${responder}: ${response}` });
}

function renderSimulation() {
  const sim = state.simulation;
  const receipt = state.receipt;
  const steps = ["wallet", "routing", "quote", "approval", "submitting", "submitted", "settled"];
  const labels = ["Wallet", "Route", "Review", "Approve", "Submit", "Process", "Result"];
  const button = (action, label, secondary = false) => `<button type="button" class="${secondary ? "secondary" : "primary"}-button full-button" data-sim-action="${action}">${label}</button>`;
  const cost = (receipt.totalCents / 100).toFixed(2);
  const summary = `<div class="order-summary"><div><span>You pay</span><strong>${cost} USDC</strong></div><div><span>You receive</span><strong>${receipt.quantity} ${escapeHtml(receipt.outcome)} units</strong></div><div><span>Price per unit</span><strong>${receipt.unitPriceCents}¢</strong></div><div><span>Network</span><strong>Solana</strong></div><div><span>Routing</span><strong>DFlow</strong></div><div><span>Network fee</span><strong>Not charged</strong></div></div>`;
  let content = "";
  if (sim.step === "wallet") content = `<h2>Connect wallet</h2><p>Choose an account to continue.</p><button type="button" class="wallet-option" data-sim-action="select-wallet"><span class="wallet-icon">◈</span><span><strong>Solana wallet</strong><small>Account 1 · USDC</small></span><span>→</span></button>`;
  if (sim.step === "connection") content = `<div class="wallet-dialog"><p class="eyebrow">WALLET CONNECTION</p><h2>Connect to PredictFlow?</h2><p>Account 1</p><p>Allow PredictFlow to view your balance and request transaction approval. Each purchase requires your confirmation.</p>${button("connect", "Connect")}${button("cancel", "Cancel", true)}</div>`;
  if (sim.step === "routing") content = `<div class="working-state" role="status"><span class="working-mark"></span><h2>Preparing DFlow route</h2><p>USDC → ${escapeHtml(receipt.outcome)} outcome · ${escapeHtml(receipt.marketTicker)}</p></div>`;
  if (sim.step === "quote") content = `<h2>Review order</h2>${summary}<p class="fine-print">Quote expires ${escapeHtml(formatDate(sim.expiresAt))}. Prices can change before approval.</p>${button("review", "Continue")}${button("edit", "Edit purchase", true)}`;
  if (sim.step === "insufficient") content = `<h2>Insufficient USDC</h2><p>This order needs ${cost} USDC. Your available balance is ${(sim.balanceCents / 100).toFixed(2)} USDC.</p>${button("edit", "Change amount")}${button("cancel", "Cancel", true)}`;
  if (sim.step === "expired") content = `<h2>Quote expired</h2><p>Review an updated quote before approving your purchase.</p>${button("requote", "Get new quote")}`;
  if (sim.step === "approval") content = `<div class="wallet-dialog"><p class="eyebrow">ACCOUNT 1 · APPROVAL REQUEST</p><h2>Approve purchase?</h2>${summary}<p>You authorize the amount shown above.</p>${button("approve", "Approve")}${button("reject", "Reject", true)}</div>`;
  if (sim.step === "submitting") content = `<div class="working-state" role="status"><span class="working-mark"></span><h2>Submitting transaction</h2><p>Wallet approval received. Preparing the Solana order.</p></div>`;
  if (sim.step === "submitted") content = `<div class="working-state" role="status"><span class="working-mark"></span><h2>Processing order</h2><p>Order submitted. Waiting for the route to fill your ${escapeHtml(receipt.outcome)} position.</p></div>`;
  if (sim.step === "settlement") content = `<div class="working-state" role="status"><span class="working-mark"></span><h2>Finalizing purchase</h2><p>Order filled. Updating your balance and position.</p></div>`;
  if (sim.step === "settled") content = `<div class="complete-mark">✓</div><h2>Purchase complete</h2><p>${sim.position} ${escapeHtml(receipt.outcome)} units added to your position.</p>${summary}${button("receipt", "View receipt")}`;
  if (sim.step === "failed") content = `<h2>Order could not be filled</h2><p>Your reserved USDC has been released. No position was added.</p>${button("requote", "Try again")}`;
  if (sim.step === "cancelled") content = `<h2>Purchase cancelled</h2><p>No position was added. Your available balance is unchanged.</p>${button("requote", "Try again")}`;
  flow.innerHTML = `<section class="event-detail"><div class="checkout-heading"><p class="eyebrow">DFLOW · SOLANA</p><span class="no-funds-badge">No funds move</span></div><h3>${escapeHtml(receipt.eventTitle)}</h3>
    <ol class="simulation-progress">${labels.map((label, i) => `<li ${(steps[i] === sim.step || (steps[i] === "wallet" && sim.step === "connection") || (steps[i] === "submitted" && sim.step === "settlement")) ? 'aria-current="step"' : ''}>${label}</li>`).join("")}</ol>
    <div aria-live="polite" aria-atomic="true">${content}</div>
    ${["wallet", "quote", "expired"].includes(sim.step) ? button("cancel", "Cancel", true) : ""}
    ${["cancelled", "failed"].includes(sim.step) ? button("exit", "Back to markets", true) : ""}
    <div class="order-summary"><div><span>Available</span><strong>${(sim.balanceCents / 100).toFixed(2)} USDC</strong></div>${sim.reservedCents ? `<div><span>Reserved</span><strong>${(sim.reservedCents / 100).toFixed(2)} USDC</strong></div>` : ""}</div>
    <details><summary>Activity</summary><ol class="simulation-log">${sim.log.map(entry => `<li><strong>${escapeHtml(entry.action)}</strong><p>${escapeHtml(entry.response)}</p></li>`).join("")}</ol></details></section>`;
}

function runPurchaseTransitions() {
  const session = state.simulation;
  if (!session || state.stage !== "simulation" || !["routing", "submitting", "submitted", "settlement"].includes(session.step)) return;
  const expected = session.step;
  setTimeout(async () => {
    if (state.stage !== "simulation" || state.simulation !== session || session.step !== expected) return;
    await advanceSimulation({routing:"route-ready", submitting:"submit", submitted:"fill", settlement:"settle"}[expected]);
    runPurchaseTransitions();
  }, 1400);
}

async function advanceSimulation(action) {
  if (state.stage !== "simulation" || state.busy) return;
  const sim = state.simulation;
  const cost = state.receipt.totalCents;
  const quote = () => { sim.step = "quote"; sim.expiresAt = Date.now() + 60000; };
  const record = (response) => logSimulation(["fill", "settle"].includes(action) ? "System" : "You", action, "Order status", response);
  if (action === "select-wallet" && sim.step === "wallet") {
    sim.step = "connection"; record("Account selected; connection approval requested.");
  } else if (action === "edit" && ["quote", "insufficient"].includes(sim.step)) {
    state.stage = "purchase"; state.message = ""; state.quoteFreshConfirmed = false; render(); refreshSelectedQuote({silent: true}); return;
  } else if (action === "connect" && ["wallet", "connection"].includes(sim.step)) {
    if (sim.scenario === "insufficient") sim.balanceCents = 0;
    sim.step = "routing";
    record("Wallet connected. Preparing the USDC-to-outcome route.");
  } else if (action === "route-ready" && sim.step === "routing") {
    quote();
    if (sim.scenario === "expired") sim.expiresAt = 0;
    record("Route ready. Review the quote before wallet approval.");
  } else if (action === "review" && sim.step === "quote") {
    sim.step = Date.now() >= sim.expiresAt ? "expired" : sim.balanceCents < cost ? "insufficient" : "approval";
    record(sim.step === "approval" ? "Quote accepted; waiting for wallet approval." : `Cannot continue: ${sim.step}.`);
  } else if (action === "fund" && sim.step === "insufficient") {
    sim.balanceCents += Math.max(100000, cost - sim.balanceCents); quote(); record("Balance updated; quote ready.");
  } else if (action === "requote" && ["expired", "failed", "cancelled"].includes(sim.step)) {
    sim.scenario = "success"; sim.signature = null; sim.orderId = null; sim.step = "routing"; record("Preparing a new route. Approval required again.");
  } else if (action === "approve" && sim.step === "approval") {
    if (Date.now() >= sim.expiresAt) { sim.step = "expired"; record("Quote expired before approval; no funds reserved."); }
    else if (sim.balanceCents < cost) { sim.step = "insufficient"; record("Insufficient funds; no order created."); }
    else {
      sim.signature = `DEMO-SIGNATURE-${crypto.randomUUID()}`;
      sim.orderId = `DEMO-ORDER-${crypto.randomUUID()}`;
      sim.balanceCents -= cost; sim.reservedCents = cost; sim.step = "submitting";
      record("Approval received; order processing. USDC reserved.");
    }
  } else if (action === "submit" && sim.step === "submitting") {
    sim.step = "submitted"; record("Order submitted. Waiting for execution.");
  } else if (action === "fill" && sim.step === "submitted") {
    if (sim.scenario === "failed") { sim.balanceCents += sim.reservedCents; sim.reservedCents = 0; sim.step = "failed"; record("Fill failed; reserved USDC released."); }
    else { sim.step = "settlement"; record("Order filled. Settlement pending."); }
  } else if (action === "settle" && sim.step === "settlement") {
    sim.reservedCents = 0; sim.position = state.receipt.quantity; sim.step = "settled";
    record("Purchase completed; position updated.");
    state.receipt.route.status = "simulated-settled";
    state.receipt.completedAt = new Date().toISOString();
    state.receipt.simulation = structuredClone(sim);
    state.busy = true;
    try {
      if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({lastSimulatedPurchase: state.receipt});
    } catch { state.receipt.saveWarning = "Receipt could not be saved. Keep this page open to view the details."; }
    finally { state.busy = false; }
  } else if ((action === "reject" && sim.step === "approval") || (action === "cancel" && !["settled", "cancelled", "failed"].includes(sim.step))) {
    sim.balanceCents += sim.reservedCents; sim.reservedCents = 0; sim.step = "cancelled";
    record("Purchase cancelled; reserved USDC released.");
  } else if (action === "exit" && ["cancelled", "failed"].includes(sim.step)) {
    state.stage = "search"; state.event = null; state.receipt = null; state.simulation = null; state.message = ""; render(); return;
  } else if (action === "receipt" && sim.step === "settled") {
    state.stage = "complete"; render(); return;
  } else return;
  renderSimulation();
}

async function bootstrap() {
  if (globalThis.chrome?.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(["cachedKalshiMarkets", FOLLOWED_KEY, ANALYSIS_HISTORY_KEY]);
      state.history = Array.isArray(stored[ANALYSIS_HISTORY_KEY]) ? stored[ANALYSIS_HISTORY_KEY].filter(entry=>entry?.market?.marketTicker && entry?.analysis && Array.isArray(entry.articles)) : [];
      state.markets = Array.isArray(stored.cachedKalshiMarkets) ? stored.cachedKalshiMarkets : [];
      state.followed = new Set(Array.isArray(stored[FOLLOWED_KEY]) ? stored[FOLLOWED_KEY] : []);
      state.categories = [...new Set(state.markets.flatMap((market) => market.categories || []))].sort((left, right) => left.localeCompare(right));
      state.results = getFilteredMarkets();
    } catch {
      state.markets = [];
    }
  }
  renderSearch();
  loadMoreMarkets();
}

flow.addEventListener("submit", (event) => {
  if (event.target.id !== "search-form") return;
  event.preventDefault();
  searchEvents(new FormData(event.target).get("topic")?.toString() || "");
});

flow.addEventListener("change", (event) => {
  if (event.target.id === "simulation-scenario" && state.simulation?.step === "wallet") state.simulation.scenario = event.target.value;
  if (event.target.id === "category-filter") {
    state.category = event.target.value;
    searchEvents();
  }
  if (event.target.id === "quantity-input") {
    const parsed = Number.parseInt(event.target.value, 10);
    state.quantity = Number.isFinite(parsed) ? Math.min(1000, Math.max(1, parsed)) : 1;
    if (state.stage === "purchase") renderPurchase();
  }
});

flow.addEventListener("input", (event) => {
  if (event.target.id === "event-search") state.query = event.target.value;
});

flow.addEventListener("click", async (event) => {
  if (state.busy || state.savingAnalysis) return;
  if (event.target.closest("#save-analysis")) { await saveAnalysis(); return; }
  const savedButton = event.target.closest("[data-saved-analysis]");
  if (savedButton) {
    const entry = state.history.find(item=>item.id === savedButton.dataset.savedAnalysis);
    if (entry) { state.event=structuredClone(entry.market); state.analysis=structuredClone(entry.analysis); state.articles=structuredClone(entry.articles); state.analysisId=entry.id; state.stage="verdict"; state.message=""; render(); }
    return;
  }
  const simButton = event.target.closest("[data-sim-action]");
  if (simButton) { await advanceSimulation(simButton.dataset.simAction); runPurchaseTransitions(); return; }
  const marketButton = event.target.closest("[data-market-ticker]");
  if (marketButton) {
    state.event = state.markets.find((market) => market.marketTicker === marketButton.dataset.marketTicker) || state.history.find(entry=>entry.market.marketTicker===marketButton.dataset.marketTicker)?.market;
    if (!state.event) return;
    state.stage = "selected";
    state.sourceStatus = [];
    const sourceTicker=state.event.marketTicker;
    fetchOrchestratorStatus().then(rows=>{if(state.event?.marketTicker===sourceTicker && state.stage==="selected"){state.sourceStatus=rows;renderSelected();}}).catch(()=>{});
    state.message = "";
    state.quoteFreshConfirmed = false;
    render();
    refreshSelectedQuote({ silent: true });
    return;
  }
  const followButton = event.target.closest("[data-follow-ticker]");
  if (followButton) {
    const ticker = followButton.dataset.followTicker;
    if (state.followed.has(ticker)) state.followed.delete(ticker);
    else state.followed.add(ticker);
    await saveMarketSnapshot();
    renderSearch();
    return;
  }
  const viewButton = event.target.closest("[data-market-view]");
  if (viewButton) {
    state.view = viewButton.dataset.marketView;
    state.query = "";
    state.results = getFilteredMarkets();
    renderSearch();
    return;
  }
  if (event.target.closest("#refresh-markets")) {
    state.markets = [];
    state.cursor = "";
    state.hasMore = true;
    state.marketUpdatedAt = "";
    loadMoreMarkets();
    return;
  }
  if (event.target.closest("#load-more-markets")) {
    loadMoreMarkets();
    return;
  }
  if (event.target.closest("#analyze-event")) {
    analyzeEvent();
    return;
  }
  if (event.target.closest("#practice-purchase") || event.target.closest("#back-buy-position")) {
    const returningToPurchase = Boolean(event.target.closest("#back-buy-position"));
    state.purchaseOutcome = returningToPurchase ? state.receipt.outcome : state.analysis.verdict === "Wait" ? "Yes" : state.analysis.verdict;
    state.receipt = null;
    state.simulation = null;
    state.quoteFreshConfirmed = false;
    state.quoteConfirmedAt = 0;
    state.stage = "purchase";
    state.message = "";
    render();
    return;
  }
  const outcomeButton = event.target.closest("[data-purchase-outcome]");
  if (outcomeButton) {
    state.purchaseOutcome = outcomeButton.dataset.purchaseOutcome;
    state.quoteFreshConfirmed = false;
    state.message = "";
    renderPurchase();
    return;
  }
  if (event.target.closest("#complete-simulated-purchase")) {
    await completeSimulatedPurchase();
    return;
  }
  if (event.target.closest("#skip-purchase")) {
    clearSelectedQuoteTimer();
    state.stage = "verdict"; state.message = ""; render(); return;
  }
  if (event.target.closest("#skip-event") || event.target.closest("#new-search")) {
    clearSelectedQuoteTimer();
    state.stage = "search";
    state.event = null;
    state.articles = [];
    state.coverageError = "";
    state.analysis = null;
    state.model = "";
    state.purchaseOutcome = null;
    state.quantity = 1;
    state.message = "";
    state.receipt = null;
    renderSearch();
    return;
  }
  if (event.target.closest('[data-action="back-search"]')) {
    clearSelectedQuoteTimer();
    state.stage = "search";
    state.event = null;
    state.message = "";
    renderSearch();
    return;
  }
  if (event.target.closest('[data-action="back-selected"]')) {
    state.stage = "selected";
    state.message = "";
    render();
    return;
  }
  if (event.target.closest('[data-action="back-verdict"]')) {
    state.stage = "verdict";
    state.message = "";
    render();
  }
});

document.addEventListener("keydown", (event) => {
  if (state.busy || state.savingAnalysis || state.stage === "simulation") return;
  const activeTag = document.activeElement?.tagName;
  if (event.key === "/" && activeTag !== "INPUT" && activeTag !== "TEXTAREA" && activeTag !== "SELECT") {
    event.preventDefault();
    if (state.stage !== "search") {
      state.stage = "search";
      clearSelectedQuoteTimer();
      renderSearch();
    }
    document.querySelector("#event-search")?.focus();
  }
});

bootstrap();
