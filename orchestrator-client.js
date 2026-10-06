// Client for the FastAPI orchestrator in backend/. It researches and forecasts a market
// (model-written searches, an evidence report, an ensemble of forecast runs, then the edge
// against the live price) and this file reshapes its result for the PredictFlow panel.

// A page served by the backend talks to its own origin; the extension uses the default port.
const BACKEND = globalThis.location?.protocol?.startsWith("http") ? globalThis.location.host : "127.0.0.1:8000";
const BACKEND_HINT = "Start the analysis backend with npm start, then retry.";
const ANALYSIS_TIMEOUT_MS = 10 * 60 * 1000;
const WS_UNAUTHORIZED = 4401;

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "Source"; }
}

function isoDate(value) {
  // GDELT dates arrive as YYYYMMDD.
  const text = String(value || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const date = new Date(text);
  return text && !Number.isNaN(date.getTime()) ? date.toISOString() : "Date unavailable";
}

function firstSentence(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return [...new Intl.Segmenter("en", {granularity:"sentence"}).segment(text)][0]?.segment.trim().slice(0, 320) || "";
}

/** Turns one finished orchestrator analysis into the panel's {analysis, articles}. */
export function fromOrchestrator(data, assessedAt = new Date().toISOString()) {
  const { prediction, decision = null, verdict = {}, sources = [], detail = {} } = data;
  const provider = detail.search_provider || "Web search";
  const articles = sources.filter(source => source?.url).map((source, index) => ({
    id: `S${index + 1}`, title: String(source.title || source.url).slice(0, 300), url: source.url,
    domain: hostname(source.url), date: isoDate(source.date), description: String(source.snippet || ""),
    provider, retrievedAt: assessedAt, access: source.snippet ? "Search snippet only" : "Headline and metadata only"
  }));
  const probabilityPercent = Math.round(prediction.p_true * 100);
  const favored = probabilityPercent > 50 ? "Yes" : probabilityPercent < 50 ? "No" : "Wait";
  const runs = Array.isArray(detail.runs) ? detail.runs : [];
  const selected = articles.slice(0, 3).map(article => ({
    id: article.id, point: firstSentence(article.description) || article.title,
    stance: "Clarifies an unknown", limitation: article.access
  }));
  return {
    articles,
    analysis: {
      assessedAt,
      assessment: favored === "Yes" ? "Favors Yes" : favored === "No" ? "Favors No" : "Mixed",
      // Preselects the purchase outcome: the side with an edge when there is one, else the likelier side.
      verdict: decision?.actionable ? (decision.side === "yes" ? "Yes" : "No") : favored,
      probabilityPercent, probabilityNo: 100 - probabilityPercent,
      confidence: prediction.confidence, decision, invest: Boolean(verdict.invest),
      method: `Median of ${runs.length || 1} forecast run${runs.length === 1 ? "" : "s"} over a research report built from model-written searches.`,
      assumptions: detail.base_rate || "",
      resolutionCondition: detail.rules_check || "", settlementExceptions: "",
      explanation: prediction.rationale,
      // The whole conclusion: whether to buy at this price, then the model's reasoning.
      conclusionLines: [
        verdict.headline ? `${verdict.headline}. ${verdict.detail || ""}`.trim() : "",
        prediction.rationale
      ].filter(Boolean),
      sources: selected, citations: selected.map(source => source.id),
      insufficientEvidence: false, uncalibrated: true,
      changedEvidence: "", changeExplanation: "", comparisonPreviousId: null,
      researchStatus: [
        { source: provider, status: articles.length ? "Retrieved" : "No relevant data", retrievedAt: assessedAt,
          reason: `${articles.length} source${articles.length === 1 ? "" : "s"} from model-written searches.` },
        { source: `Forecast model${detail.model ? ` · ${detail.model}` : ""}`, status: "Done",
          reason: `${runs.length || 1} of ${detail.runs_requested || runs.length || 1} runs · confidence ${Number(prediction.confidence).toFixed(2)}` }
      ]
    }
  };
}

/** Whether the backend is up and able to analyse, as rows for the panel's Sources box. */
export async function fetchOrchestratorStatus() {
  const row = (status, reason = "") => [{ source: "Analysis backend", status, reason }];
  try {
    const response = await fetch(`http://${BACKEND}/health`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return row("Error", `Backend returned HTTP ${response.status}.`);
    const health = await response.json();
    if (health.missing_keys?.length) return row("Not configured", `backend/.env is missing ${health.missing_keys.join(", ")}.`);
    return row("Ready", "Searches the web, writes an evidence report, then forecasts.");
  } catch {
    return row("Offline", BACKEND_HINT);
  }
}

/**
 * Runs the orchestrator's analysis of one market and resolves with {analysis, articles}.
 * `onStatus` receives the stages reached so far as Sources rows.
 */
export function analyzeWithOrchestrator(event, onStatus = () => {}, Socket = globalThis.WebSocket) {
  const ticker = event.marketTicker;
  return new Promise((resolve, reject) => {
    let socket; let settled = false; let started = false; const stages = [];
    const finish = (settle, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { socket?.close(); } catch { /* already closed */ }
      settle(value);
    };
    const timer = setTimeout(() => {
      try { socket.send(JSON.stringify({ type: "cancel_analysis", ticker })); } catch { /* socket gone */ }
      finish(reject, new Error("Analysis was stopped after ten minutes. Try again, or use a faster model."));
    }, ANALYSIS_TIMEOUT_MS);
    try { socket = new Socket(`ws://${BACKEND}/ws`); }
    catch { finish(reject, new Error(`Could not reach the analysis backend. ${BACKEND_HINT}`)); return; }
    socket.onopen = () => socket.send(JSON.stringify({ type: "analyze", ticker }));
    socket.onerror = () => finish(reject, new Error(`Could not reach the analysis backend at ${BACKEND}. ${BACKEND_HINT}`));
    socket.onclose = closing => finish(reject, new Error(closing.code === WS_UNAUTHORIZED
      ? "The analysis backend requires PANEL_TOKEN. Remove it from backend/.env and restart the backend."
      : `The analysis backend disconnected before finishing. ${BACKEND_HINT}`));
    socket.onmessage = message => {
      let payload;
      try { payload = JSON.parse(message.data); } catch { return; }
      const data = payload?.data;
      if (payload?.type !== "analysis" || data?.ticker !== ticker) return;
      if (data.state === "running") {
        started = true;
        if (data.stage && stages.at(-1) !== data.stage) stages.push(data.stage);
        onStatus(stages.map((stage, index) => ({ source: stage, status: index === stages.length - 1 ? "In progress" : "Done" })));
        return;
      }
      // A result that arrives before this request has started is an earlier analysis being replayed on connect.
      if (!started) return;
      if (data.state === "done") {
        try { finish(resolve, fromOrchestrator(data)); }
        catch { finish(reject, new Error("The analysis backend returned an incomplete result. Please retry.")); }
      } else if (data.state === "error") finish(reject, new Error(data.error || "Analysis could not be completed."));
      else if (data.state === "cancelled") finish(reject, new Error("Analysis was cancelled."));
    };
  });
}
