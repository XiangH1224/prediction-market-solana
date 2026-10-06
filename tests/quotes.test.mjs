import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const source = (await readFile(new URL("../flow.js", import.meta.url), "utf8"))
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*"\.\/integrations.js";/, "")
  .replace(/bootstrap\(\);\s*$/, "");

function panel(fetchQuote = async () => ({}), storage) {
  const element = { addEventListener() {}, innerHTML: "" };
  const networkRequests = [];
  const scheduled = [];
  const context = vm.createContext({
    document: { querySelector: () => element, addEventListener() {} },
    fetchKalshiMarketQuote: fetchQuote,
    crypto: webcrypto,
    structuredClone,
    chrome: storage ? { storage: { local: storage } } : undefined,
    fetch: (...args) => { networkRequests.push(args); throw new Error("Unexpected network request"); },
    setTimeout: (callback) => { scheduled.push(callback); },
    setInterval, clearInterval
  });
  vm.runInContext(`${source}\nglobalThis.panel = { state, formatCents, getOutcomePrice, refreshSelectedQuote, renderPurchase, completeSimulatedPurchase, advanceSimulation, runPurchaseTransitions };`, context);
  return { ...context.panel, element, networkRequests, scheduled };
}

test("missing quotes stay unavailable while an explicit zero stays valid", () => {
  const app = panel();
  for (const value of [null, undefined, "", " "]) {
    assert.equal(app.formatCents(value), "—");
    assert.equal(app.getOutcomePrice("Yes", { yesAsk: value }), null);
  }
  assert.equal(app.formatCents("0"), "0¢");
  assert.equal(app.getOutcomePrice("Yes", { yesAsk: "0" }), 0);
  assert.equal(app.getOutcomePrice(null, { yesAsk: "0.5" }), null);
  for (const value of [-1, 2, "invalid"]) {
    assert.equal(app.getOutcomePrice("Yes", { yesAsk: value }), null);
  }
});

test("Yes and No confirmation persist a simulated DFlow route without a live request", async () => {
  for (const outcome of ["Yes", "No"]) {
    let saved;
    const app = panel(undefined, {set: async (value) => { saved = value; }});
    Object.assign(app.state, {
      stage: "purchase", event: {marketTicker: "A", yesAsk: "0.4", noAsk: "0.6"},
      analysis: {verdict: outcome}, purchaseOutcome: outcome, quantity: 3,
      quoteFreshConfirmed: true, quoteConfirmedAt: Date.now()
    });
    await app.completeSimulatedPurchase();
    assert.equal(saved, undefined);
    for (const action of ["connect", "route-ready", "review", "approve", "submit", "fill", "settle", "receipt"]) await app.advanceSimulation(action);
    const route = saved.lastSimulatedPurchase.route;
    assert.equal(route.mode, "simulation");
    assert.equal(route.output.outcome, outcome);
    assert.equal(route.output.quantity, 3);
    assert.equal(route.input.amountBaseUnits, outcome === "Yes" ? "1200000" : "1800000");
    assert.equal(route.executable, false);
    assert.equal(route.orderSent, false);
    assert.equal(route.transaction, null);
    assert.equal(route.signature, null);
    assert.equal(app.networkRequests.length, 0);
    assert.match(app.element.innerHTML, /Purchase complete/);
    assert.match(app.element.innerHTML, /NO FUNDS MOVE/);
  }
});

test("a storage failure leaves the local route visible and reports that it was not saved", async () => {
  const app = panel(undefined, {set: async () => { throw new Error("Storage unavailable"); }});
  Object.assign(app.state, {
    stage: "purchase", event: {marketTicker: "A", yesAsk: "0.5"}, analysis: {verdict: "Yes"},
    purchaseOutcome: "Yes", quoteFreshConfirmed: true, quoteConfirmedAt: Date.now()
  });
  await app.completeSimulatedPurchase();
  for (const action of ["connect", "route-ready", "review", "approve", "submit", "fill", "settle", "receipt"]) await app.advanceSimulation(action);
  assert.equal(app.state.stage, "complete");
  assert.equal(app.state.busy, false);
  assert.match(app.element.innerHTML, /could not be saved/);
  assert.equal(app.networkRequests.length, 0);
});

test("purchase refresh enables confirmation without a refresh prompt", async () => {
  const app = panel(async () => ({ marketTicker: "A", yesAsk: "0.5" }));
  Object.assign(app.state, { stage: "purchase", event: {marketTicker: "A"}, analysis: {verdict: "Yes"}, purchaseOutcome: "Yes" });
  app.renderPurchase();
  assert.doesNotMatch(app.element.innerHTML, /Refresh the market quote|Refresh quote before simulation|purchase-quote/);
  await app.refreshSelectedQuote({silent: true});
  assert.equal(app.state.quoteFreshConfirmed, true);
  assert.match(app.element.innerHTML, /50¢ × 1/);
  assert.match(app.element.innerHTML, /id="complete-simulated-purchase"[^>]*type="button" >Confirm Purchase/);
});

