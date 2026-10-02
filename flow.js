import { analyzeLocally, connectLocalModel, fetchRecentCoverage } from "./integrations.js";

const events = [
  {
    id: "fed-rate",
    category: "Monetary policy",
    title: "Will the Fed lower its target rate at its next meeting?",
    closes: "Jan 27, 2027",
    newsQuery: '"Federal Reserve" interest rate FOMC',
    priceYes: 38,
    rules: "Yes if the Federal Open Market Committee lowers the federal funds target range at its January 2027 meeting. A change announced after the meeting counts only if the Fed attributes it to that meeting.",
    sourceName: "Federal Reserve: FOMC calendars and statements",
    sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
  },
  {
    id: "cpi",
    category: "Inflation",
    title: "Will year-over-year CPI inflation be below 3% in December 2026?",
    closes: "Jan 13, 2027",
    newsQuery: '"US inflation" CPI prices',
    priceYes: 54,
    rules: "Yes if the initial BLS release for the December 2026 CPI reports 12-month percent change in the all-items CPI-U below 3.0%. Revisions do not change the result.",
    sourceName: "Bureau of Labor Statistics: CPI",
    sourceUrl: "https://www.bls.gov/cpi/"
  },
  {
    id: "pce-inflation",
    category: "Inflation",
    title: "Will year-over-year PCE inflation be below 3% in December 2026?",
    closes: "Jan 28, 2027",
    newsQuery: '"PCE inflation" BEA price index',
    priceYes: 48,
    rules: "Yes if the initial BEA Personal Income and Outlays release for December 2026 reports a 12-month percent change below 3.0% for the PCE price index. Revisions do not change the result.",
    sourceName: "Bureau of Economic Analysis: Personal Income and Outlays",
    sourceUrl: "https://www.bea.gov/data/income-saving/personal-income"
  },
  {
    id: "jobs",
    category: "Employment",
    title: "Will the US unemployment rate be 4.5% or higher in December?",
    closes: "Jan 8, 2027",
    newsQuery: '"US unemployment" jobs labor market',
    priceYes: 31,
    rules: "Yes if the initial BLS Employment Situation release for December 2026 reports a seasonally adjusted civilian unemployment rate of 4.5% or higher. Revisions do not change the result.",
    sourceName: "Bureau of Labor Statistics: Employment Situation",
    sourceUrl: "https://www.bls.gov/news.release/empsit.toc.htm"
  },
  {
    id: "payroll-growth",
    category: "Employment",
    title: "Will US nonfarm payrolls increase by at least 100,000 in January 2027?",
    closes: "Feb 5, 2027",
    newsQuery: '"US jobs report" payrolls employment',
    priceYes: 58,
    rules: "Yes if the initial BLS Employment Situation release for January 2027 reports a seasonally adjusted increase of at least 100,000 in total nonfarm payroll employment from December 2026. Revisions do not change the result.",
    sourceName: "Bureau of Labor Statistics: Employment Situation",
    sourceUrl: "https://www.bls.gov/news.release/empsit.toc.htm"
  },
  {
    id: "jobless-claims",
    category: "Employment",
    title: "Will initial jobless claims exceed 250,000 in the first January 2027 report?",
    closes: "Jan 7, 2027",
    newsQuery: '"weekly jobless claims" US unemployment',
    priceYes: 42,
    rules: "Yes if the first US Department of Labor weekly claims release published in January 2027 reports more than 250,000 seasonally adjusted initial unemployment claims for its covered week. Use the first published value, not later revisions.",
    sourceName: "US Department of Labor: Weekly Claims Data",
    sourceUrl: "https://www.dol.gov/ui/data.pdf"
  },
  {
    id: "gdp",
    category: "Growth",
    title: "Will US real GDP growth exceed 2% in Q4 2026?",
    closes: "Jan 28, 2027",
    newsQuery: '"US GDP" economic growth',
    priceYes: 62,
    rules: "Yes if the BEA's advance estimate reports annualized quarter-over-quarter real GDP growth above 2.0% for 2026 Q4. The advance estimate is the resolution source.",
    sourceName: "Bureau of Economic Analysis: GDP",
    sourceUrl: "https://www.bea.gov/data/gdp/gross-domestic-product"
  },
  {
    id: "treasury-yield",
    category: "Interest rates",
    title: "Will the US 10-year Treasury par yield be above 4% on Dec 31, 2026?",
    closes: "Dec 31, 2026",
    newsQuery: 'US 10-year Treasury yield bond rate',
    priceYes: 47,
    rules: "Yes if the US Treasury's daily par yield curve table reports a 10-year constant maturity yield above 4.00% for December 31, 2026. If no value is posted for that date, use the last preceding business day.",
    sourceName: "US Treasury: Daily Treasury Par Yield Curve Rates",
    sourceUrl: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve"
  },
  {
    id: "retail",
    category: "Consumer spending",
    title: "Will US retail sales rise month over month in November 2026?",
    closes: "Dec 16, 2026",
    newsQuery: '"US retail sales" consumer spending',
    priceYes: 57,
    rules: "Yes if the initial Census Bureau advance monthly retail trade report for November 2026 shows a seasonally adjusted increase in total retail and food services sales from October 2026.",
    sourceName: "US Census Bureau: Advance Monthly Sales",
    sourceUrl: "https://www.census.gov/retail/index.html"
  },
  {
    id: "oil",
    category: "Energy",
    title: "Will WTI crude settle above $80 on Dec 31, 2026?",
    closes: "Dec 31, 2026",
    newsQuery: '"WTI crude oil" price energy',
    priceYes: 24,
    rules: "Yes if the NYMEX front-month WTI crude oil futures contract's official settlement price is greater than $80.00 per barrel on December 31, 2026. If the exchange is closed, use the last preceding settlement.",
    sourceName: "CME Group: Crude Oil futures",
    sourceUrl: "https://www.cmegroup.com/markets/energy/crude-oil/light-sweet-crude.html"
  }
];

