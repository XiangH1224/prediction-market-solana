// Market titles are plain text, not GNews's boolean query language.
// Quote complete terms so punctuation/operators cannot become query syntax.
export function gnewsQuery(value) {
  const tokens = String(value || '').normalize('NFKC').match(/[\p{L}\p{M}\p{N}]+(?:['’.-][\p{L}\p{M}\p{N}]+)*/gu) || [];
  const terms = [];
  let length = 0;
  for (const token of tokens) {
    const term = `"${token}"`;
    const next = length + (terms.length ? 1 : 0) + term.length;
    if (next > 200) break;
    terms.push(term);
    length = next;
  }
  if (!terms.length) throw Object.assign(new Error('The market has no usable news search terms.'), {status:400});
  return terms.join(' ');
}