test("a changed stale quote requires review before recording a receipt", async () => {
  const app = panel(async () => ({ marketTicker: "A", yesAsk: "0.6" }));
  Object.assign(app.state, { stage: "purchase", event: {marketTicker: "A", yesAsk: "0.5"}, analysis: {verdict: "Yes"}, purchaseOutcome: "Yes" });
  await app.completeSimulatedPurchase();
  assert.equal(app.state.receipt, null);
  assert.match(app.state.message, /price changed/);
  await app.completeSimulatedPurchase();
  assert.equal(app.state.receipt.unitPriceCents, 60);
  for (const action of ["connect", "route-ready", "review", "approve", "submit", "fill", "settle", "receipt"]) await app.advanceSimulation(action);
  assert.equal(app.state.stage, "complete");
});

test("a delayed quote cannot restore a market after leaving it", async () => {
  let resolve;
  const app = panel(() => new Promise((done) => { resolve = done; }));
  app.state.event = { marketTicker: "A" };
  const pending = app.refreshSelectedQuote({ silent: true });
  app.state.event = null;
  resolve({ marketTicker: "A", yesAsk: "0.25" });
  assert.equal(await pending, null);
  assert.equal(app.state.event, null);
});

test("switching markets permits a new quote and ignores the previous response", async () => {
  const requests = new Map();
  const app = panel((market) => new Promise((resolve) => requests.set(market.marketTicker, resolve)));
  app.state.event = { marketTicker: "A" };
  const first = app.refreshSelectedQuote({ silent: true });
  const secondMarket = { marketTicker: "B" };
  app.state.event = secondMarket;
  const second = app.refreshSelectedQuote({ silent: true });
  requests.get("A")({ marketTicker: "A", yesAsk: "0.1" });
  await first;
  assert.equal(app.state.event, secondMarket);
  assert.equal(app.state.refreshingQuote, secondMarket);
  requests.get("B")({ marketTicker: "B", yesAsk: "0.7" });
  await second;
  assert.equal(app.state.event.marketTicker, "B");
  assert.equal(app.state.event.yesAsk, "0.7");
  assert.equal(app.state.refreshingQuote, false);
});

test("duplicate requests for the same selection are ignored", async () => {
  let resolve;
  let calls = 0;
  const app = panel(() => { calls++; return new Promise((done) => { resolve = done; }); });
  app.state.event = { marketTicker: "A" };
  const pending = app.refreshSelectedQuote({ silent: true });
  assert.equal(await app.refreshSelectedQuote({ silent: true }), null);
  assert.equal(calls, 1);
  resolve({ marketTicker: "A", yesAsk: "0.5" });
  await pending;
});

for (const scenario of ['success', 'insufficient', 'expired', 'failed', 'reject', 'cancel']) {
  test(`interactive DFlow simulation: ${scenario}`, async () => {
    const app = panel();
    Object.assign(app.state, {
      stage: 'purchase', event: {marketTicker:'A', yesAsk:'0.5'}, analysis:{verdict:'Yes'},
      purchaseOutcome:'Yes', quantity:2, quoteFreshConfirmed:true, quoteConfirmedAt:Date.now()
    });
    await app.completeSimulatedPurchase();
    assert.equal(app.state.stage, 'simulation');
    app.state.simulation.scenario = scenario;
    await app.advanceSimulation('connect');
    await app.advanceSimulation('route-ready');
    await app.advanceSimulation('review');
    if (scenario === 'insufficient' || scenario === 'expired') {
      assert.equal(app.state.simulation.step, scenario);
      assert.equal(app.state.simulation.reservedCents, 0);
      await app.advanceSimulation(scenario === 'insufficient' ? 'fund' : 'requote');
      if (scenario === 'expired') await app.advanceSimulation('route-ready');
      await app.advanceSimulation('review');
    }
    if (scenario === 'reject') {
      await app.advanceSimulation('reject');
      assert.equal(app.state.simulation.step, 'cancelled');
    } else {
      await app.advanceSimulation('approve');
      assert.equal(app.state.simulation.reservedCents, 100);
      await app.advanceSimulation('approve'); // repeated approval cannot double debit
      assert.equal(app.state.simulation.reservedCents, 100);
      if (scenario === 'cancel') await app.advanceSimulation('cancel');
      else {
        await app.advanceSimulation('submit');
        await app.advanceSimulation('fill');
        if (scenario !== 'failed') {
          await app.advanceSimulation('settle');
          await app.advanceSimulation('settle'); // settlement is idempotent
          assert.equal(app.state.simulation.position, 2);
          assert.equal(app.state.simulation.balanceCents, 99900);
        }
      }
    }
    assert.equal(app.state.simulation.reservedCents, 0);
    if (['reject','cancel','failed'].includes(scenario)) {
      assert.equal(app.state.simulation.balanceCents, 100000);
      assert.equal(app.state.simulation.position, 0);
    }
    assert.equal(app.networkRequests.length, 0);
    assert.equal(app.state.receipt.orderSent, false);
  });
}

