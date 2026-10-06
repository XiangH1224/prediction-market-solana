from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.models import Market, Prediction
from app.prediction.engine import Forecast, PredictionEngine, combine

MARKET = Market(ticker="T", title="Will it happen?", rules="Resolves YES if it happens.", yes_mint="y", no_mint="n",
                open_time="2026-05-22T18:00:00Z", early_close="Closes early if the event occurs.")


def forecast(p_true: float, quality: float = 0.7, rationale: str = "evidence") -> Forecast:
    return Forecast(rules_check="r", status_check="s", base_rate="b", evidence_for=[], evidence_against=[],
                    p_true=p_true, evidence_quality=quality, rationale=rationale)


class FakeLLM:
    def __init__(self, p_trues=(0.62,)):
        self.calls = []
        self.p_trues = list(p_trues)
        self.chat = SimpleNamespace(completions=SimpleNamespace(parse=self.parse))

    async def parse(self, **kwargs):
        self.calls.append(kwargs)
        parsed = forecast(self.p_trues[(len(self.calls) - 1) % len(self.p_trues)])
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(parsed=parsed))])


async def test_engine_searches_news_then_asks_grok_and_caches():
    searches = []

    def handler(request: httpx.Request) -> httpx.Response:
        searches.append(request)
        assert request.headers["authorization"] == "Bearer tv"
        return httpx.Response(200, json={"results": [
            {"title": "Headline", "url": "https://n.test/a", "content": "It looks likely.", "published_date": "2026-10-03"}]})

    llm = FakeLLM()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        engine = PredictionEngine(Settings(tavily_api_key="tv", xai_model="m", ensemble_size=1), http, llm=llm)
        first = await engine.predict(MARKET)
        second = await engine.predict(MARKET)

    assert first.p_true == 0.62 and second is first
    assert len(searches) == 1 and len(llm.calls) == 1
    call = llm.calls[0]
    assert call["model"] == "m" and call["response_format"] is Forecast
    prompt = call["messages"][1]["content"]
    assert "Resolves YES if it happens." in prompt and "Headline" in prompt and "2026-10-03" in prompt
    assert "Opened: 2026-05-22" in prompt and "Closes early if the event occurs." in prompt
    assert "open and unresolved" in prompt


async def test_engine_runs_an_ensemble_and_takes_the_median():
    llm = FakeLLM(p_trues=(0.60, 0.66, 0.63))
    handler = lambda r: httpx.Response(200, json={"results": []})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        engine = PredictionEngine(Settings(tavily_api_key="tv", ensemble_size=3), http, llm=llm)
        prediction = await engine.predict(MARKET)
    assert len(llm.calls) == 3 and [c["temperature"] for c in llm.calls] == [0, 0.7, 0.7]
    assert prediction.p_true == 0.63
    # Spread 0.06 of a useful 0.30 leaves 80% of the 0.7 evidence quality.
    assert prediction.confidence == 0.56
    assert "3 runs, 60% to 66%" in prediction.rationale


def test_disagreeing_runs_destroy_confidence():
    assert combine([forecast(0.2, 0.9), forecast(0.5, 0.9), forecast(0.8, 0.9)]).confidence == 0
    assert combine([forecast(0.5, 0.9), forecast(0.5, 0.9), forecast(0.5, 0.9)]).confidence == 0.9


async def test_ensemble_can_spread_runs_across_models():
    llm = FakeLLM(p_trues=(0.5, 0.5, 0.5))
    handler = lambda r: httpx.Response(200, json={"results": []})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        engine = PredictionEngine(Settings(tavily_api_key="tv", ensemble_models=["a", "b", "a"]), http, llm=llm)
        await engine.predict(MARKET)
    assert [(c["model"], c["temperature"]) for c in llm.calls] == [("a", 0.0), ("b", 0.0), ("a", 0.7)]


async def test_retry_after_a_failed_forecast_reuses_the_search():
    searches = []

    def handler(request: httpx.Request) -> httpx.Response:
        searches.append(1)
        return httpx.Response(200, json={"results": []})

    class FailsOnce(FakeLLM):
        async def parse(self, **kwargs):
            if not self.calls:
                self.calls.append(kwargs)
                raise RuntimeError("rate limited")
            return await super().parse(**kwargs)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        engine = PredictionEngine(Settings(tavily_api_key="tv", ensemble_size=1), http, llm=FailsOnce())
        with pytest.raises(RuntimeError):
            await engine.predict(MARKET)
        assert (await engine.predict(MARKET)).p_true == 0.62
    assert len(searches) == 1


