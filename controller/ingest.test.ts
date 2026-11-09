import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./store.ts";
import { ingestChunk, simTime } from "./ingest.ts";

const call = (connected: boolean) => JSON.stringify({
  type: "call", ts: "2027-01-05T14:15:00+05:30", workflow_id: "wf", cohort_id: "default",
  variant: { welcome_message: "W1", voice: "V1", caller_id: "D1", prompt_version: "P1" },
  connected, engaged: false, qa: { hallucination_flag: false },
});
const chunk = [call(true), call(false), call(true)].join("\n");

test("simTime converts timestamps to sim day and hour", () => {
  assert.deepEqual(simTime("2027-01-05T14:15:00+05:30"), { minute: 2295, day: 1, hour: 14, idx: 38 });
  assert.equal(simTime("2027-01-03T09:00:00+05:30").day, -1); // history days are negative
});

test("calls are added up into one stats row", () => {
  const s = openStore(":memory:");
  ingestChunk(s, 0, chunk);
  const r = s.db.prepare("SELECT dials, connected FROM stats").get() as any;
  assert.deepEqual({ ...r }, { dials: 3, connected: 2 });
});

test("ingesting the same chunk twice (e.g. after a restart) counts it once", () => {
  const s = openStore(":memory:");
  ingestChunk(s, 0, chunk);
  ingestChunk(s, 0, chunk);
  const r = s.db.prepare("SELECT dials FROM stats").get() as any;
  assert.equal(r.dials, 3);
});
