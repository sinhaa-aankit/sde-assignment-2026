import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./store.ts";
import { type Ctx, canAutoApply, canSendApproval, changedDims, maxShift, tv } from "./governance.ts";

const base = {
  cohorts: [], prompt_version: "P1", schedule: { hour_weights: {}, lead_preferred_hour: {} },
  allocations: { default: { welcome_message: { W1: 1 }, voice: { V1: 1 }, caller_id: { D1: 0.5, D2: 0.5 } } },
};
const wf = (auto: object, extra: object = {}) => ({
  workflow_id: "wf", tenant_id: "t",
  governance: { auto_apply: auto, approver_hours: [10, 19], max_requests_per_24h: 3 }, ...extra,
});
const ctx = (w: any, hour = 12): Ctx => ({
  store: openStore(":memory:"), sim: null as any, wf: w, credits: 100,
  cfg: { version: 1, config: base }, now: { ts: "", minute: hour * 60, day: 0, hour, idx: hour },
});
const withCaller = (d: object) => ({ ...base, allocations: { default: { ...base.allocations.default, caller_id: d } } });
const withVoice = (d: object) => ({ ...base, allocations: { default: { ...base.allocations.default, voice: d } } });

test("tv distance = share of traffic that moves", () => {
  assert.ok(Math.abs(tv({ D1: 0.5, D2: 0.5 }, { D1: 0.7, D2: 0.3 }) - 0.2) < 1e-9);
  assert.equal(maxShift(base, withCaller({ D1: 1 })), 0.5);
});

test("changed dims are detected per dimension", () => {
  assert.deepEqual(changedDims(base, withVoice({ V2: 1 })), ["voice"]);
  assert.deepEqual(changedDims(base, { ...base, prompt_version: "P3" }), ["prompt_version"]);
});

test("auto-apply only for operational dims within max_shift", () => {
  const pol = { enabled: true, allowed_dims: ["caller_id", "voice"], max_shift: 0.2 };
  assert.equal(canAutoApply(ctx(wf(pol)), withCaller({ D1: 0.6, D2: 0.4 })), true);
  assert.equal(canAutoApply(ctx(wf(pol)), withCaller({ D1: 1 })), false, "shift 0.5 > 0.2");
  assert.equal(canAutoApply(ctx(wf(pol)), withVoice({ V1: 0.9, V2: 0.1 })), false, "voice is customer-facing: never auto, even if policy allows");
  assert.equal(canAutoApply(ctx(wf({ enabled: false, allowed_dims: [], max_shift: 0 })), withCaller({ D1: 0.6, D2: 0.4 })), false);
});

test("approval requests respect approver hours and client preferences", () => {
  const pol = { enabled: false, allowed_dims: [], max_shift: 0 };
  assert.equal(canSendApproval(ctx(wf(pol), 12)), true);
  assert.equal(canSendApproval(ctx(wf(pol), 8)), false, "before approver hours");
  assert.equal(canSendApproval(ctx(wf(pol), 8), true), true, "incidents go any time");
  assert.equal(canSendApproval(ctx({ ...wf(pol), tenant_id: "kestrel_finance" }, 10)), false, "Kestrel: not before 11:00");
});
