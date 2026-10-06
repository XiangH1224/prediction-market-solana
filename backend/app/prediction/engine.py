import asyncio
import json
from collections.abc import Awaitable, Callable
import logging
import statistics
import time
from datetime import datetime, timezone

import httpx
from openai import AsyncOpenAI, BadRequestError, RateLimitError
from pydantic import BaseModel, Field

from ..config import Settings
from ..market.select import days_to_close
from ..models import Market, Prediction
from .search import date_fenced_search

log = logging.getLogger(__name__)

RESEARCH_SNIPPET_CHARS = 500

# Runs that disagree by this much or more carry no confidence at all.
MAX_USEFUL_SPREAD = 0.30

SYSTEM_PROMPT = """You are a calibrated forecaster for binary prediction markets. Estimate the \
probability that the market resolves YES under its resolution rules, using the rules and the \
dated evidence provided (news results or a research report). You are not shown the market price; do not guess it.

Work in this order:
1. Rules. State exactly what must happen, inside which window, and what does not count. Only \
events inside the market's window count. Anything that happened before the market opened is \
background, not a qualifying event.
2. Status. The market is still open and unresolved today. If it closes early once the event \
happens, then no qualifying event has happened yet, whatever older news seems to suggest.
3. Base rate. How often does this kind of event happen in a window this long? Start there.
4. Evidence. List dated facts for and against, preferring recent, specific and official \
reports over speculation. Weigh how much time is left.
5. Probability. Move from the base rate only as far as the evidence justifies.

evidence_quality scores the evidence, not your certainty:
0.9 = official facts already settle or nearly settle the outcome
0.7 = several recent independent reports bear directly on the resolution criteria
0.5 = some recent, directly relevant reporting, but the outcome hinges on future events
0.3 = only tangential, old or speculative information
0.1 = nothing relevant found

Be brief: every text field is one sentence, and each evidence list has at most three short items."""


QUERY_PROMPT = """You plan web research for a forecaster. Given a prediction market, write three \
short search-engine queries that together would find the evidence needed to judge it:
1. the latest news on the specific event or people named,
2. the official source, schedule or announcement that would decide it,
3. background that sets the base rate, such as past outcomes of the same kind.
Use plain keywords a news search would match. No quotes, no operators, under 12 words each."""

REPORT_PROMPT = """You are a research assistant for a forecaster. From the search results, write a \
short evidence report for the prediction market described. Do not give a probability.

key_facts: up to 6 facts that bear on the resolution rules, most decisive first. Each must be \
one sentence with its date and source, taken from the results and not from memory. Leave out \
anything that happened before the market opened unless it sets a base rate, and label it as \
background if you keep it.
status: one sentence on whether anything inside the market's window already settles it.
gaps: one sentence on what important information the results do not contain."""


class Queries(BaseModel):
    queries: list[str] = Field(description="Three search queries")


class Report(BaseModel):
    key_facts: list[str] = Field(description="Dated, sourced facts that bear on the resolution rules")
    status: str = Field(description="Whether anything in the market's window already settles it")
    gaps: str = Field(description="What the results do not contain")


class Forecast(BaseModel):
    """What the model returns. Reasoning fields come first so the number follows from them."""

    rules_check: str = Field(description="What must happen, in which window, and what does not count")
    status_check: str = Field(description="Whether a qualifying event can already have happened, given the market is still open")
    base_rate: str = Field(description="Base rate for this kind of event over the remaining window")
    evidence_for: list[str] = Field(description="Dated facts that raise the probability of YES")
    evidence_against: list[str] = Field(description="Dated facts that lower the probability of YES")
    p_true: float = Field(ge=0, le=1, description="Probability the market resolves YES")
    evidence_quality: float = Field(ge=0, le=1, description="Score from the rubric")
    rationale: str = Field(description="Two or three sentences giving the decisive evidence")


