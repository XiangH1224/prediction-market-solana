const cache = new Map();
const pending = new Map();
const CACHE_MS = 5 * 60 * 1000;

export async function fetchGoogleNewsRss(query) {
  const search = String(query || "").trim().slice(0, 240);
  if (!search) throw Object.assign(new Error("A search query is required."), { status: 400 });
  const cached = cache.get(search);
  if (cached?.expiresAt > Date.now()) return cached.xml;
  if (pending.has(search)) return pending.get(search);
  const operation = (async () => {
    const url = new URL("https://news.google.com/rss/search");
    url.search = new URLSearchParams({ q: search, hl: "en-US", gl: "US", ceid: "US:en" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/rss+xml, application/xml, text/xml" },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(response.status === 403
          ? "Google News denied the relay request. Use a configured GNews API key or retry later."
          : `Google News is unavailable (HTTP ${response.status}). Please retry later.`);
      }
      const xml = await response.text();
      if (!/<rss[\s>]/i.test(xml)) throw new Error("Google News returned an unreadable feed.");
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(search, { xml, expiresAt: Date.now() + CACHE_MS });
      return xml;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Google News timed out. Please retry.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();
  pending.set(search, operation);
  try {
    return await operation;
  } finally {
    pending.delete(search);
  }
}