const state = {
  stage: "search",
  query: "",
  results: [],
  event: null,
  articles: [],
  coverageError: "",
  analysis: null,
  model: "",
  purchaseOutcome: null,
  quantity: 1,
  busy: false,
  message: "",
  receipt: null
};
const flow = document.querySelector("#flow");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function render() {
  if (state.stage === "search") renderSearch();
  if (state.stage === "selected") renderSelected();
  if (state.stage === "analyzing") renderAnalyzing();
  if (state.stage === "verdict") renderVerdict();
  if (state.stage === "purchase") renderPurchase();
  if (state.stage === "complete") renderComplete();
}

function renderSearch() {
  const visibleEvents = state.query.trim() ? state.results : events;
  const results = visibleEvents.length
    ? `<div class="event-list">${visibleEvents.map((event) => `
      <button class="event-row" type="button" data-event-id="${event.id}">
        <span class="event-row-top"><span class="event-category">${escapeHtml(event.category)}</span><span class="event-deadline">Closes ${escapeHtml(event.closes)}</span></span>
        <h3>${escapeHtml(event.title)}</h3>
        <span class="row-bottom"><span class="event-subtitle">Sample event · resolution rules included</span><span class="price-pill">Yes ¢${event.priceYes}</span></span>
      </button>
    `).join("")}</div>`
    : state.query ? '<p class="empty-note">No sample events match that topic. Try rates, inflation, payrolls, claims, growth, sales, or oil.</p>' : "";
  flow.innerHTML = `
    <div class="flow-step"><span>01</span><span>SEARCH EVENTS</span><span class="step-rule"></span></div>
    <div class="section-heading"><div><p class="eyebrow">PRACTICE MARKETS</p><h2>Find an event</h2></div><span class="count-label">${visibleEvents.length} ${visibleEvents.length === 1 ? "RESULT" : "RESULTS"}</span></div>
    <form id="search-form" class="search-form">
      <label class="search-field"><span class="search-glyph" aria-hidden="true">⌕</span><input id="event-search" type="search" value="${escapeHtml(state.query)}" placeholder="Search a topic" aria-label="Search sample events" autocomplete="off"><kbd>/</kbd></label>
      <button class="primary-button search-submit" type="submit">Search</button>
    </form>
    ${state.message ? `<p class="flow-message" role="status">${escapeHtml(state.message)}</p>` : ""}
    ${results}
  `;
}

function renderSelected() {
  const event = state.event;
  flow.innerHTML = `
    <div class="flow-step"><button class="back-button" data-action="back-search" type="button" aria-label="Back to search">←</button><span>02</span><span>SELECTED EVENT</span><span class="step-rule"></span></div>
    <article class="event-detail">
      <p class="detail-kicker">${escapeHtml(event.category)} · sample event</p>
      <h2>${escapeHtml(event.title)}</h2>
      <div class="detail-grid"><div class="detail-cell"><span class="detail-label">Deadline</span><span class="detail-value">${escapeHtml(event.closes)}</span></div><div class="detail-cell"><span class="detail-label">Sample Yes price</span><span class="detail-value">${event.priceYes}¢</span></div></div>
      <span class="detail-label">Resolution rules</span><p class="detail-value">${escapeHtml(event.rules)}</p>
      <a class="source-link" href="${escapeHtml(event.sourceUrl)}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(event.sourceName)} · official source</span><span aria-hidden="true">↗</span></a>
    </article>
    ${state.coverageError ? `<p class="integration-message is-error" role="alert">${escapeHtml(state.coverageError)} Analysis can continue with the event rules only.</p>` : ""}
    ${state.message ? `<p class="integration-message is-error" role="alert">${escapeHtml(state.message)}</p>` : ""}
    <button id="analyze-event" class="primary-button full-button" type="button">Analyze this event</button>
    <p class="fine-print">Analysis uses Google News headlines and event rules. Linked articles are not opened or read by this panel.</p>
  `;
}

