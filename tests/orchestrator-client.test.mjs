import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeWithOrchestrator, fromOrchestrator } from '../orchestrator-client.js';

const done = {
  ticker: 'KXFED-26OCT', state: 'done',
  prediction: { p_true: 0.62, confidence: 0.55, rationale: 'Officials lean against a hike. (2 runs, 55% to 70%)' },
  decision: { side: 'no', p_win: 0.38, price: 0.3, edge: 0.08, actionable: true, reason: '', stake_usd: 12.5 },
  verdict: { invest: true, headline: 'Invest: buy NO at 30¢', detail: 'Model puts NO at 38%; it costs 30%.' },
  sources: [
    { title: 'Fed holds', url: 'https://www.example.com/fed?x=1', date: 'Fri, 02 Oct 2026 10:00:00 GMT', snippet: 'The Fed held rates. More text.' },
    { title: 'GDELT headline', url: 'https://news.test/a', date: '20261003', snippet: '' },
    { title: 'No link', url: '', date: '', snippet: '' }
  ],
  detail: {
    base_rate: 'Holds follow about two in three meetings.', evidence_for: ['Yes fact one.'], evidence_against: ['No fact one.'],
    runs: [0.55, 0.7], runs_requested: 2, report: { gaps: 'No dot plot was found.' }, model: 'm', search_provider: 'Tavily'
  }
};

test('an orchestrator result becomes the panel analysis without inventing fields', () => {
  const { analysis, articles } = fromOrchestrator(done, '2026-10-06T00:00:00.000Z');
  assert.deepEqual(articles.map(a => [a.id, a.domain, a.date, a.provider]), [
    ['S1', 'example.com', '2026-10-02T10:00:00.000Z', 'Tavily'], ['S2', 'news.test', '2026-10-03T00:00:00.000Z', 'Tavily']]);
  assert.equal(analysis.probabilityPercent, 62);
  assert.equal(analysis.assessment, 'Favors Yes');
  // The purchase screen preselects the side with an edge, which here is not the likelier side.
  assert.equal(analysis.verdict, 'No');
  assert.deepEqual(analysis.conclusionLines, [
    'Invest: buy NO at 30¢. Model puts NO at 38%; it costs 30%.', 'Officials lean against a hike. (2 runs, 55% to 70%)']);
  // One conclusion only: no per-side evidence lists for the panel to lay out.
  for (const key of ['supportsYes', 'supportsNo', 'criticalUnknowns']) assert.equal(key in analysis, false);
  assert.deepEqual(analysis.sources.map(s => [s.id, s.point]), [['S1', 'The Fed held rates.'], ['S2', 'GDELT headline']]);
  assert.match(analysis.researchStatus[1].reason, /2 of 2 runs · confidence 0\.55/);
});

test('a result with no sources or detail still yields a displayable analysis', () => {
  const { analysis, articles } = fromOrchestrator({ prediction: { p_true: 0.5, confidence: 0.1, rationale: 'Nothing found.' }, decision: null, verdict: {} });
  assert.deepEqual(articles, []);
  assert.equal(analysis.verdict, 'Wait');
  assert.deepEqual(analysis.conclusionLines, ['Nothing found.']);
  assert.deepEqual(analysis.sources, []);
  assert.equal(analysis.researchStatus[0].status, 'No relevant data');
});

function fakeSocket(script) {
  return class {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; queueMicrotask(() => { this.onopen(); script(this); }); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.closed = true; }
    emit(data) { this.onmessage({ data: JSON.stringify({ type: 'analysis', data }) }); }
  };
}

test('analysis ignores a replayed earlier result, reports stages, then resolves', async () => {
  const stages = []; let socket;
  const Socket = fakeSocket(s => {
    socket = s;
    s.onmessage({ data: JSON.stringify({ type: 'status', data: {} }) });
    s.emit({ ...done, prediction: { ...done.prediction, p_true: 0.01 } });
    s.emit({ ticker: 'OTHER', state: 'running', stage: 'Someone else' });
    s.emit({ ticker: done.ticker, state: 'running', stage: 'Loading the market' });
    s.emit({ ticker: done.ticker, state: 'running', stage: 'Forecasting, run 1 of 2' });
    s.emit(done);
  });
  const result = await analyzeWithOrchestrator({ marketTicker: done.ticker }, rows => stages.push(rows), Socket);
  assert.equal(result.analysis.probabilityPercent, 62);
  assert.deepEqual(socket.sent, [{ type: 'analyze', ticker: done.ticker }]);
  assert.match(socket.url, /^ws:\/\/127\.0\.0\.1:8000\/ws$/);
  assert.equal(socket.closed, true);
  assert.deepEqual(stages.at(-1), [{ source: 'Loading the market', status: 'Done' }, { source: 'Forecasting, run 1 of 2', status: 'In progress' }]);
});

test('backend errors and an unreachable backend reject with a message the panel can show', async () => {
  const failing = fakeSocket(s => { s.emit({ ticker: 'T', state: 'running', stage: 'Loading the market' }); s.emit({ ticker: 'T', state: 'error', error: 'Could not reach the model server.' }); });
  await assert.rejects(analyzeWithOrchestrator({ marketTicker: 'T' }, () => {}, failing), /Could not reach the model server/);
  const offline = class { constructor() { queueMicrotask(() => this.onerror()); } close() {} };
  await assert.rejects(analyzeWithOrchestrator({ marketTicker: 'T' }, () => {}, offline), /npm start/);
  const dropped = fakeSocket(s => s.onclose({ code: 1006 }));
  await assert.rejects(analyzeWithOrchestrator({ marketTicker: 'T' }, () => {}, dropped), /disconnected before finishing/);
});
