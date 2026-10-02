import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const host = "127.0.0.1";
const port = 4178;
const cache = new Map();
const cacheDurationMs = 5 * 60 * 1000;
const minimumIntervalMs = 1500;
let nextRequestAt = 0;
let requestQueue = Promise.resolve();

function send(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Cache-Control": "no-store",
    "Content-Type": contentType
  });
  response.end(body);
}

function fetchFeed(query) {
  const cached = cache.get(query);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.xml);

  const operation = requestQueue.then(async () => {
    const remaining = nextRequestAt - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    nextRequestAt = Date.now() + minimumIntervalMs;

    const feedUrl = new URL("https://news.google.com/rss/search");
    feedUrl.search = new URLSearchParams({ q: `${query} when:7d`, hl: "en-US", gl: "US", ceid: "US:en" });
    const { stdout } = await execFileAsync("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "15",
      "--header",
      "Accept: application/rss+xml, application/xml, text/xml",
      feedUrl.href
    ], { encoding: "utf8", maxBuffer: 2_000_000 });
    if (!stdout.trim().startsWith("<?xml") && !stdout.includes("<rss")) {
      throw new Error("Google News returned an invalid RSS feed.");
    }
    cache.set(query, { xml: stdout, expiresAt: Date.now() + cacheDurationMs });
    return stdout;
  });
  requestQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    send(response, 204, "");
    return;
  }
  if (request.method !== "GET") {
    send(response, 405, "Method not allowed");
    return;
  }

  const url = new URL(request.url, `http://${host}:${port}`);
  if (url.pathname !== "/search") {
    send(response, 404, "Not found");
    return;
  }
  const query = (url.searchParams.get("q") || "").trim().slice(0, 240);
  if (!query) {
    send(response, 400, "A search query is required");
    return;
  }

  try {
    const xml = await fetchFeed(query);
    send(response, 200, xml, "application/rss+xml; charset=utf-8");
  } catch (error) {
    send(response, 502, error.message || "Could not retrieve Google News RSS");
  }
});

server.listen(port, host, () => {
  console.log(`Google News RSS relay listening on http://${host}:${port}`);
});