function renderAnalyzing() {
  flow.innerHTML = `
    <div class="flow-step"><span>03</span><span>RESEARCH & ANALYSIS</span><span class="step-rule"></span></div>
    <div class="working-state" role="status"><span class="working-mark"></span><h2>Reviewing the evidence</h2><p>Retrieving relevant headlines and asking the local model to assess the event rules.</p><span class="working-status">${escapeHtml(state.message)}</span></div>
  `;
}

function renderVerdict() {
  const event = state.event;
  const analysis = state.analysis;
  const verdict = analysis.verdict;
  const sources = analysis.citations.map((id) => {
    if (id === "RULES") return `<a class="verdict-source" href="${escapeHtml(event.sourceUrl)}" target="_blank" rel="noopener noreferrer"><strong>Event rules</strong><span>${escapeHtml(event.sourceName)} · official page not fetched ↗</span></a>`;
    const article = state.articles.find((item) => item.id === id);
    return article ? `<a class="verdict-source" href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(article.domain)} · headline only</strong><span>${escapeHtml(article.title)} ↗</span></a>` : "";
  }).filter(Boolean).join("");
  const newsWarning = state.coverageError
    ? `<p class="notice">${escapeHtml(state.coverageError)} This verdict uses event rules only.</p>`
    : state.articles.length
      ? `<p class="fine-print">Google News returned ${state.articles.length} headlines. Headlines and metadata only; linked article text was not retrieved.</p>`
      : '<p class="notice">No relevant Google News headlines were returned. This verdict uses event rules only.</p>';
  flow.innerHTML = `
    <div class="flow-step"><button class="back-button" data-action="back-selected" type="button" aria-label="Back to event">←</button><span>04</span><span>YOUR VERDICT</span><span class="step-rule"></span></div>
    <article class="verdict-sheet">
      <p class="eyebrow">LOCAL AI ANALYSIS · ${escapeHtml(state.model)}</p>
      <span class="verdict-badge verdict-${verdict.toLowerCase()}">${escapeHtml(verdict)}</span>
      <h2>${verdict === "Wait" ? "Evidence is inconclusive" : `Lean: ${escapeHtml(verdict)}`}</h2>
      <p class="verdict-explanation">${escapeHtml(analysis.explanation)}</p>
      <div class="source-list"><h3>Supporting sources</h3>${sources || '<p class="empty-note">The model returned no source citations. Do not treat this verdict as supported by current news.</p>'}</div>
    </article>
    ${newsWarning}
    <div class="decision-actions">
      <button id="practice-purchase" class="primary-button" type="button">Purchase</button>
      <button id="skip-event" class="secondary-button" type="button">Skip</button>
    </div>
  `;
}

function getPriceCents() {
  if (state.purchaseOutcome === "Yes") return state.event.priceYes;
  if (state.purchaseOutcome === "No") return 100 - state.event.priceYes;
  return null;
}

