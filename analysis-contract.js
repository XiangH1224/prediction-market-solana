export function analysisSchema(ids) {
  const string = {type: 'string'};
  const object = (properties) => ({type:'object', properties, required:Object.keys(properties), additionalProperties:false});
  const citations = {type:'array', items:{type:'string', enum:['RULES', ...ids]}};
  const point = object({text:string, kind:{type:'string',enum:['Verified fact','Reported claim','Inference']}, citations});
  return object({
    assessment:{type:'string',enum:['Favors Yes','Favors No','Mixed','Insufficient evidence']},
    probability_percent:{type:['integer','null'], minimum:0, maximum:100},
    method:string, assumptions:string, probability_citations:citations,
    resolution_condition:string, settlement_exceptions:string,
    explanation:string, conclusion_citations:citations,
    changed_evidence:string, change_explanation:string,
    supports_yes:{type:'array',maxItems:3,items:point}, supports_no:{type:'array',maxItems:3,items:point},
    critical_unknowns:{type:'array',maxItems:3,items:string},
    sources:{type:'array',maxItems:3,items:object({id:{type:'string',enum:ids},point:string,
      stance:{type:'string',enum:['Supports Yes','Supports No','Clarifies an unknown']}, limitation:string})}
  });
}

function text(value, limit = 1200) { return typeof value === 'string' ? value.trim().slice(0,limit) : ''; }
function sentences(value, max) {
  return [...new Intl.Segmenter('en', {granularity:'sentence'}).segment(text(value))].slice(0,max).map(item=>item.segment).join('').trim();
}

export function normalizeAnalysis(parsed, articles, assessedAt) {
  const assessments = ['Favors Yes','Favors No','Mixed','Insufficient evidence'];
  if (!parsed || !assessments.includes(parsed.assessment) || !text(parsed.explanation) || !Array.isArray(parsed.sources)) throw new Error('The model returned incomplete analysis. Please retry.');
  const ids = new Set(articles.map(article=>article.id));
  const valid = values => Array.isArray(values) ? [...new Set(values.filter(id=>id === 'RULES' || ids.has(id)))] : [];
  const probability = parsed.probability_percent;
  if (probability !== null && (!Number.isInteger(probability) || probability < 0 || probability > 100)) throw new Error('The model returned an invalid probability. Please retry.');
  const probabilityCitations = valid(parsed.probability_citations);
  // A stated method is necessary, not proof of statistical calibration.
  const supported = probability !== null && parsed.assessment !== 'Insufficient evidence' && text(parsed.method) && text(parsed.assumptions) && probabilityCitations.some(id=>ids.has(id));
  const probabilityPercent = supported ? Math.round(probability / 5) * 5 : null;
  const seen = new Set();
  const sources = parsed.sources.flatMap(source => {
    if (!source || !ids.has(source.id) || seen.has(source.id) || !text(source.point)) return [];
    seen.add(source.id);
    return [{id:source.id, point:sentences(source.point,1), stance:['Supports Yes','Supports No','Clarifies an unknown'].includes(source.stance) ? source.stance : 'Clarifies an unknown', limitation:text(source.limitation,500)}];
  }).slice(0,3);
  const points = values => (Array.isArray(values) ? values : []).flatMap(item => {
    const citations = valid(item?.citations);
    if (!text(item?.text) || !citations.length) return [];
    return [{text:sentences(item.text,1),kind:['Verified fact','Reported claim','Inference'].includes(item.kind) ? item.kind : 'Reported claim', citations}];
  }).slice(0,3);
  return {
    assessedAt, assessment:parsed.assessment,
    verdict:parsed.assessment === 'Favors Yes' ? 'Yes' : parsed.assessment === 'Favors No' ? 'No' : 'Wait',
    probabilityPercent, probabilityNo:probabilityPercent === null ? null : 100-probabilityPercent,
    method:text(parsed.method), assumptions:text(parsed.assumptions), probabilityCitations,
    resolutionCondition:text(parsed.resolution_condition), settlementExceptions:text(parsed.settlement_exceptions),
    // One numerical lead plus at most four explanatory sentences.
    explanation:sentences(parsed.explanation,4), conclusionCitations:valid(parsed.conclusion_citations),
    changedEvidence:sentences(parsed.changed_evidence,1), changeExplanation:sentences(parsed.change_explanation,1),
    supportsYes:points(parsed.supports_yes), supportsNo:points(parsed.supports_no),
    criticalUnknowns:(Array.isArray(parsed.critical_unknowns) ? parsed.critical_unknowns : []).filter(item=>text(item)).slice(0,3).map(item=>sentences(item,1)),
    sources, citations:sources.map(source=>source.id),
    insufficientEvidence:parsed.assessment === 'Insufficient evidence', uncalibrated:probabilityPercent !== null
  };
}

export function prepareEvidence(articles, assessedAt) {
  const titles = new Set(); const urls = new Set();
  return articles.flatMap(article => {
    const title = String(article.title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
    let url = article.url;
    try { const parsed = new URL(url); parsed.hash=''; for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) parsed.searchParams.delete(key); url=parsed.href; } catch {}
    if (!title || titles.has(title) || (url && urls.has(url))) return [];
    titles.add(title); if (url) urls.add(url);
    const date = Date.parse(article.date);
    return [{...article, access:article.content || article.description ? 'Headlines and excerpts only; content may be truncated' : 'Headline and metadata only',
      publicationAgeHours:Number.isFinite(date) ? Math.round((Date.parse(assessedAt)-date)/3600000) : null,
      publicationDateWarning:!Number.isFinite(date) ? 'Publication date unavailable' : date > Date.parse(assessedAt) ? 'Publication date is after assessment time; verify before using' : ''}];
  }).slice(0,10);
}
