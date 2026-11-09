// Rule: A/B tests on welcome message and voice, per cohort.
//
// One experiment = (workflow, cohort, dimension). Its life:
//   (none) --start--> exploring --winner--> promoted --decay--> rolled_back
//                         |--loser dropped (stays exploring)
//                         \--after 5 days: arms still behind control are dropped; when only control is left--> stopped
//   exploring/promoted --a supervisor changed it--> interrupted (left alone for 48h)
//
// Design choices (the interview questions):
//  - Control keeps 60%; the alternatives share 40%. Limits how many customers hear an untested variant.
//  - The simulator randomises welcome and voice independently, so both can be tested at once
//    (each comparison is balanced over the other dimension).
//  - No test before every arm has 200 connected calls. We look once a day; winners need p < 0.01
//    after Holm correction across alternatives (≈ 5% overall false-winner rate over ~8 daily looks).
//  - A winner must also beat control by 5% and not hurt the guardrail KPI (pickup).
//  - After promotion, 20% stays on the old control as a holdout so we can see if the winner stops winning.
//  - Only engagement-primary workflows: voice and greeting are heard after pickup, so they cannot move pickup.
import { type Ctx, type Change, clone, distOf, normalize, tv, supervisorChangedRecently } from "./governance.ts";
import { COHORT_DEFS, COHORT_IDS, COHORT_LABEL, cohortsAreOurs } from "./cohorts.ts";
import { holm, pBelow, pGreater, rate } from "./stats.ts";
import { affectedLeads, cohortShare, connectedPerDay, pct } from "./rule-helpers.ts";

const EXPLORE = 0.4; // traffic share for the alternatives while exploring
const HOLDOUT = 0.2; // traffic kept on the old control after promotion
const MIN_N = 200; // connected calls per arm before any test
const ALPHA_WIN = 0.01; // per daily look, Holm-corrected
const ALPHA_DROP = 0.05; // stop exposing customers to a clearly worse arm sooner
const MIN_LIFT = 0.05; // smaller lifts aren't worth a change request
const MAX_DAYS = 5; // give up on an experiment with no winner
const DECAY_DROP = 0.1; // winner rate fell 10% below what it won with
const DIMS: Record<string, string> = { welcome_message: "welcome", voice: "voice" }; // dim -> stats column

type Arm = { d: number; c: number; e: number }; // dials, connected, engaged

export function experimentRule(ctx: Ctx, draft: any): Change[] {
  if (ctx.wf.objective.primary !== "engagement_rate") return [];
  if (!cohortsAreOurs(draft)) return []; // a supervisor defined their own cohorts: don't fight them
  const changes: Change[] = [];
  for (const cohort of COHORT_IDS) {
    for (const dim of Object.keys(DIMS)) {
      if (ctx.wf.options[dim].length < 2 || supervisorChangedRecently(ctx, dim, 48)) continue;
      const c = decide(ctx, draft, cohort, dim);
      if (c) changes.push(c);
    }
  }
  if (changes.length && draft.cohorts.length === 0) draft.cohorts = clone(COHORT_DEFS);
  return changes;
}

function decide(ctx: Ctx, draft: any, cohort: string, dim: string): Change | null {
  const { store, wf, now } = ctx;
  const exp = store.one("SELECT * FROM experiments WHERE workflow_id = ? AND cohort = ? AND dim = ?", wf.workflow_id, cohort, dim);
  const current = distOf(draft, cohort, dim);
  const hours = exp ? now.idx - exp.since_idx : Infinity;

  if (exp && ["exploring", "promoted"].includes(exp.status) && tv(current, JSON.parse(exp.arms)) > 0.001) {
    store.run("UPDATE experiments SET status = 'interrupted', since_ts = ?, since_idx = ? WHERE workflow_id = ? AND cohort = ? AND dim = ?",
      now.ts, now.idx, wf.workflow_id, cohort, dim);
    store.logDecision(now.ts, wf.workflow_id, "experiment_interrupted",
      `${dim} for ${COHORT_LABEL[cohort]} was changed outside the controller — experiment stopped, hands off for 48h`, { current });
    return null;
  }
  if (!exp || (exp.status === "interrupted" && hours >= 48)) return start(ctx, draft, cohort, dim, current);
  if (exp.status === "exploring") return evaluate(ctx, draft, exp, cohort, dim, hours);
  if (exp.status === "promoted") return checkDecay(ctx, draft, exp, cohort, dim);
  return null; // stopped / rolled_back: done for this run
}

