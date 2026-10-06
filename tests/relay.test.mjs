import assert from "node:assert/strict";
import test from "node:test";
import { fetchKalshiEventPage } from "../integrations.js";

test("an outdated relay gives actionable restart instructions", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response("Not found", { status: 404 }));
  await assert.rejects(fetchKalshiEventPage(), /Restart it with npm start/);
});