async def test_rate_limited_model_falls_back_to_the_next_one():
    from openai import RateLimitError

    class PrimaryExhausted(FakeLLM):
        async def parse(self, **kwargs):
            if kwargs["model"] == "big":
                self.calls.append(kwargs)
                raise RateLimitError("daily cap", response=httpx.Response(429, request=httpx.Request("POST", "https://x.test")), body=None)
            return await super().parse(**kwargs)

    llm = PrimaryExhausted()
    handler = lambda r: httpx.Response(200, json={"results": []})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        settings = Settings(tavily_api_key="tv", xai_model="big", fallback_models=["small"], ensemble_size=1)
        prediction = await PredictionEngine(settings, http, llm=llm).predict(MARKET)
    assert [c["model"] for c in llm.calls] == ["big", "small"] and prediction.p_true == 0.62


def test_failed_runs_reduce_confidence():
    assert combine([forecast(0.5, 0.9)], requested=3).confidence == 0.3


def test_single_run_confidence_is_the_evidence_quality():
    prediction = combine([forecast(0.4, 0.5, "why")])
    assert (prediction.p_true, prediction.confidence, prediction.rationale) == (0.4, 0.5, "why")


def test_prediction_schema_rejects_out_of_range_probability():
    with pytest.raises(ValueError):
        Prediction(p_true=1.2, confidence=0.5, rationale="r")


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("PANEL_TOKEN", "secret")
    monkeypatch.setenv("AUDIT_LOG_PATH", str(tmp_path / "audit.jsonl"))
    for key in ("XAI_API_KEY", "TAVILY_API_KEY", "DFLOW_API_KEY"):
        monkeypatch.setenv(key, "")
    from app.main import app

    with TestClient(app) as c:
        yield c


def test_panel_with_token_gets_status_and_can_register_wallet(client):
    with client.websocket_connect("/ws?token=secret", headers={"origin": "chrome-extension://abc"}) as ws:
        status = ws.receive_json()
        assert status["type"] == "status"
        assert status["data"]["missing_keys"] == ["XAI_API_KEY"]
        assert status["data"]["signals_only"] is True
        paper = ws.receive_json()
        assert paper["type"] == "paper" and paper["data"]["cash_usd"] == 1000 and paper["data"]["positions"] == []
        ws.send_json({"type": "hello", "wallet": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"})
        assert ws.receive_json()["data"]["wallet"] == "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"


@pytest.mark.parametrize("url,origin", [
    ("/ws?token=wrong", "chrome-extension://abc"),
    ("/ws", "chrome-extension://abc"),
    ("/ws?token=secret", "https://evil.test"),
    ("/ws?token=secret", "http://localhost.evil.test"),
])
def test_panel_socket_rejects_bad_token_or_web_origin(client, url, origin):
    with client.websocket_connect(url, headers={"origin": origin}) as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == 4401


def test_without_a_configured_token_local_panels_just_connect(monkeypatch, tmp_path):
    monkeypatch.setenv("PANEL_TOKEN", "")
    monkeypatch.setenv("AUDIT_LOG_PATH", str(tmp_path / "audit.jsonl"))
    monkeypatch.setenv("XAI_API_KEY", "")
    from app.main import app

    with TestClient(app) as c:
        with c.websocket_connect("/ws", headers={"origin": "http://localhost:8000"}) as ws:
            assert ws.receive_json()["type"] == "status"
        with c.websocket_connect("/ws", headers={"origin": "https://evil.test"}) as ws:
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
        assert exc.value.code == 4401


def test_panel_page_on_this_machine_can_connect(client):
    with client.websocket_connect("/ws?token=secret", headers={"origin": "http://localhost:8000"}) as ws:
        assert ws.receive_json()["type"] == "status"


def test_health_and_wallet_page(client):
    assert client.get("/health").json()["state"] == "missing_keys"
    assert "Wallet bridge" in client.get("/wallet").text


# -- deep research ---------------------------------------------------------------

import json as _json

from app.prediction.engine import Queries, Report


class ResearchLLM(FakeLLM):
    """Answers each step of deep research according to the schema asked for."""

    def __init__(self, fail_planning=False):
        super().__init__()
        self.fail_planning = fail_planning

    async def parse(self, **kwargs):
        self.calls.append(kwargs)
        schema = kwargs["response_format"]
        if schema is Queries:
            if self.fail_planning:
                raise RuntimeError("planner down")
            parsed = Queries(queries=["fed october decision", "FOMC statement schedule", "fed hold rate history", "extra"])
        elif schema is Report:
            parsed = Report(key_facts=["2026-10-02: Officials lean against a hike (Reuters)."], status="Nothing settles it yet.", gaps="No dot plot.")
        else:
            parsed = forecast(0.62)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(parsed=parsed))])