function start(ctx: Ctx, draft: any, cohort: string, dim: string, current: Record<string, number>): Change {
  const control = Object.entries(current).sort((a, b) => b[1] - a[1])[0][0];
  const challengers = ctx.wf.options[dim].filter((o: string) => o !== control);
  const arms: Record<string, number> = { [control]: 1 - EXPLORE };
  for (const o of challengers) arms[o] = EXPLORE / challengers.length;
  setDist(draft, cohort, dim, arms);

  const perDay = connectedPerDay(ctx) * cohortShare(ctx, cohort);
  const daysToSample = MIN_N / Math.max(perDay * (EXPLORE / challengers.length), 1);
  return {
    kind: "experiment",
    summary: `Test ${dim.replace("_", " ")} ${challengers.join("/")} vs ${control} for ${COHORT_LABEL[cohort]}`,
    rationale: `${control} has never been compared with the alternatives for ${COHORT_LABEL[cohort]}. ` +
      `${Math.round((1 - EXPLORE) * 100)}% stays on ${control}; nothing is promoted without a statistically clear win.`,
    diff: { [`allocations.${cohort}.${dim}`]: { from: current, to: arms } },
    dryRun: { [`${cohort}.${dim}`]: {
      cohort_connected_calls_per_day: Math.round(perDay),
      days_until_min_sample_per_arm: Math.round(daysToSample * 10) / 10,
      min_sample_per_arm: MIN_N,
      max_customers_on_untested_variant: `${EXPLORE * 100}% of ${COHORT_LABEL[cohort]}`,
    } },
    impact: 0.1, // a test, not a win: low expected impact, honestly scored
    affected: Math.round(affectedLeads(ctx, cohort) * EXPLORE),
    expUpdates: [{ cohort, dim, status: "exploring", control, arms }],
  };
}

function evaluate(ctx: Ctx, draft: any, exp: any, cohort: string, dim: string, hours: number): Change | null {
  const arms: Record<string, number> = JSON.parse(exp.arms);
  const data = armData(ctx, cohort, dim, exp.since_idx);
  const ctl = data[exp.control];
  const tested = Object.keys(arms).filter((o) => o !== exp.control && data[o].c >= MIN_N && ctl.c >= MIN_N);
  const label = COHORT_LABEL[cohort];
  const evidence = Object.fromEntries(Object.keys(arms).map((o) => [o, `${pct(data[o].e, data[o].c)} engaged of ${data[o].c} connected`]));

  // 1. winner? (Holm across all tested challengers, plus minimum lift and the pickup guardrail)
  const sig = holm(tested.map((o) => pGreater(data[o].e, data[o].c, ctl.e, ctl.c)), ALPHA_WIN);
  const winners = tested
    .filter((o, i) => sig[i] && rate(data[o].e, data[o].c) >= rate(ctl.e, ctl.c) * (1 + MIN_LIFT) && guardrailOk(ctx, data[o], ctl))
    .sort((a, b) => rate(data[b].e, data[b].c) - rate(data[a].e, data[a].c));
  if (winners.length) {
    const w = winners[0];
    const lift = rate(data[w].e, data[w].c) / rate(ctl.e, ctl.c) - 1;
    const next = { [w]: 1 - HOLDOUT, [exp.control]: HOLDOUT };
    setDist(draft, cohort, dim, next);
    return {
      kind: "experiment",
      summary: `Promote ${w} (${dim.replace("_", " ")}) for ${label}: +${(lift * 100).toFixed(1)}% engagement`,
      rationale: `${w} beat ${exp.control} with p<${ALPHA_WIN} after correcting for ${tested.length} comparisons; ` +
        `${HOLDOUT * 100}% stays on ${exp.control} as a holdout to catch decay.`,
      diff: { [`allocations.${cohort}.${dim}`]: { from: arms, to: next } },
      dryRun: { [`${cohort}.${dim}`]: { measured_since: exp.since_ts, arms: evidence,
        expected_engagement_lift_for_cohort: `${(lift * (1 - HOLDOUT) * 100).toFixed(1)}%` } },
      impact: Math.min(1, lift * (1 - HOLDOUT) * cohortShare(ctx, cohort) * 5),
      affected: affectedLeads(ctx, cohort),
      expUpdates: [{ cohort, dim, status: "promoted", control: exp.control, winner: w, arms: next,
        win_rate: rate(data[w].e, data[w].c), control_rate: rate(ctl.e, ctl.c) }],
    };
  }

  // 2. clear losers? stop exposing customers to them (control takes their traffic)
  let losers = tested.filter((o) => pGreater(ctl.e, ctl.c, data[o].e, data[o].c) < ALPHA_DROP);
  // 3. out of time? also drop every alternative that is not at least matching control so far,
  //    so whatever keeps running looks at least as good as what customers had before
  const timeUp = hours >= MAX_DAYS * 24;
  if (timeUp) {
    losers = Object.keys(arms).filter((o) => o !== exp.control && rate(data[o].e, data[o].c) < rate(ctl.e, ctl.c));
  }
  if (!losers.length) return null;

  const next = { ...arms };
  for (const o of losers) delete next[o];
  next[exp.control] = 1 - Object.entries(next).filter(([o]) => o !== exp.control).reduce((s, [, v]) => s + v, 0);
  const normalized = normalize(next);
  setDist(draft, cohort, dim, normalized);
  const done = Object.keys(normalized).length === 1;
  return {
    kind: "experiment",
    summary: timeUp ? `Trim ${dim.replace("_", " ")} test for ${label}: drop ${losers.join(", ")} (behind ${exp.control} after ${MAX_DAYS} days)`
      : `Stop ${losers.join(", ")} (${dim.replace("_", " ")}) for ${label}: clearly worse than ${exp.control}`,
    rationale: timeUp ? `After ${MAX_DAYS} days ${losers.join(", ")} still trail ${exp.control}; only options at least matching it keep running.`
      : `${losers.join(", ")} engaged worse than ${exp.control} (p<${ALPHA_DROP}); its traffic goes back to ${exp.control}.`,
    diff: { [`allocations.${cohort}.${dim}`]: { from: arms, to: normalized } },
    dryRun: { [`${cohort}.${dim}`]: { measured_since: exp.since_ts, arms: evidence } },
    impact: 0.2,
    affected: affectedLeads(ctx, cohort),
    expUpdates: [{ cohort, dim, status: done ? "stopped" : "exploring", control: exp.control, arms: normalized, keep_since: !done }],
  };
}

