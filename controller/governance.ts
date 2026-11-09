// Governance client: the ONLY place that changes a workflow's config.
//
// Proposal lifecycle (our `proposals.status`):
//   sending -> pending -> approved -> applied
//                      \-> rejected | expired        approved -> lapsed (not applied in time)
//                                                    approved -> stale  (config changed under us, e.g. supervisor edit)
//   sending -> auto_applied                          (auto-apply path, only where policy AND our own rules allow)
//   sending -> failed                                (simulator refused the request outright)
// A proposal that ends without being applied is never resent: the rules re-decide next hour on fresh data,
// under a new proposal_id ("an expired proposal is a rejection — re-queue it with fresh data").
//
// Crash safety: we write the row as `sending` BEFORE calling the simulator, with a deterministic proposal_id.
// On restart, `reconcile` looks each `sending` row up in the simulator and finishes or forgets it.
import type { Store } from "./store.ts";
import { type Sim, SimError } from "./sim.ts";

export const AGENT_DIMS = ["welcome_message", "voice", "caller_id"];
// Things a customer never hears. Only these may ever be auto-applied, even where policy allows more
// (Northwind compliance: "no customer-facing change without a named human approval").
const OPERATIONAL_DIMS = ["caller_id", "schedule"];
// Voluntary limits from the client memos, stricter than the signed policy.
const CLIENT_PREFS: Record<string, { earliestHour?: number; maxPerDay?: number }> = {
  kestrel_finance: { earliestHour: 11, maxPerDay: 2 }, // Anita: "two a day, never before 11:00"
};
const DEFAULT_MAX_PER_DAY = 2; // approver fatigue: batch instead of drip-feeding

export type Now = { ts: string; minute: number; day: number; hour: number; idx: number };
export type Ctx = { sim: Sim; store: Store; wf: any; cfg: { version: number; config: any }; now: Now; credits: number };

// What a rule wants to change and why. Several Changes can be batched into one proposal.
export type Change = {
  kind: string; summary: string; rationale: string;
  diff: object; dryRun: object; impact: number; affected: number;
  evidence?: object; urgent?: boolean; expUpdates?: object[]; incident?: object;
};

// ---------- config helpers (mirror the simulator's contract in docs/SIMULATOR.md) ----------

export const clone = <T>(x: T): T => structuredClone(x);

export function distOf(config: any, cohort: string, dim: string): Record<string, number> {
  return config.allocations[cohort]?.[dim] ?? config.allocations.default[dim];
}

// Weights that sum to 1, rounded, zeros dropped — the same shape the simulator stores.
export function normalize(d: Record<string, number>): Record<string, number> {
  const total = Object.values(d).reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(d)) if (v / total > 0.0005) out[k] = Math.round((v / total) * 10000) / 10000;
  return out;
}

// Total-variation distance between two allocations: how much traffic moves.
export function tv(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let s = 0;
  for (const k of keys) s += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return s / 2;
}

function cohortKeys(a: any, b: any): string[] {
  return ["default", ...new Set([...a.cohorts, ...b.cohorts].map((c: any) => c.id))];
}

export function changedDims(a: any, b: any): string[] {
  const out: string[] = [];
  if (JSON.stringify(a.cohorts) !== JSON.stringify(b.cohorts)) out.push("cohorts");
  for (const dim of AGENT_DIMS) {
    if (cohortKeys(a, b).some((k) => tv(distOf(a, k, dim), distOf(b, k, dim)) > 1e-6)) out.push(dim);
  }
  if (a.prompt_version !== b.prompt_version) out.push("prompt_version");
  if (JSON.stringify(a.schedule) !== JSON.stringify(b.schedule)) out.push("schedule");
  return out;
}

export function maxShift(a: any, b: any): number {
  let worst = 0;
  for (const k of cohortKeys(a, b)) for (const dim of AGENT_DIMS) worst = Math.max(worst, tv(distOf(a, k, dim), distOf(b, k, dim)));
  return worst;
}

// ---------- policy checks ----------

export function canAutoApply(ctx: Ctx, newConfig: any): boolean {
  const pol = ctx.wf.governance.auto_apply;
  const dims = changedDims(ctx.cfg.config, newConfig);
  return Boolean(pol.enabled) && dims.length > 0
    && dims.every((d) => pol.allowed_dims.includes(d) && OPERATIONAL_DIMS.includes(d))
    && maxShift(ctx.cfg.config, newConfig) <= pol.max_shift + 1e-9;
}

export function requestsLast24h(ctx: Ctx): number {
  return ctx.store.one(
    "SELECT COUNT(*) n FROM proposals WHERE workflow_id = ? AND auto = 0 AND approval_id IS NOT NULL AND created_min > ?",
    ctx.wf.workflow_id, ctx.now.minute - 1440).n;
}

