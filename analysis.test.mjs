import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source = (await readFile(new URL('../flow.js', import.meta.url), 'utf8'))
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*"\.\/integrations.js";/, '')
  .replace(/bootstrap\(\);\s*$/, '');
function panel(coverage, storage) {
  const element = { innerHTML: '', addEventListener() {} };
  const context = vm.createContext({
    document: { querySelector: () => element, addEventListener() {} },
    setInterval, clearInterval, crypto:webcrypto, structuredClone,
    chrome: storage ? {storage:{local:storage}} : undefined,
    fetchRecentCoverage: coverage,
    fetchKalshiEventPage: async () => ({markets:[],categories:[],cursor:'',fetchedAt:new Date().toISOString()}),
    connectLocalModel: async () => 'local-model',
    analyzeLocally: async () => ({ verdict: 'Yes', probabilityPercent: 63, explanation: 'Sample rationale.', citations: ['RSS1'], sources: [{id: 'RSS1', point: 'A key supporting point.'}] })
  });
  vm.runInContext(`${source}\nglobalThis.app = { state, analyzeEvent, renderVerdict, saveAnalysis, previousSavedAnalysis, getFilteredMarkets, renderSelected, bootstrap };`, context);
  context.app.state.event = { title: 'Test market' };
  return { ...context.app, element };
}

test('analysis reaches results and displays probability, rationale and sources', async () => {
  const app = panel(async () => [{ id: 'RSS1', title: 'Test headline', domain: 'Publisher', url: 'https://example.com/news', provider: 'Google News RSS' }]);
  await app.analyzeEvent();
  assert.equal(app.state.stage, 'verdict');
  assert.equal(app.state.busy, false);
  for (const text of ['Yes 63% / No 37%', 'Sample rationale.', 'Test headline']) assert.ok(app.element.innerHTML.includes(text));
  assert.ok(app.element.innerHTML.indexOf('63%') < app.element.innerHTML.indexOf('Sample rationale.'));
  assert.match(app.element.innerHTML, /A key supporting point\./);
  assert.match(app.element.innerHTML, /href="https:\/\/example.com\/news"/);
});

test('assessment displays both evidence sections and only genuinely retrieved additional sources', () => {
  const app = panel(async () => []);
  app.state.event = {title:'Exact question',marketTicker:'MARKET',rules:'Exact settlement rules',yesAsk:'0.42'};
  app.state.articles = [
    {id:'G1',title:'Selected source',domain:'Publisher',url:'https://example.com/one',date:'2026-10-03'},
    {id:'G2',title:'Other retrieved source',domain:'Publisher Two',url:'https://example.com/two',date:'2026-10-02'}
  ];
  app.state.analysis = {
    verdict:'Wait',assessment:'Mixed',probabilityPercent:null,explanation:'Evidence conflicts.',
    sources:[{id:'G1',point:'A reported claim.',stance:'Supports Yes',limitation:'Excerpt only'}],
    supportsYes:[{text:'A claim supports Yes.',kind:'Reported claim',citations:['G1']}],
    supportsNo:[],criticalUnknowns:['The official result is missing.']
  };
  app.renderVerdict();
  for (const text of ['Exact question','Supports Yes','Supports No','Critical Unknowns','Load More Sources (1)','Other retrieved source','unavailable—insufficient evidence']) assert.ok(app.element.innerHTML.includes(text), text);
  assert.doesNotMatch(app.element.innerHTML,/Exact settlement rules|Resolution condition|Market price · not a forecast|Method and assumptions/);
});

test('news failures stay visible with retry instead of returning silently to market', async () => {
  const app = panel(async () => { throw new Error('News is unavailable'); });
  await app.analyzeEvent();
  assert.equal(app.state.stage, 'analysis-error');
  assert.equal(app.state.busy, false);
  assert.match(app.element.innerHTML, /News is unavailable/);
  assert.match(app.element.innerHTML, /Retry analysis/);
});

test('empty coverage produces an honest results screen without a fabricated probability', async () => {
  const app = panel(async () => []);
  await app.analyzeEvent();
  assert.equal(app.state.stage, 'verdict');
  assert.equal(app.state.analysis.verdict, 'Wait');
  assert.equal(app.state.analysis.probabilityPercent, null);
  assert.equal(app.state.busy, false);
  assert.match(app.element.innerHTML, /Probability unavailable/);
  assert.match(app.element.innerHTML, /Analyze again/);
  assert.doesNotMatch(app.element.innerHTML, /Estimated probability of Yes|LOCAL MODEL ·|Practice purchase/);
});

