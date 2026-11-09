// Rule: caller-ID health.
//  1. Detect: a number whose pickup over the last 24h is far below the other numbers is treated as
//     spam-flagged and taken out of rotation. Fair comparison: the dialler picks the number at random
//     per call, so every number sees the same mix of people and hours.
//  2. Spread: heavily used numbers get labelled as spam by carriers, so calls are spread evenly across
//     healthy numbers. A number we have never used starts on 5% "probation" until 150 dials prove it.
import { type Ctx, type Change, normalize, tv, supervisorChangedRecently } from "./governance.ts";
import { pGreater, rate } from "./stats.ts";
import { affectedLeads, pct } from "./rule-helpers.ts";

const MIN_DIALS = 150; // enough to tell 30% pickup from 17% with high confidence
const BAD_RATIO = 0.75; // "bad" = pickup below 75% of the others (normal load effects are ~10-15%)
const PROBATION = 0.05; // share for an untested number
const MIN_MOVE = 0.05; // don't churn the config for tiny rebalances

type Counts = Record<string, { n: number; x: number }>;

export function callerIdRule(ctx: Ctx, draft: any): Change | null {
  const { store, wf, now } = ctx;
  const wid = wf.workflow_id;
  if (supervisorChangedRecently(ctx, "caller_id", 48)) return null; // never silently undo a supervisor
  const options: string[] = wf.options.caller_id;
  const bad: string[] = store.getJson(`bad_dids:${wid}`) ?? [];
  const recent = counts(ctx, now.idx - 24);
  const lifetime = counts(ctx, -1e9);

  // 1. detect newly bad numbers
  for (const d of options) {
    const me = recent[d];
    if (bad.includes(d) || !me || me.n < MIN_DIALS) continue;
    const others = options.filter((o) => o !== d && !bad.includes(o) && recent[o]);
    const n = others.reduce((s, o) => s + recent[o].n, 0);
    const x = others.reduce((s, o) => s + recent[o].x, 0);
    if (n < MIN_DIALS) continue;
    if (rate(me.x, me.n) < BAD_RATIO * rate(x, n) && pGreater(x, n, me.x, me.n) < 0.01) {
      bad.push(d);
      store.setJson(`bad_dids:${wid}`, bad);
      store.logDecision(now.ts, wid, "caller_id_flagged",
        `caller ID ${d} pickup ${pct(me.x, me.n)} vs ${pct(x, n)} on the other numbers (last 24h)`, { did: d, me, others: { n, x } });
    }
  }

  // 2. target allocation: proven healthy numbers share evenly, untested ones on probation
  const healthy = options.filter((d) => !bad.includes(d));
  const proven = healthy.filter((d) => (lifetime[d]?.n ?? 0) >= MIN_DIALS);
  const probation = healthy.filter((d) => !proven.includes(d));
  if (proven.length === 0) return null; // nothing safe to move to — leave it, the summary screen shows it
  const target: Record<string, number> = {};
  for (const d of probation) target[d] = PROBATION;
  for (const d of proven) target[d] = (1 - PROBATION * probation.length) / proven.length;

  const current = draft.allocations.default.caller_id;
  if (tv(current, target) < MIN_MOVE) return null;

  // auto-apply can move at most max_shift per change: take a step toward the target, the next hour takes the next step
  const pol = wf.governance.auto_apply;
  const auto = pol.enabled && pol.allowed_dims.includes("caller_id");
  const next = normalize(auto ? stepToward(current, target, pol.max_shift) : target);
  draft.allocations.default.caller_id = next;

  const badInUse = bad.filter((d) => (current[d] ?? 0) > 0);
  const share = badInUse.reduce((s, d) => s + current[d], 0);
  return {
    kind: "caller_id",
    urgent: badInUse.length > 0,
    summary: badInUse.length
      ? `Move calls off caller ID ${badInUse.join(", ")} (pickup far below the other numbers)`
      : `Spread calls across caller IDs ${Object.keys(next).join(", ")}`,
    rationale: badInUse.length
      ? `${badInUse.join(", ")} carried ${Math.round(share * 100)}% of dials with pickup under ${BAD_RATIO * 100}% of the other numbers.`
      : `Spreading dials keeps each number's volume low so carriers don't label it spam. ` +
        (probation.length ? `${probation.join(", ")} start at ${PROBATION * 100}% until ${MIN_DIALS} dials prove them.` : ""),
    diff: { "allocations.default.caller_id": { from: current, to: next } },
    dryRun: {
      caller_id_pickup_last_24h: Object.fromEntries(options.map((d) => [d, recent[d] ? `${pct(recent[d].x, recent[d].n)} of ${recent[d].n} dials` : "no dials"])),
    },
    impact: badInUse.length ? Math.min(1, 0.4 + share) : 0.15, // pulling a bad number matters; rebalancing is minor
    affected: affectedLeads(ctx, null),
    evidence: { bad_caller_ids: bad },
  };
}

function counts(ctx: Ctx, sinceIdx: number): Counts {
  const rows = ctx.store.all(
    "SELECT caller_id k, SUM(dials) n, SUM(connected) x FROM stats WHERE workflow_id = ? AND day * 24 + hour >= ? GROUP BY caller_id",
    ctx.wf.workflow_id, sinceIdx);
  return Object.fromEntries(rows.map((r) => [r.k, { n: r.n, x: r.x }]));
}

// Move from `cur` toward `target`, but no more than `maxShift` of traffic in one step.
function stepToward(cur: Record<string, number>, target: Record<string, number>, maxShift: number) {
  const lam = Math.min(1, (maxShift - 0.005) / tv(cur, target));
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(cur), ...Object.keys(target)])) {
    out[k] = (cur[k] ?? 0) + lam * ((target[k] ?? 0) - (cur[k] ?? 0));
  }
  return out;
}