function renderPurchase() {
  const verdict = state.analysis.verdict;
  const priceCents = getPriceCents();
  const totalCents = priceCents === null ? null : priceCents * state.quantity;
  const chooseOutcome = verdict === "Wait" && !state.purchaseOutcome;
  flow.innerHTML = `
    <div class="flow-step"><button class="back-button" data-action="back-verdict" type="button" aria-label="Back to verdict">←</button><span>05</span><span>PURCHASE</span><span class="step-rule"></span></div>
    <article class="event-detail purchase-event"><p class="detail-kicker">${escapeHtml(verdict)} · simulated position</p><h2>${escapeHtml(state.event.title)}</h2></article>
    ${verdict === "Wait" ? `<div class="wait-purchase-choice"><p class="detail-label">Wait means the model has no lean. Choose a side to simulate:</p><div class="outcome-picker" role="group" aria-label="Choose a simulated outcome">${["Yes", "No"].map((outcome) => `<button class="outcome-button ${state.purchaseOutcome === outcome ? "is-selected" : ""}" data-purchase-outcome="${outcome}" type="button" aria-pressed="${state.purchaseOutcome === outcome}" ${state.busy ? "disabled" : ""}>${outcome}</button>`).join("")}</div></div>` : ""}
    <label class="quantity-label" for="quantity-input"><span>Practice quantity</span><input class="quantity-input" id="quantity-input" type="number" min="1" max="1000" step="1" value="${state.quantity}"></label>
    <div class="purchase-quote"><span>${priceCents === null ? "Pretend total" : `Sample ${escapeHtml(state.purchaseOutcome)} price · pretend total`}</span><strong>${priceCents === null ? "Choose Yes or No to see the simulated cost" : `${priceCents}¢ × ${state.quantity} = $${(totalCents / 100).toFixed(2)}`}</strong></div>
    ${state.message ? `<p class="integration-message is-error" role="alert">${escapeHtml(state.message)}</p>` : ""}
    <div class="decision-actions"><button id="complete-simulated-purchase" class="primary-button" type="button" ${state.busy || chooseOutcome ? "disabled" : ""}>${state.busy ? "Completing…" : "Complete purchase"}</button><button id="skip-purchase" class="secondary-button" type="button" ${state.busy ? "disabled" : ""}>Skip</button></div>
    <p class="fine-print">Simulation only. No blockchain transaction is sent.</p>
  `;
}

function renderComplete() {
  flow.innerHTML = `
    <div class="flow-step"><span>06</span><span>PURCHASE COMPLETE</span><span class="step-rule"></span></div>
    <section class="complete-state">
      <div class="receipt-heading"><span class="complete-mark">✓</span><span class="receipt-status">SIMULATED SUCCESS</span></div>
      <p class="eyebrow">SOLANA TRANSACTION SIMULATOR</p>
      <h2>Purchase complete</h2>
      <p>${escapeHtml(state.event.title)}</p>
      <dl><div><dt>Outcome</dt><dd>${escapeHtml(state.purchaseOutcome)}</dd></div><div><dt>Quantity</dt><dd>${state.quantity}</dd></div><div><dt>Position cost</dt><dd>$${(getPriceCents() * state.quantity / 100).toFixed(2)}</dd></div></dl>
      <div class="receipt-details"><div><span>Network</span><strong>Solana Devnet · simulated</strong></div><div><span>Simulation reference</span><strong>${escapeHtml(state.receipt.reference)}</strong></div><div><span>Network fee</span><strong>0 SOL · not broadcast</strong></div></div>
      <p class="fine-print">Simulated locally. No on-chain transaction was created.</p>
      ${state.receipt.saveWarning ? `<p class="notice">${escapeHtml(state.receipt.saveWarning)}</p>` : ""}
      <button id="new-search" class="secondary-button full-button" type="button">Search another topic</button>
    </section>
  `;
}

function searchEvents(query) {
  const normalized = query.trim().toLowerCase();
  state.query = query;
  if (!normalized) {
    state.results = [];
    state.message = "Enter a topic to search the sample events.";
  } else {
    const ignoredTerms = new Set(["a", "an", "and", "at", "for", "in", "is", "of", "on", "the", "to", "us", "will"]);
    const aliases = {
      cut: ["cut", "lower", "reduce", "reduction"],
      cuts: ["cut", "lower", "reduce", "reduction"],
      fed: ["fed", "federal reserve"],
      interest: ["interest", "rate"],
      job: ["job", "employment", "unemployment"],
      jobs: ["job", "employment", "unemployment"],
      rate: ["rate"],
      rates: ["rate"]
    };
    const terms = normalized.split(/\s+/)
      .map((term) => term.replace(/[^a-z0-9%$.-]/g, ""))
      .filter((term) => term && !ignoredTerms.has(term))
      .map((term) => aliases[term] || [term.length > 3 && term.endsWith("s") ? term.slice(0, -1) : term]);
    state.results = events.filter((event) => {
      const searchable = `${event.title} ${event.category} ${event.rules} ${event.sourceName} ${event.newsQuery}`.toLowerCase();
      return terms.every((alternatives) => alternatives.some((term) => searchable.includes(term)));
    });
    state.message = "";
  }
  renderSearch();
  const input = document.querySelector("#event-search");
  input?.focus();
  input?.setSelectionRange(input.value.length, input.value.length);
}