// May we send an approval request right now? Urgent (incident) requests skip our voluntary limits,
// never the policy's hard limit.
export function canSendApproval(ctx: Ctx, urgent = false): boolean {
  const gov = ctx.wf.governance;
  const pref = CLIENT_PREFS[ctx.wf.tenant_id] ?? {};
  const used = requestsLast24h(ctx);
  if (used >= gov.max_requests_per_24h) return false;
  if (urgent) return true;
  const [open, close] = gov.approver_hours;
  const earliest = Math.max(open, pref.earliestHour ?? open);
  const inHours = ctx.now.hour >= earliest && ctx.now.hour < close - 1; // leave time to decide + apply today
  return inHours && used < Math.min(gov.max_requests_per_24h, pref.maxPerDay ?? DEFAULT_MAX_PER_DAY);
}

// Did a client supervisor change this dimension in the last `hours`? Then we leave it alone.
export function supervisorChangedRecently(ctx: Ctx, dim: string, hours: number): boolean {
  const rows = ctx.store.all("SELECT ts, detail FROM decisions WHERE workflow_id = ? AND kind = 'config_changed' ORDER BY id DESC LIMIT 50",
    ctx.wf.workflow_id);
  return rows.some((r) => {
    const ev = JSON.parse(r.detail);
    return ev.actor === "supervisor" && ev.changed_dims.includes(dim) && ctx.now.minute - minuteOf(r.ts) < hours * 60;
  });
}
const minuteOf = (ts: string) => Math.round((Date.parse(ts) - Date.parse("2027-01-04T00:00:00+05:30")) / 60000);

// Log something an on-call engineer should look at. Shows up in the audit log and on stderr.
export function alert(ctx: Ctx, msg: string, detail: object = {}) {
  ctx.store.logDecision(ctx.now.ts, ctx.wf.workflow_id, "ALERT", msg, detail);
  console.error(`ALERT ${ctx.now.ts} ${ctx.wf.workflow_id}: ${msg}`);
}

// Is a normal (non-incident) proposal still waiting? We keep one in flight per workflow so they never conflict.
export function hasInFlight(ctx: Ctx): boolean {
  return Boolean(ctx.store.one(
    "SELECT 1 FROM proposals WHERE workflow_id = ? AND kind != 'incident' AND status IN ('sending','pending','approved')",
    ctx.wf.workflow_id));
}

// ---------- sending ----------

export async function submit(ctx: Ctx, kind: string, newConfig: any, changes: Change[], auto: boolean) {
  const { store, sim, wf, now } = ctx;
  const wid = wf.workflow_id;
  const proposalId = `${wid}:${kind}:${now.minute}`; // deterministic: a restart in the same hour reuses it
  if (store.one("SELECT 1 FROM proposals WHERE proposal_id = ?", proposalId)) return; // already acted

  const body = {
    proposal_id: proposalId, workflow_id: wid, base_version: ctx.cfg.version, proposed_config: newConfig,
    change_summary: changes.map((c) => c.summary).join(" + "),
    diff: { changed_dims: changedDims(ctx.cfg.config, newConfig), ...Object.assign({}, ...changes.map((c) => c.diff)) },
    affected_leads: Math.max(...changes.map((c) => c.affected)),
    dry_run: Object.assign({}, ...changes.map((c) => c.dryRun)),
    impact_score: Math.round(Math.max(...changes.map((c) => c.impact)) * 100) / 100,
    rationale: changes.map((c) => c.rationale).join(" | "),
    evidence: Object.assign({}, ...changes.map((c) => c.evidence ?? {})),
  };
  const effects = { expUpdates: changes.flatMap((c) => c.expUpdates ?? []), incident: changes.find((c) => c.incident)?.incident };
  store.run(
    `INSERT INTO proposals (proposal_id, workflow_id, kind, auto, status, base_version, created_ts, created_min, updated_ts, summary, body)
     VALUES (?, ?, ?, ?, 'sending', ?, ?, ?, ?, ?, ?)`,
    proposalId, wid, kind, auto ? 1 : 0, ctx.cfg.version, now.ts, now.minute, now.ts, body.change_summary,
    JSON.stringify({ ...body, effects }));

  try {
    if (auto) {
      await sim.put(`/workflows/${wid}/config`, {
        proposal_id: proposalId, base_version: ctx.cfg.version, proposed_config: newConfig,
        rationale: body.rationale, evidence: body.evidence,
      });
      markApplied(ctx, proposalId, "auto_applied");
    } else {
      const a = await sim.post("/approvals", body);
      setStatus(store, proposalId, "pending", now.ts, { approval_id: a.approval_id });
      store.logDecision(now.ts, wid, "approval_requested", `${a.approval_id}: ${body.change_summary}`,
        { proposal_id: proposalId, impact: body.impact_score, affected: body.affected_leads });
    }
  } catch (e) {
    if (!(e instanceof SimError) || e.status >= 500) throw e; // network trouble: leave 'sending', reconcile on restart
    setStatus(store, proposalId, "failed", now.ts, { outcome: JSON.stringify(e.body) });
    onNotApplied(ctx, proposalId);
    store.logDecision(now.ts, wid, "proposal_failed", `${kind} refused: ${JSON.stringify(e.body)}`, { proposal_id: proposalId });
  }
}

// ---------- following up ----------

