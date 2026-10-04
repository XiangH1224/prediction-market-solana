import assert from 'node:assert/strict';
import test from 'node:test';
import { coverageQueries } from '../integrations.js';

test('coverage search broadens an exact question while retaining the named subject', () => {
  assert.deepEqual(coverageQueries({ title: 'Will Alex de Minaur win?', eventTitle: 'de Minaur vs Rublev' }), ['Will Alex de Minaur win?', 'de Minaur vs Rublev']);
  assert.deepEqual(coverageQueries({ title: 'Will Bitcoin be above $100,000?' }), ['Will Bitcoin be above $100,000?', 'Bitcoin']);
});

test('coverage queries deduplicate and never issue an empty search', () => {
  assert.deepEqual(coverageQueries({title: 'Inflation'}), ['Inflation']);
  assert.deepEqual(coverageQueries({}), []);
});
