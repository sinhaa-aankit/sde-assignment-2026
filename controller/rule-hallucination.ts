// Rule: hallucination incidents.  detect -> find a fix -> validate -> propose with evidence -> verify after apply.
//
//  Detect: over the last 6 hours, the flagged-call rate for the current prompt is well above the normal
//          rate (learned from history) AND statistically above it. Needs 200+ connected calls, so one bad
//          call never triggers anything. A long-proven prompt is never swapped automatically: we page.
//  Fix:    first choice is a prompt we have already seen run safely on real calls (free, and we know its
//          engagement). Only if there is none do we pay for LLM suggestions.
//  Validate: 500 synthetic conversations; pass rate must be >= 0.98 (stricter than the 0.97 policy floor:
//          the healthy production prompt validates at ~0.99).
//  Credits: a fix is found once per incident and reused if the request has to be resent.
//  Verify: after the fix is live, 200+ connected calls must show the rate back under 2x normal.
import { type Ctx, type Change, alert } from "./governance.ts";
import { pAbove, rate } from "./stats.ts";
import { affectedLeads, pct } from "./rule-helpers.ts";

const WINDOW_H = 6;
// Two alarm levels. A prompt that just changed is the prime suspect: sensitive alarm.
// A prompt proven on thousands of calls needs much stronger evidence (we test every hour, so noise adds up).
const NEW_PROMPT = { minConnected: 200, ratio: 2, alpha: 0.001 };
const ESTABLISHED = { minConnected: 300, ratio: 2.5, alpha: 0.0001 };
const MIN_CONNECTED = 200; // for verifying a fix
const N_VALIDATE = 500; // 5 credits
const PASS_BAR = 0.98;
const CREDIT_RESERVE = 20; // never spend the last credits: the next incident needs them
const MAX_CANDIDATES = 3;

export async function hallucinationRule(ctx: Ctx, draft: any): Promise<Change | null> {
  const { store, sim, wf, now } = ctx;
  const wid = wf.workflow_id;
  const key = `incident:${wid}`;
  const prompt = draft.prompt_version;
  const baseline = baselineRate(ctx);
  const window = flags(ctx, prompt, now.idx - WINDOW_H);
  const established = knownGood(ctx).includes(prompt);
  const t = established ? ESTABLISHED : NEW_PROMPT;
  const spiking = window.c >= t.minConnected && rate(window.h, window.c) >= t.ratio * baseline
    && pAbove(window.h, window.c, baseline) < t.alpha;
  let inc = store.getJson(key);

  // a fix is live: check it actually worked on real calls
  if (inc?.status === "applied") {
    const after = flags(ctx, prompt, inc.applied_idx);
    if (after.c < MIN_CONNECTED) return null;
    const ok = rate(after.h, after.c) < NEW_PROMPT.ratio * baseline;
    store.setJson(key, { ...inc, status: ok ? "verified" : "open", fix: ok ? inc.fix : undefined, verified_ts: now.ts });
    if (ok) store.logDecision(now.ts, wid, "incident_verified", `prompt ${prompt}: flag rate ${pct(after.h, after.c)} on ${after.c} calls after the fix`, after);
    else alert(ctx, `fix ${prompt} did not work: flag rate still ${pct(after.h, after.c)}`, after);
    return null;
  }
  if (store.one("SELECT 1 FROM proposals WHERE workflow_id = ? AND kind = 'incident' AND status IN ('sending','pending','approved')", wid)) {
    return null; // our fix request is waiting on the approver
  }
  if (!spiking) {
    if (inc?.status === "open" && window.c >= MIN_CONNECTED) store.setJson(key, { ...inc, status: "closed", closed_ts: now.ts });
    return null;
  }

  // new incident (or the prompt changed again during an open one)
  if (!inc || inc.status !== "open" || inc.bad_prompt !== prompt) {
    inc = { status: "open", bad_prompt: prompt, detected_ts: now.ts, tried: {} };
    store.setJson(key, inc);
    alert(ctx, `hallucination spike on prompt ${prompt}: ${pct(window.h, window.c)} of ${window.c} calls flagged vs normal ${(baseline * 100).toFixed(1)}%`, window);
  }

  // The current prompt has already run safely on thousands of calls: the prompt did not change, so swapping
  // it is the wrong fix (and an unknown LLM prompt can cost engagement). Page a human instead.
  if (established) {
    if (!inc.paged) alert(ctx, `spike on established prompt ${prompt}: not changing prompts automatically — check the detector / recent changes`);
    store.setJson(key, { ...inc, paged: true });
    return null;
  }

  if (!inc.fix) inc.fix = await findFix(ctx, inc, prompt);
  store.setJson(key, inc);
  if (!inc.fix) return null;

  draft.prompt_version = inc.fix.prompt;
  const fixStats = flags(ctx, inc.fix.prompt, -1e9);
  return {
    kind: "incident", urgent: true,
    incident: inc,
    summary: `Fix hallucinations: switch prompt ${prompt} → ${inc.fix.prompt}`,
    rationale: `${pct(window.h, window.c)} of ${window.c} connected calls flagged in the last ${WINDOW_H}h on ${prompt} ` +
      `vs ${(baseline * 100).toFixed(1)}% normally. ${inc.fix.prompt} ${inc.fix.source}; ` +
      `validation pass rate ${inc.fix.pass_rate} on ${N_VALIDATE} conversations (${inc.fix.validation_run_id}).`,
    diff: { prompt_version: { from: prompt, to: inc.fix.prompt } },
    dryRun: { [`prompt_${inc.fix.prompt}_on_real_calls`]: fixStats.c
      ? { connected: fixStats.c, flag_rate: pct(fixStats.h, fixStats.c), engagement_rate: pct(fixStats.e, fixStats.c) }
      : "never run on real calls" },
    impact: Math.min(1, rate(window.h, window.c) / baseline / 4),
    affected: affectedLeads(ctx, null),
    evidence: { validation_run_id: inc.fix.validation_run_id },
  };
}