def research_transport(searches):
    def handler(request: httpx.Request) -> httpx.Response:
        body = _json.loads(request.content)
        searches.append(body)
        # Every search returns one shared article and one of its own.
        return httpx.Response(200, json={"results": [
            {"title": "Shared", "url": "https://n.test/shared", "content": "c", "published_date": "2026-10-02"},
            {"title": body["query"], "url": f"https://n.test/{len(searches)}", "content": "c", "published_date": None}]})

    return httpx.MockTransport(handler)


async def test_deep_research_plans_queries_searches_each_and_forecasts_from_a_report():
    searches, llm = [], ResearchLLM()
    async with httpx.AsyncClient(transport=research_transport(searches)) as http:
        engine = PredictionEngine(Settings(tavily_api_key="tv", xai_model="m", ensemble_size=2), http, llm=llm)
        prediction = await engine.predict(MARKET, deep=True)
        again = await engine.predict(MARKET, deep=True)
        shallow = await engine.predict(MARKET)

    assert prediction.p_true == 0.62 and again is prediction and shallow is prediction
    # Three planned queries (the fourth is dropped): two news searches and one general.
    assert [(s["query"], s["topic"]) for s in searches] == [
        ("fed october decision", "news"), ("FOMC statement schedule", "news"), ("fed hold rate history", "general")]
    assert "days" in searches[0] and "days" not in searches[2]
    assert [c["response_format"] for c in llm.calls] == [Queries, Report, Forecast, Forecast]
    # The report call sees the merged results; the forecasts see only the report.
    assert llm.calls[1]["messages"][1]["content"].count("https://n.test/") == 4
    forecast_prompt = llm.calls[2]["messages"][1]["content"]
    assert "Research report (from 4 search results)" in forecast_prompt
    assert "Officials lean against a hike" in forecast_prompt and "https://n.test/" not in forecast_prompt
    assert [s["url"] for s in engine.sources("T")] == [
        "https://n.test/shared", "https://n.test/1", "https://n.test/2", "https://n.test/3"]
    assert engine.sources("T")[1]["date"] == ""
    assert engine.sources("T")[0]["snippet"] == "c"
    # What the panel shows beside the number: the median run's evidence and the report's gaps.
    detail = engine.details("T")
    assert detail["runs"] == [0.62, 0.62] and detail["runs_requested"] == 2
    assert detail["evidence_for"] == forecast(0.62).evidence_for
    assert detail["report"]["gaps"] == "No dot plot."
    assert (detail["model"], detail["search_provider"]) == ("m", "Tavily")


async def test_a_shallow_forecast_is_redone_when_deep_research_is_asked_for():
    searches, llm = [], ResearchLLM()
    async with httpx.AsyncClient(transport=research_transport(searches)) as http:
        engine = PredictionEngine(Settings(tavily_api_key="tv", ensemble_size=1), http, llm=llm)
        await engine.predict(MARKET)
        assert len(searches) == 1
        await engine.predict(MARKET, deep=True)
    assert len(searches) == 4


async def test_deep_research_falls_back_to_the_question_when_planning_fails():
    searches, llm = [], ResearchLLM(fail_planning=True)
    async with httpx.AsyncClient(transport=research_transport(searches)) as http:
        engine = PredictionEngine(Settings(tavily_api_key="tv", ensemble_size=1), http, llm=llm)
        assert (await engine.predict(MARKET, deep=True)).p_true == 0.62
    assert [(s["query"], s["topic"]) for s in searches] == [("Will it happen?", "news")]


async def test_answer_found_in_the_reasoning_field_is_still_parsed():
    class LocalLLM(FakeLLM):
        async def parse(self, **kwargs):
            self.calls.append(kwargs)
            body = forecast(0.4).model_dump_json()
            message = SimpleNamespace(parsed=None, content="", model_extra={"reasoning_content": body})
            return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    handler = lambda r: httpx.Response(200, json={"results": []})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        engine = PredictionEngine(Settings(tavily_api_key="tv", ensemble_size=1), http, llm=LocalLLM())
        assert (await engine.predict(MARKET)).p_true == 0.4