// Poll our open approvals for this workflow; apply the approved ones. Returns true if the config changed.
export async function processInFlight(ctx: Ctx): Promise<boolean> {
  const { store, sim, wf, now } = ctx;
  let changed = false;
  const rows = store.all("SELECT * FROM proposals WHERE workflow_id = ? AND status IN ('pending','approved') ORDER BY created_min",
    wf.workflow_id);
  for (const row of rows) {
    const a = await sim.get(`/approvals/${row.approval_id}`);
    if (a.status === "pending") continue;
    if (a.status === "applied") { markApplied(ctx, row.proposal_id, "applied"); changed = true; continue; } // applied before a crash
    if (a.status === "approved") {
      try {
        await sim.post(`/workflows/${wf.workflow_id}/apply`, { approval_id: row.approval_id });
        markApplied(ctx, row.proposal_id, "applied");
        changed = true;
      } catch (e) {
        if (!(e instanceof SimError) || e.status >= 500) throw e;
        const status = e.status === 410 ? "lapsed" : "stale"; // 409 = config changed since we proposed
        close(ctx, row, status, e.body);
      }
      continue;
    }
    close(ctx, row, a.status, a.reasons); // rejected | expired | lapsed
  }
  return changed;
}

// After a crash: finish or forget every request we were in the middle of sending.
export async function reconcile(sim: Sim, store: Store, ts: string) {
  for (const row of store.all("SELECT * FROM proposals WHERE status = 'sending'")) {
    if (row.auto) {
      const history = await sim.get(`/workflows/${row.workflow_id}/config/history`);
      if (history.some((v: any) => v.proposal_id === row.proposal_id)) {
        markApplied({ store, now: { ts } } as Ctx, row.proposal_id, "auto_applied");
        continue;
      }
    } else {
      const found = (await sim.get(`/approvals?workflow_id=${row.workflow_id}`)).find((a: any) => a.proposal_id === row.proposal_id);
      if (found) { setStatus(store, row.proposal_id, "pending", ts, { approval_id: found.approval_id }); continue; }
    }
    store.run("DELETE FROM proposals WHERE proposal_id = ?", row.proposal_id); // never reached the simulator
  }
}

// ---------- state transitions (each one is a single transaction) ----------

function setStatus(store: Store, pid: string, status: string, ts: string, extra: { approval_id?: string; outcome?: string } = {}) {
  store.run("UPDATE proposals SET status = ?, updated_ts = ?, approval_id = COALESCE(?, approval_id), outcome = COALESCE(?, outcome) WHERE proposal_id = ?",
    status, ts, extra.approval_id ?? null, extra.outcome ?? null, pid);
}

// The config really changed: only NOW do experiments and incidents move forward
// ("only what actually happened counts as evidence").
function markApplied(ctx: Ctx, pid: string, status: string) {
  const { store, now } = ctx;
  const row = store.one("SELECT * FROM proposals WHERE proposal_id = ?", pid);
  const { effects } = JSON.parse(row.body);
  store.tx(() => {
    setStatus(store, pid, status, now.ts);
    for (const u of effects.expUpdates) {
      // the measurement window restarts on every real change, except when we only dropped a losing arm
      const prev = store.one("SELECT since_ts, since_idx FROM experiments WHERE workflow_id = ? AND cohort = ? AND dim = ?",
        row.workflow_id, u.cohort, u.dim);
      const since = u.keep_since && prev ? prev : { since_ts: now.ts, since_idx: now.idx };
      store.run(`INSERT OR REPLACE INTO experiments (workflow_id, cohort, dim, status, control, winner, arms, win_rate, control_rate, since_ts, since_idx)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.workflow_id, u.cohort, u.dim, u.status, u.control, u.winner ?? null, JSON.stringify(u.arms),
        u.win_rate ?? null, u.control_rate ?? null, since.since_ts, since.since_idx);
    }
    if (effects.incident) store.setJson(`incident:${row.workflow_id}`, { ...effects.incident, status: "applied", applied_idx: now.idx });
    store.logDecision(now.ts, row.workflow_id, status, row.summary, { proposal_id: pid, approval_id: row.approval_id });
  });
}

function close(ctx: Ctx, row: any, status: string, reasons: unknown) {
  setStatus(ctx.store, row.proposal_id, status, ctx.now.ts, { outcome: JSON.stringify(reasons ?? null) });
  onNotApplied(ctx, row.proposal_id);
  ctx.store.logDecision(ctx.now.ts, row.workflow_id, `proposal_${status}`, `${row.approval_id} ${status}: ${row.summary}`,
    { proposal_id: row.proposal_id, reasons });
}

// Nothing changed, so let the rules try again with fresh data.
function onNotApplied(ctx: Ctx, pid: string) {
  const row = ctx.store.one("SELECT * FROM proposals WHERE proposal_id = ?", pid);
  const { effects } = JSON.parse(row.body);
  if (effects.incident) {
    const inc = ctx.store.getJson(`incident:${row.workflow_id}`);
    if (inc) ctx.store.setJson(`incident:${row.workflow_id}`, { ...inc, status: "open" });
  }
  if (effects.expUpdates.length) ctx.store.run("DELETE FROM kv WHERE key = ?", `exp_look:${row.workflow_id}`);
}
