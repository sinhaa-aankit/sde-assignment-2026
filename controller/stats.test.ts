import { test } from "node:test";
import assert from "node:assert/strict";
import { normCdf, pGreater, pAbove, holm } from "./stats.ts";

test("normal CDF matches known values", () => {
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(-2.326) - 0.01) < 1e-4);
});

test("a clear difference is significant, a tiny one is not", () => {
  assert.ok(pGreater(330, 500, 275, 500) < 0.001); // 66% vs 55%
  assert.ok(pGreater(28, 50, 27, 50) > 0.3); // 56% vs 54% on 50 calls: noise
  assert.equal(pGreater(1, 0, 1, 10), 1); // no data -> never significant
});

test("hallucination spike vs baseline", () => {
  assert.ok(pAbove(27, 500, 0.015) < 0.001); // 5.4% flags vs 1.5% normal
  assert.ok(pAbove(9, 500, 0.015) > 0.05); // 1.8%: within noise
});

test("Holm corrects for testing several challengers at once", () => {
  assert.deepEqual(holm([0.004, 0.03, 0.2], 0.05), [true, false, false]); // 0.03 > 0.05/2
  assert.deepEqual(holm([0.01, 0.02], 0.05), [true, true]);
});
