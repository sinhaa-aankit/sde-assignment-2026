import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./store.ts";

const row = {
  workflow_id: "wf", day: 0, hour: 10, cohort: "default",
  welcome: "W1", voice: "V1", caller_id: "D1", prompt: "P1",
  dials: 10, connected: 3, engaged: 2, halluc: 0,
};

test("stats with the same key are added up, not duplicated", () => {
  const s = openStore(":memory:");
  s.addStat(row);
  s.addStat(row);
  const r = s.db.prepare("SELECT COUNT(*) AS n, SUM(dials) AS dials FROM stats").get() as any;
  assert.equal(r.n, 1);
  assert.equal(r.dials, 20);
});

test("a failed transaction saves nothing", () => {
  const s = openStore(":memory:");
  assert.throws(() => s.tx(() => {
    s.set("last_chunk", "5");
    throw new Error("crash mid-chunk");
  }));
  assert.equal(s.get("last_chunk"), undefined);
});

test("decisions are logged for the audit trail", () => {
  const s = openStore(":memory:");
  s.logDecision("D1 10:00", "wf", "proposal", "switch voice", { why: "test" });
  const r = s.db.prepare("SELECT * FROM decisions").get() as any;
  assert.equal(r.summary, "switch voice");
});
