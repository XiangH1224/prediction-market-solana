import test from 'node:test';
import assert from 'node:assert/strict';
import {gnewsQuery} from '../gnews-query.mjs';
test('market punctuation and boolean words are serialized as literal search terms',()=>{
 assert.equal(gnewsQuery('Will Bitcoin be above $100,000?'),'"Will" "Bitcoin" "be" "above" "100" "000"');
 assert.equal(gnewsQuery('S&P 500 (up/down) AND NOT "crash"?'),'"S" "P" "500" "up" "down" "AND" "NOT" "crash"');
 assert.equal(gnewsQuery("Mbappé’s goals - Paris Saint-Germain?"),'"Mbappé’s" "goals" "Paris" "Saint-Germain"');
});
test('length limit preserves whole terms and balanced quotes',()=>{
 const q=gnewsQuery('Federal Reserve '.repeat(40));assert.ok(q.length<=200);assert.match(q,/^("[^"\n]+" ?)+$/);
 assert.throws(()=>gnewsQuery('? () $$$'),/no usable/);
 assert.throws(()=>gnewsQuery('x'.repeat(201)),/no usable/);
});