async function analyzeEvent() {
  state.stage = "analyzing";
  state.busy = true;
  state.message = "Searching Google News and checking LM Studio…";
  state.coverageError = "";
  render();
  try {
    const [coverageResult, modelResult] = await Promise.allSettled([
      fetchRecentCoverage(state.event),
      connectLocalModel()
    ]);
    state.articles = coverageResult.status === "fulfilled" ? coverageResult.value : [];
    state.coverageError = coverageResult.status === "rejected" ? coverageResult.reason.message : "";
    if (modelResult.status === "rejected") throw modelResult.reason;
    state.model = modelResult.value;
    state.analysis = await analyzeLocally({ event: state.event, articles: state.articles, model: state.model });
    state.stage = "verdict";
    state.message = "";
  } catch (error) {
    state.stage = "selected";
    state.message = error.message || "Analysis could not be completed.";
  } finally {
    state.busy = false;
    render();
  }
}

async function completeSimulatedPurchase() {
  if (state.busy || !state.purchaseOutcome) return;
  state.busy = true;
  state.message = "Saving your simulated purchase…";
  renderPurchase();
  const priceCents = getPriceCents();
  const receipt = {
    reference: `SIM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    eventId: state.event.id,
    eventTitle: state.event.title,
    outcome: state.purchaseOutcome,
    quantity: state.quantity,
    unitPriceCents: priceCents,
    totalCents: priceCents * state.quantity,
    createdAt: new Date().toISOString(),
    simulated: true,
    onChain: false
  };
  try {
    if (globalThis.chrome?.storage?.local) {
      await chrome.storage.local.set({ lastSimulatedPurchase: receipt });
    }
  } catch {
    receipt.saveWarning = "The purchase is shown for this session but could not be saved to extension storage.";
  }
  state.receipt = receipt;
  state.busy = false;
  state.message = "";
  state.stage = "complete";
  render();
}

function resetFlow(message = "") {
  state.stage = "search";
  state.query = "";
  state.results = [];
  state.event = null;
  state.articles = [];
  state.coverageError = "";
  state.analysis = null;
  state.model = "";
  state.purchaseOutcome = null;
  state.quantity = 1;
  state.message = message;
  state.receipt = null;
  render();
}

flow.addEventListener("submit", (event) => {
  if (event.target.id !== "search-form") return;
  event.preventDefault();
  searchEvents(new FormData(event.target).get("topic")?.toString() || document.querySelector("#event-search").value);
});
flow.addEventListener("input", (event) => {
  if (event.target.id === "event-search") state.query = event.target.value;
  if (event.target.id === "quantity-input") {
    const parsed = Number.parseInt(event.target.value, 10);
    state.quantity = Number.isFinite(parsed) ? Math.min(1000, Math.max(1, parsed)) : 1;
    const total = document.querySelector(".purchase-quote strong");
    if (total && getPriceCents() !== null) total.textContent = `${getPriceCents()}¢ × ${state.quantity} = $${(getPriceCents() * state.quantity / 100).toFixed(2)}`;
  }
});
flow.addEventListener("click", (event) => {
  const eventButton = event.target.closest("[data-event-id]");
  if (eventButton) {
    state.event = events.find((item) => item.id === eventButton.dataset.eventId);
    state.stage = "selected";
    state.message = "";
    render();
    return;
  }
  if (event.target.closest("#analyze-event")) analyzeEvent();
  if (event.target.closest("#practice-purchase")) {
    state.purchaseOutcome = state.analysis.verdict === "Wait" ? null : state.analysis.verdict;
    state.stage = "purchase";
    state.message = "";
    render();
  }
  const purchaseOutcomeButton = event.target.closest("[data-purchase-outcome]");
  if (purchaseOutcomeButton) {
    state.purchaseOutcome = purchaseOutcomeButton.dataset.purchaseOutcome;
    renderPurchase();
  }
  if (event.target.closest("#complete-simulated-purchase")) completeSimulatedPurchase();
  if (event.target.closest("#skip-event")) resetFlow("Skipped. Search for another event.");
  if (event.target.closest("#skip-purchase")) resetFlow("Skipped. No purchase was recorded.");
  if (event.target.closest("#new-search")) resetFlow();
  if (event.target.closest('[data-action="back-search"]')) resetFlow();
  if (event.target.closest('[data-action="back-selected"]')) {
    state.stage = "selected";
    state.message = "";
    render();
  }
  if (event.target.closest('[data-action="back-verdict"]')) {
    state.stage = "verdict";
    state.message = "";
    render();
  }
});

document.addEventListener("keydown", (event) => {
  const activeTag = document.activeElement?.tagName;
  if (event.key === "/" && activeTag !== "INPUT" && activeTag !== "TEXTAREA") {
    event.preventDefault();
    if (state.stage !== "search") resetFlow();
    document.querySelector("#event-search")?.focus();
  }
});

render();