function memoryStorage(fail = false) {
  const values = {};
  return {values, get:async ()=>structuredClone(values), set:async update=>{if(fail) throw new Error('Storage full'); Object.assign(values, structuredClone(update));}};
}

test('Save Analysis links immutable history to the market, follows it, and avoids duplicate saves', async () => {
  const storage = memoryStorage();
  const app = panel(async()=>[],storage);
  app.state.event = {marketTicker:'A',title:'Event A'};
  app.state.analysis = {probabilityPercent:60,explanation:'First analysis.',assessedAt:'2026-10-04T00:00:00Z',sources:[]};
  app.state.stage = 'verdict';
  await app.saveAnalysis();
  assert.equal(storage.values.savedMarketAnalyses.length,1);
  assert.equal(storage.values.savedMarketAnalyses[0].market.marketTicker,'A');
  assert.ok(app.state.followed.has('A'));
  assert.deepEqual(storage.values.followedKalshiMarketTickers,['A']);
  await app.saveAnalysis();
  assert.equal(storage.values.savedMarketAnalyses.length,1);
  app.state.analysis.explanation='Mutated current text';
  assert.equal(storage.values.savedMarketAnalyses[0].analysis.explanation,'First analysis.');
  app.state.view='following';
  assert.equal(app.getFilteredMarkets()[0].marketTicker,'A'); // Survives catalog refresh/absence.
  app.renderSelected();
  assert.match(app.element.innerHTML,/Saved Analyses/);
  const reopened = panel(async()=>[],storage);
  await reopened.bootstrap();
  reopened.state.view = 'following';
  assert.equal(reopened.state.history.length,1);
  assert.ok(reopened.state.followed.has('A'));
  assert.equal(reopened.getFilteredMarkets()[0].marketTicker,'A');
});

test('save failure does not falsely follow or claim saved history',async()=>{
  const app=panel(async()=>[],memoryStorage(true));
  app.state.event={marketTicker:'A',title:'Event A'};
  app.state.analysis={probabilityPercent:null,explanation:'Unknown.',sources:[]};
  await app.saveAnalysis();
  assert.equal(app.state.history.length,0);
  assert.equal(app.state.followed.size,0);
  assert.equal(app.state.savingAnalysis,false);
  assert.match(app.element.innerHTML,/Storage full/);
});

test('comparison remains linked to the same market and excludes the newly saved current result',async()=>{
  const storage=memoryStorage();
  const app=panel(async()=>[],storage);
  app.state.event={marketTicker:'A',title:'Event A'};
  app.state.analysis={probabilityPercent:60,explanation:'Earlier.',assessedAt:'2026-10-04T00:00:00Z',sources:[]};
  await app.saveAnalysis();
  const previousId=app.state.analysisId;
  app.state.analysisId=null;
  app.state.analysis={probabilityPercent:70,explanation:'Now.',assessedAt:'2026-10-04T01:00:00Z',sources:[],comparisonPreviousId:previousId,changedEvidence:'Official evidence strengthened.',changeExplanation:'The official update increased the estimate.'};
  await app.saveAnalysis();
  assert.equal(app.previousSavedAnalysis().id,previousId);
  assert.match(app.element.innerHTML,/Yes 60% \/ No 40% → Yes 70% \/ No 30%/);
  assert.match(app.element.innerHTML,/Official evidence strengthened/);
  assert.match(app.element.innerHTML,/official update increased/);
  app.state.event={marketTicker:'B'};
  assert.equal(app.previousSavedAnalysis(),undefined);
});

test('overall conclusion comes first and is limited to five numbered sentences',()=>{
  const app=panel(async()=>[]);
  app.state.analysis={probabilityPercent:55,explanation:'One. Two. Three. Four. Five. Six.',sources:[],criticalUnknowns:[]};
  app.renderVerdict();
  const list=app.element.innerHTML.match(/<ol class="overall-conclusion">([\s\S]*?)<\/ol>/)[1];
  assert.equal((list.match(/<li>/g)||[]).length,5);
  assert.ok(app.element.innerHTML.indexOf('Overall Conclusion')<app.element.innerHTML.indexOf('Supports Yes'));
});