test('wallet approval progresses automatically through processing and settlement', async () => {
  const app = panel();
  Object.assign(app.state, {
    stage:'purchase', event:{marketTicker:'A', title:'Market A', yesAsk:'0.5'}, analysis:{verdict:'Yes'},
    purchaseOutcome:'Yes', quantity:2, quoteFreshConfirmed:true, quoteConfirmedAt:Date.now()
  });
  await app.completeSimulatedPurchase();
  for (const action of ['select-wallet','connect','route-ready','review','approve']) {
    await app.advanceSimulation(action);
    const text = app.element.innerHTML.replace(/<[^>]*>/g, ' ');
    assert.doesNotMatch(text, /\b(demo|simulation|simulated|prototype|mock|practice)\b/i);
    assert.match(text, /No funds move/);
  }
  app.runPurchaseTransitions();
  assert.equal(app.state.simulation.step, 'submitting');
  await app.scheduled.shift()();
  assert.equal(app.state.simulation.step, 'submitted');
  await app.scheduled.shift()();
  assert.equal(app.state.simulation.step, 'settlement');
  await app.scheduled.shift()();
  assert.equal(app.state.simulation.step, 'settled');
  assert.equal(app.state.simulation.position, 2);
  assert.equal(app.networkRequests.length, 0);
  await app.advanceSimulation('receipt');
  assert.doesNotMatch(app.element.innerHTML.replace(/<[^>]*>/g, ' '), /\b(demo|simulation|simulated|prototype|mock|practice)\b/i);
});

test('scheduled execution cannot settle a cancelled or replaced session', async () => {
  const app = panel();
  Object.assign(app.state, {
    stage:'purchase', event:{marketTicker:'A', yesAsk:'0.5'}, analysis:{verdict:'Yes'},
    purchaseOutcome:'Yes', quoteFreshConfirmed:true, quoteConfirmedAt:Date.now()
  });
  await app.completeSimulatedPurchase();
  for (const action of ['connect','route-ready','review','approve']) await app.advanceSimulation(action);
  app.runPurchaseTransitions();
  await app.advanceSimulation('cancel');
  await app.scheduled.shift()();
  assert.equal(app.state.simulation.step, 'cancelled');
  assert.equal(app.state.simulation.position, 0);
  assert.equal(app.state.simulation.balanceCents, 100000);
});


test('a directional forecast still lets the user choose either outcome', () => {
  const app = panel();
  Object.assign(app.state, {stage:'purchase', event:{marketTicker:'A',yesAsk:'0.4',noAsk:'0.6'}, analysis:{verdict:'Yes'},purchaseOutcome:'No',quantity:3});
  app.renderPurchase();
  assert.match(app.element.innerHTML,/data-purchase-outcome="Yes"/);
  assert.match(app.element.innerHTML,/data-purchase-outcome="No"[^>]*aria-pressed="true"/);
  assert.match(app.element.innerHTML,/60¢ × 3 = \$1.80/);
  assert.match(app.element.innerHTML,/Estimated position: 3 No units/);
});

test('wallet connection prepares the route before quote review and approval', async () => {
  const app = panel();
  Object.assign(app.state, {stage:'purchase',event:{marketTicker:'A',yesAsk:'0.5'},analysis:{verdict:'Yes'},purchaseOutcome:'Yes',quoteFreshConfirmed:true,quoteConfirmedAt:Date.now()});
  await app.completeSimulatedPurchase();
  await app.advanceSimulation('select-wallet');
  assert.equal(app.state.simulation.step,'connection');
  await app.advanceSimulation('connect');
  assert.equal(app.state.simulation.step,'routing');
  await app.advanceSimulation('approve');
  assert.equal(app.state.simulation.reservedCents,0);
  app.runPurchaseTransitions();
  await app.scheduled.shift()();
  assert.equal(app.state.simulation.step,'quote');
  assert.match(app.element.innerHTML,/Review order/);
});
