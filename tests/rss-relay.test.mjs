import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchGoogleNewsRss } from '../rss-relay.mjs';

 test('RSS relay uses a fixed upstream and caches successful feeds', async (context) => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    assert.equal(url.origin, 'https://news.google.com');
    assert.equal(url.searchParams.get('q'), 'relay cache test');
    return new Response('<rss><channel><item><title>News</title></item></channel></rss>');
  });
  const first = await fetchGoogleNewsRss('relay cache test');
  assert.match(first, /<rss>/);
  assert.equal(await fetchGoogleNewsRss('relay cache test'), first);
  assert.equal(calls, 1);
});

test('RSS relay does not cache upstream denials', async (context) => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1 ? new Response('Forbidden', {status: 403}) : new Response('<rss></rss>');
  });
  await assert.rejects(fetchGoogleNewsRss('denied test'), /denied the relay request/);
  assert.equal(await fetchGoogleNewsRss('denied test'), '<rss></rss>');
});

test('RSS relay rejects blank queries and non-feed responses', async (context) => {
  await assert.rejects(fetchGoogleNewsRss(' '), /search query is required/);
  context.mock.method(globalThis, 'fetch', async () => new Response('<html>Unavailable</html>'));
  await assert.rejects(fetchGoogleNewsRss('invalid feed test'), /unreadable feed/);
});
