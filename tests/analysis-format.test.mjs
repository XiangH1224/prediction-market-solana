import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLocally } from '../integrations.js';
import { ANALYSIS_PROMPT } from '../analysis-prompt.js';
import { normalizeAnalysis, prepareEvidence } from '../analysis-contract.js';

const articles = ['G1','G2','G3','G4'].map(id=>({id,title:`Article ${id}`,url:`https://example.com/${id}`,date:'2026-10-01T00:00:00Z'}));
const fixture = () => ({
  assessment:'Favors Yes', probability_percent:65, method:'Explicit statistical model from supplied data', assumptions:'Comparable population and stable conditions', probability_citations:['G1'],
  resolution_condition:'The specified condition occurs before closing.', settlement_exceptions:'None supplied.',
  explanation:'Evidence favors Yes. There is counterevidence. Uncertainty remains. This is uncalibrated. Omit this fifth sentence.', conclusion_citations:['G1','G2'],
  supports_yes:[{text:'Reported data supports Yes.',kind:'Reported claim',citations:['G1']}],
  supports_no:[{text:'A conflicting report supports No.',kind:'Reported claim',citations:['G2']}],
  critical_unknowns:['The final official value is not supplied and could change settlement.'],
  sources:[{id:'G2',point:'Counterevidence is material. Omit detail.',stance:'Supports No',limitation:'Excerpt only'}, {id:'unknown',point:'Invalid'}, {id:'G2',point:'Duplicate'}, {id:'G1',point:'Supporting data.',stance:'Supports Yes',limitation:'Excerpt only'}, {id:'G3',point:'Uncertain timing.',stance:'Clarifies an unknown',limitation:'Headline only'}, {id:'G4',point:'Fourth'}]
});

test('request preserves user policy and provides timestamp, settlement source, prices and access limits', async context => {
  let request;
  context.mock.method(globalThis,'fetch',async (_url, options)=>{
    request=JSON.parse(options.body);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(fixture())}}]}));
  });
  const result=await analyzeLocally({event:{title:'Test', marketTicker:'TEST',rules:'Exact rules',sourceName:'Official',sourceUrl:'https://example.com',yesAsk:'0.52',noAsk:null,quoteFetchedAt:'2026-10-04T00:00:00Z'}, articles, model:'test'});
  assert.ok(request.messages[0].content.startsWith(ANALYSIS_PROMPT));
  assert.doesNotMatch(request.messages[0].content,/Do not default to Wait/);
  const input=JSON.parse(request.messages[1].content);
  assert.equal(input.event.ticker,'TEST');
  assert.equal(input.event.settlement_source.name,'Official');
  assert.equal(input.market_data.yes_ask,0.52);
  assert.equal(input.market_data.no_ask,null);
  assert.match(input.assessment_as_of,/Z$/);
  assert.equal(input.evidence[1].access,'Headline and metadata only');
  assert.equal(result.probabilityPercent,65);
  assert.equal(result.probabilityNo,35);
  assert.equal(result.uncalibrated,true);
  assert.deepEqual(result.citations,['G2','G1','G3']);
  assert.equal([...new Intl.Segmenter('en',{granularity:'sentence'}).segment(result.explanation)].length,4);
  assert.equal(result.sources[0].point,'Counterevidence is material.');
});

test('probabilities are optional and require a method, assumptions and genuine news citations',()=>{
  for (const overrides of [{probability_percent:null},{method:''},{assumptions:''},{probability_citations:['RULES','invented']},{assessment:'Insufficient evidence'}]) {
    const result=normalizeAnalysis({...fixture(),...overrides},articles,new Date().toISOString());
    assert.equal(result.probabilityPercent,null);
    assert.equal(result.probabilityNo,null);
  }
  assert.equal(normalizeAnalysis({...fixture(),probability_percent:67},articles,'now').probabilityPercent,65);
});

test('uncited directional evidence and invented source IDs cannot reach the result',()=>{
  const result=normalizeAnalysis({...fixture(),supports_yes:[{text:'Unsupported assertion.',kind:'Verified fact',citations:['made-up']}]},articles,'now');
  assert.deepEqual(result.supportsYes,[]);
  assert.ok(result.sources.every(source=>articles.some(article=>article.id===source.id)));
});

test('evidence removes obvious duplicates and marks date/access limitations',()=>{
  const result=prepareEvidence([
    {id:'A',title:'Same headline',url:'https://example.com/a?utm_source=x',date:'unknown'},
    {id:'B',title:'Same headline',url:'https://example.com/b'},
    {id:'C',title:'Different headline',url:'https://example.com/a?utm_source=y'},
    {id:'D',title:'Future article',date:'2026-11-01',description:'Short excerpt'}
  ],'2026-10-04T00:00:00Z');
  assert.deepEqual(result.map(article=>article.id),['A','D']);
  assert.match(result[0].publicationDateWarning,/unavailable/);
  assert.match(result[1].publicationDateWarning,/after assessment/);
  assert.match(result[1].access,/truncated/);
});