def combine(forecasts: list[Forecast], requested: int | None = None) -> Prediction:
    """Median of the runs. Confidence is evidence quality, scaled down by how much the runs
    disagree and by any runs that failed, since missing runs mean a weaker agreement check."""
    forecasts = sorted(forecasts, key=lambda f: f.p_true)
    median = forecasts[len(forecasts) // 2]
    p_true = statistics.median(f.p_true for f in forecasts)
    spread = forecasts[-1].p_true - forecasts[0].p_true
    agreement = max(0.0, 1 - spread / MAX_USEFUL_SPREAD)
    quality = statistics.median(f.evidence_quality for f in forecasts)

    rationale = median.rationale
    if len(forecasts) > 1:
        rationale += f" ({len(forecasts)} runs, {forecasts[0].p_true:.0%} to {forecasts[-1].p_true:.0%})"
    completed = len(forecasts) / max(requested or len(forecasts), 1)
    return Prediction(p_true=p_true, confidence=round(quality * agreement * completed, 2), rationale=rationale)


class PredictionEngine:
    def __init__(self, settings: Settings, http: httpx.AsyncClient, llm: AsyncOpenAI | None = None):
        self.settings = settings
        self.http = http
        # Built on first use so the service can start and report a missing XAI_API_KEY.
        self._llm = llm
        # ticker -> (time, was it deep research, prediction)
        self._cache: dict[str, tuple[float, bool, Prediction]] = {}
        # Kept separately so a forecast that fails and is retried does not pay for the search again.
        self._articles: dict[tuple[str, bool], tuple[float, list[dict]]] = {}
        self._latest_sources: dict[str, list[dict]] = {}
        # One call at a time per model, so a per-model token limit is waited out, not tripped.
        self._model_locks: dict[str, asyncio.Lock] = {}

    @property
    def llm(self) -> AsyncOpenAI:
        if self._llm is None:
            self._llm = AsyncOpenAI(
                api_key=self.settings.xai_api_key,
                base_url=self.settings.xai_base_url,
                # The SDK waits for the provider's retry-after on 429s.
                max_retries=self.settings.llm_max_retries,
                timeout=self.settings.llm_timeout_s,
            )
        return self._llm

    def ensemble(self) -> list[tuple[str, float]]:
        """(model, temperature) per run. A model's first run is deterministic; repeats of
        the same model vary so their spread means something."""
        models = self.settings.ensemble_models or [self.settings.xai_model] * max(1, self.settings.ensemble_size)
        return [(model, 0.0 if model not in models[:i] else 0.7) for i, model in enumerate(models)]

    async def predict(
        self, market: Market, deep: bool = False, on_progress: Callable[[str], Awaitable[None]] | None = None
    ) -> Prediction:
        """Forecast one market. `deep` researches it with several model-written searches and
        an evidence report first; it costs more searches, so it is for markets someone asked about.
        `on_progress` is told each stage as it starts."""

        async def progress(stage: str) -> None:
            if on_progress:
                await on_progress(stage)

        cached = self._cache.get(market.ticker)
        if cached and time.time() - cached[0] < self.settings.prediction_ttl_s and (cached[1] or not deep):
            return cached[2]

        if deep:
            await progress("Planning searches and reading the news")
            articles = await self._research(market)
            await progress(f"Summarising {len(articles)} sources")
            evidence = await self._report(market, articles)
        else:
            articles = await self._search(market)
            evidence = f"Recent news ({len(articles)} results):\n{json.dumps(articles, indent=2)}"
        self._latest_sources[market.ticker] = articles

        prompt = f"{describe(market)}\n\n{evidence}"
        runs = self.ensemble()
        done = 0

        async def run(model: str, temperature: float) -> Forecast:
            nonlocal done
            forecast = await self._ask(SYSTEM_PROMPT, prompt, Forecast, model, temperature)
            done += 1
            if done < len(runs):
                await progress(f"Forecasting, run {done + 1} of {len(runs)}")
            return forecast

        await progress(f"Forecasting, run 1 of {len(runs)}")
        results = await asyncio.gather(*(run(model, temperature) for model, temperature in runs), return_exceptions=True)
        forecasts = [r for r in results if isinstance(r, Forecast)]
        if not forecasts:
            raise next(r for r in results if isinstance(r, BaseException))
        for failure in (r for r in results if isinstance(r, BaseException)):
            log.warning("%s: forecast run failed: %s: %s", market.ticker, type(failure).__name__, str(failure)[:300])

        prediction = combine(forecasts, requested=len(runs))
        self._cache[market.ticker] = (time.time(), deep, prediction)
        return prediction

    def sources(self, ticker: str) -> list[dict]:
        """The articles the latest forecast for this market was given."""
        return [
            {"title": a["title"], "url": a["url"], "date": a["date"]} for a in self._latest_sources.get(ticker, [])
        ]

    # -- evidence ---------------------------------------------------------------

    def _fresh_articles(self, ticker: str, deep: bool) -> list[dict] | None:
        cached = self._articles.get((ticker, deep))
        if cached and time.time() - cached[0] < self.settings.prediction_ttl_s:
            return cached[1]
        return None

    async def _search(self, market: Market) -> list[dict]:
        """One news search on the market question."""
        articles = self._fresh_articles(market.ticker, False)
        if articles is None:
            articles = await date_fenced_search(
                self.http,
                self.settings.tavily_api_key,
                market.question,
                days=self.settings.news_days,
                max_results=self.settings.news_max_results,
            )
            self._articles[(market.ticker, False)] = (time.time(), articles)
        return articles

    async def _research(self, market: Market) -> list[dict]:
        """Several searches on queries the model wrote, merged and de-duplicated by URL."""
        articles = self._fresh_articles(market.ticker, True)
        if articles is not None:
            return articles

        try:
            planned = await self._ask(QUERY_PROMPT, describe(market), Queries, self.settings.xai_model, 0)
            queries = [q.strip() for q in planned.queries if q.strip()][: self.settings.research_queries]
        except Exception as exc:
            log.warning("%s: query planning failed (%s), searching the question only", market.ticker, exc)
            queries = []
        queries = queries or [market.question]

        # The last query looks for background, which a news-only search would miss.
        topics = ["news"] * (len(queries) - 1) + ["general"] if len(queries) > 1 else ["news"]
        results = await asyncio.gather(
            *(
                date_fenced_search(
                    self.http,
                    self.settings.tavily_api_key,
                    query,
                    days=self.settings.news_days,
                    max_results=self.settings.research_results_per_query,
                    topic=topic,
                )
                for query, topic in zip(queries, topics)
            ),
            return_exceptions=True,
        )
        merged: dict[str, dict] = {}
        for query, result in zip(queries, results):
            if isinstance(result, BaseException):
                log.warning("%s: search failed for %r: %s", market.ticker, query, result)
                continue
            for article in result:
                # Shorter snippets keep the report prompt small; the report needs facts, not prose.
                merged.setdefault(article["url"], {**article, "snippet": article["snippet"][:RESEARCH_SNIPPET_CHARS]})
        if not merged and all(isinstance(r, BaseException) for r in results):
            raise next(r for r in results if isinstance(r, BaseException))

        articles = list(merged.values())
        self._articles[(market.ticker, True)] = (time.time(), articles)
        return articles

    async def _report(self, market: Market, articles: list[dict]) -> str:
        """Condense the search results into the dated facts that matter for this market."""
        if not articles:
            return "Research report: the searches returned nothing relevant."
        prompt = f"{describe(market)}\n\nSearch results ({len(articles)}):\n{json.dumps(articles, indent=1)}"
        report = await self._ask(REPORT_PROMPT, prompt, Report, self.settings.xai_model, 0)
        facts = "\n".join(f"- {fact}" for fact in report.key_facts) or "- none found"
        return (
            f"Research report (from {len(articles)} search results):\n{facts}\n"
            f"Status: {report.status}\nGaps: {report.gaps}"
        )

    # -- model calls ---------------------------------------------------------------

    async def _ask(self, system: str, prompt: str, schema: type[BaseModel], model: str, temperature: float):
        """One structured answer, falling back to the next model if this one is rate-limited."""
        candidates = [model, *(m for m in self.settings.fallback_models if m != model)]
        for i, candidate in enumerate(candidates):
            try:
                return await self._ask_model(system, prompt, schema, candidate, temperature)
            except RateLimitError:
                if i == len(candidates) - 1:
                    raise
                log.warning("%s is rate-limited, falling back to %s", candidate, candidates[i + 1])
        raise RuntimeError("unreachable")

    async def _ask_model(self, system: str, prompt: str, schema: type[BaseModel], model: str, temperature: float):
        async def complete(temp: float):
            return await self.llm.chat.completions.parse(
                model=model,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
                response_format=schema,
                temperature=temp,
                max_tokens=self.settings.llm_max_tokens,
            )

        async with self._model_locks.setdefault(model, asyncio.Lock()):
            try:
                completion = await complete(temperature)
            except BadRequestError as exc:
                # Smaller models occasionally emit JSON that misses the schema; one more try usually lands.
                if "json_validate_failed" not in str(exc):
                    raise
                completion = await complete(0.3)
        message = completion.choices[0].message
        if message.parsed is not None:
            return message.parsed
        # Some local servers (LM Studio with a thinking model) put the JSON in the reasoning field.
        for text in (message.content, (message.model_extra or {}).get("reasoning_content")):
            start, end = (text or "").find("{"), (text or "").rfind("}")
            if start != -1 and end > start:
                return schema.model_validate_json(text[start : end + 1])
        raise ValueError(f"model returned no parsed {schema.__name__}")


def describe(market: Market) -> str:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    days_left = days_to_close(market.close_time)
    window = f"{days_left:.0f} days from today" if days_left is not None else "unknown"
    return (
        f"Today: {today}\n"
        f"Market: {market.question}\n"
        f"Opened: {market.open_time[:10] or 'unknown'}\n"
        f"Closes: {market.close_time[:10] or 'unknown'} ({window})\n"
        f"Early close: {market.early_close or 'not stated'}\n"
        f"Status: open and unresolved as of today\n"
        f"Resolution rules: {market.rules or 'not provided'}"
    )
