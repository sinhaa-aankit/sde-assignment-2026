// Small helpers shared by the rules.
import type { Ctx } from "./governance.ts";
import { cohortSql } from "./cohorts.ts";

export const pct = (x: number, n: number) => (n ? `${((100 * x) / n).toFixed(1)}%` : "n/a");

// Leads in campaigns that are still running (a campaign lasts as many days as its cadence),
// optionally only those in one cohort. This is the "affected_leads" on every proposal.
export function affectedLeads(ctx: Ctx, cohort: string | null): number {
  const firstDay = ctx.now.day - (ctx.wf.cadence.length - 1);
  const where = cohort ? `AND ${cohortSql(cohort)}` : "";
  return ctx.store.one(`SELECT COUNT(*) n FROM leads WHERE workflow_id = ? AND day >= ? ${where}`, ctx.wf.workflow_id, firstDay).n;
}

// Connected calls per day for this workflow over the last 7 days (used in dry runs).
export function connectedPerDay(ctx: Ctx): number {
  const r = ctx.store.one("SELECT SUM(connected) c, COUNT(DISTINCT day) d FROM stats WHERE workflow_id = ? AND day >= ?",
    ctx.wf.workflow_id, ctx.now.day - 7);
  return r.d ? r.c / r.d : 0;
}

// Share of this workflow's recent leads that fall in a cohort.
export function cohortShare(ctx: Ctx, cohort: string): number {
  const all = ctx.store.one("SELECT COUNT(*) n FROM leads WHERE workflow_id = ? AND day >= ?", ctx.wf.workflow_id, ctx.now.day - 7).n;
  const mine = ctx.store.one(`SELECT COUNT(*) n FROM leads WHERE workflow_id = ? AND day >= ? AND ${cohortSql(cohort)}`,
    ctx.wf.workflow_id, ctx.now.day - 7).n;
  return all ? mine / all : 0;
}