// After promotion: roll back if the holdout now beats the winner, or the winner fell well below
// what it won with while the holdout did not (so it isn't just a bad day for everyone).
function checkDecay(ctx: Ctx, draft: any, exp: any, cohort: string, dim: string): Change | null {
  const data = armData(ctx, cohort, dim, Math.max(exp.since_idx, ctx.now.idx - 48));
  const w = data[exp.winner], c = data[exp.control];
  const holdoutWins = w.c >= 150 && c.c >= 150 && pGreater(c.e, c.c, w.e, w.c) < 0.1;
  const winnerFell = w.c >= MIN_N && rate(w.e, w.c) < exp.win_rate * (1 - DECAY_DROP) && pBelow(w.e, w.c, exp.win_rate) < 0.01;
  const holdoutSteady = c.c < 50 || rate(c.e, c.c) >= exp.control_rate * 0.95;
  if (!holdoutWins && !(winnerFell && holdoutSteady)) return null;

  const arms = JSON.parse(exp.arms);
  const next = { [exp.control]: 1 };
  setDist(draft, cohort, dim, next);
  return {
    kind: "experiment",
    summary: `Roll back ${exp.winner} → ${exp.control} (${dim.replace("_", " ")}) for ${COHORT_LABEL[cohort]}: winner stopped winning`,
    rationale: `Last 48h: ${exp.winner} ${pct(w.e, w.c)} vs holdout ${exp.control} ${pct(c.e, c.c)}; ` +
      `${exp.winner} won with ${(exp.win_rate * 100).toFixed(1)}%.`,
    diff: { [`allocations.${cohort}.${dim}`]: { from: arms, to: next } },
    dryRun: { [`${cohort}.${dim}`]: { last_48h: { [exp.winner]: `${pct(w.e, w.c)} of ${w.c}`, [exp.control]: `${pct(c.e, c.c)} of ${c.c}` } } },
    impact: Math.min(1, Math.max(0.3, (exp.win_rate - rate(w.e, w.c)) / exp.win_rate * 5)),
    affected: affectedLeads(ctx, cohort),
    expUpdates: [{ cohort, dim, status: "rolled_back", control: exp.control, winner: exp.winner, arms: next,
      win_rate: exp.win_rate, control_rate: exp.control_rate }],
  };
}

// Only real calls count: what each variant actually got since `sinceIdx`, in this cohort.
function armData(ctx: Ctx, cohort: string, dim: string, sinceIdx: number): Record<string, Arm> {
  const col = DIMS[dim];
  const rows = ctx.store.all(
    `SELECT ${col} k, SUM(dials) d, SUM(connected) c, SUM(engaged) e FROM stats
     WHERE workflow_id = ? AND cohort = ? AND day * 24 + hour >= ? GROUP BY ${col}`,
    ctx.wf.workflow_id, cohort, sinceIdx);
  const out: Record<string, Arm> = {};
  for (const o of ctx.wf.options[dim]) out[o] = { d: 0, c: 0, e: 0 };
  for (const r of rows) out[r.k] = { d: r.d, c: r.c, e: r.e };
  return out;
}

// Guardrail: the winner must not cut pickup by more than the workflow allows (read as a relative drop).
function guardrailOk(ctx: Ctx, arm: Arm, ctl: Arm): boolean {
  const maxDrop = ctx.wf.objective.guardrail?.pickup_rate_max_drop;
  if (maxDrop == null) return true;
  const worse = rate(arm.c, arm.d) < rate(ctl.c, ctl.d) * (1 - maxDrop);
  return !(worse && pGreater(ctl.c, ctl.d, arm.c, arm.d) < 0.05);
}

function setDist(draft: any, cohort: string, dim: string, dist: Record<string, number>) {
  draft.allocations[cohort] ??= {};
  draft.allocations[cohort][dim] = normalize(dist);
}