async function findFix(ctx: Ctx, inc: any, badPrompt: string) {
  const { sim, wf } = ctx;
  const allowed: string[] = wf.options.prompt_version;
  let candidates = knownGood(ctx).filter((p) => p !== badPrompt && allowed.includes(p));
  let source = "ran safely on real calls before";
  if (!candidates.length) {
    if (!inc.llm && ctx.credits >= 3 + CREDIT_RESERVE) {
      inc.llm = (await sim.post("/llm/suggest-fixes", { workflow_id: wf.workflow_id,
        problem: `hallucination flags spiked on prompt ${badPrompt}` })).suggestions;
      ctx.credits -= 3;
    }
    candidates = (inc.llm ?? []).map((s: any) => s.prompt_version).filter((p: string) => p !== badPrompt);
    source = "was suggested by the LLM";
  }
  const bar = Math.max(PASS_BAR, wf.governance.min_validation_pass_rate ?? 0);
  for (const p of candidates.slice(0, MAX_CANDIDATES)) {
    if (inc.tried[p] !== undefined) continue;
    if (ctx.credits < N_VALIDATE / 100 + CREDIT_RESERVE) {
      alert(ctx, `not enough credits to validate a fix (${ctx.credits} left)`);
      return undefined;
    }
    const v = await ctx.sim.post("/validation/runs", { workflow_id: wf.workflow_id, prompt_version: p, n: N_VALIDATE });
    ctx.credits = v.credits_remaining;
    inc.tried[p] = v.pass_rate;
    ctx.store.logDecision(ctx.now.ts, wf.workflow_id, "validation_run", `${p}: pass rate ${v.pass_rate} (${v.validation_run_id})`, v);
    if (v.pass_rate >= bar) return { prompt: p, validation_run_id: v.validation_run_id, pass_rate: v.pass_rate, source };
  }
  alert(ctx, `no validated fix for prompt ${badPrompt}; tried ${JSON.stringify(inc.tried)}`);
  return undefined;
}

// Normal flag rate for this workflow, learned from history (before D0).
function baselineRate(ctx: Ctx): number {
  const r = ctx.store.one("SELECT SUM(connected) c, SUM(halluc) h FROM stats WHERE workflow_id = ? AND day < 0", ctx.wf.workflow_id);
  return r.c >= 500 ? Math.max(r.h / r.c, 0.005) : 0.015;
}

// Prompts that have run on 500+ real connected calls with a normal flag rate, most-used first.
function knownGood(ctx: Ctx): string[] {
  const base = baselineRate(ctx);
  return ctx.store.all("SELECT prompt, SUM(connected) c, SUM(halluc) h FROM stats WHERE workflow_id = ? GROUP BY prompt ORDER BY c DESC",
    ctx.wf.workflow_id).filter((r) => r.c >= 500 && r.h / r.c <= 1.5 * base).map((r) => r.prompt);
}

function flags(ctx: Ctx, prompt: string, sinceIdx: number) {
  const r = ctx.store.one(
    "SELECT COALESCE(SUM(connected),0) c, COALESCE(SUM(halluc),0) h, COALESCE(SUM(engaged),0) e FROM stats WHERE workflow_id = ? AND prompt = ? AND day * 24 + hour >= ?",
    ctx.wf.workflow_id, prompt, sinceIdx);
  return { c: r.c as number, h: r.h as number, e: r.e as number };
}
