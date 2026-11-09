// Audit + supervisor view, answered ONLY from our own store (never the simulator's logs).
//
//   node controller/why.ts <scenario> <workflow> "D3 14:00"   why did it change at/just before that time?
//   node controller/why.ts <scenario> <workflow>               every change to that workflow, one line each
//   node controller/why.ts <scenario> summary                  one screen: tested, winning, waiting on you, changed today
//
// <scenario> is a scenario name (reads state/<scenario>.db) or a path to a .db file.
import { existsSync } from "node:fs";
import { openStore } from "./store.ts";
import { parseWhen, simTime } from "./ingest.ts";
import { COHORT_LABEL } from "./cohorts.ts";
import { pct } from "./rule-helpers.ts";

const [target, what, when] = process.argv.slice(2);
if (!target || !what) {
  console.log('usage: node controller/why.ts <scenario|db> <workflow> ["D3 14:00"]   |   node controller/why.ts <scenario|db> summary');
  process.exit(1);
}
const path = target.endsWith(".db") ? target : `state/${target}.db`;
if (!existsSync(path)) throw new Error(`no state file ${path}`);
const store = openStore(path);
const workflows: any[] = store.getJson("workflows") ?? [];
const D = (ts: string) => { const t = simTime(ts); return `D${t.day} ${ts.slice(11, 16)}`; };

// Pickup and engagement for a workflow between two hour indexes — always reported separately, never blended.
function kpis(wid: string, fromIdx: number, toIdx: number) {
  const r = store.one(`SELECT SUM(dials) d, SUM(connected) c, SUM(engaged) e FROM stats
                       WHERE workflow_id = ? AND day * 24 + hour >= ? AND day * 24 + hour < ?`, wid, fromIdx, toIdx);
  return `pickup ${pct(r.c ?? 0, r.d ?? 0)} (${r.d ?? 0} dials), engagement ${pct(r.e ?? 0, r.c ?? 0)} (${r.c ?? 0} connected)`;
}

function changes(wid: string) {
  return store.all("SELECT ts, detail FROM decisions WHERE workflow_id = ? AND kind = 'config_changed' ORDER BY id", wid)
    .map((r) => ({ ts: r.ts as string, ...JSON.parse(r.detail) }));
}

function explain(wid: string, whenIdx?: number) {
  const all = changes(wid);
  if (whenIdx === undefined) {
    for (const c of all) console.log(`${D(c.ts)}  v${c.version}  ${c.actor.padEnd(19)} ${c.changed_dims.join(", ")}`);
    return;
  }
  const c = all.filter((x) => simTime(x.ts).idx <= whenIdx).at(-1);
  if (!c) return console.log(`no config change for ${wid} at or before that time`);
  const idx = simTime(c.ts).idx;
  const wf = workflows.find((w) => w.workflow_id === wid);

  console.log(`\n${wid} changed to config v${c.version} at ${D(c.ts)} (${c.ts})`);
  console.log(`  what:  ${c.changed_dims.join(", ")}`);
  if (c.actor === "supervisor") {
    console.log("  why:   a client supervisor edited the config directly (outside the controller)");
  } else {
    const p = store.one("SELECT * FROM proposals WHERE proposal_id = ?", c.proposal_id);
    const body = JSON.parse(p.body);
    console.log(`  why:   ${body.change_summary}`);
    console.log(`         ${body.rationale}`);
    console.log(`  evidence (dry run): ${JSON.stringify(body.dry_run)}`);
    console.log(`  impact score ${body.impact_score}, affected leads ${body.affected_leads}, proposal ${p.proposal_id}`);
    if (p.auto) {
      console.log(`  who:   auto-applied by the controller — operational change permitted by ${wf?.tenant_id}'s auto-apply policy`);
    } else {
      const d = store.one("SELECT ts FROM decisions WHERE kind = 'approval_decided' AND detail LIKE ? ORDER BY id DESC", `%"${p.approval_id}"%`);
      console.log(`  who:   requested ${D(p.created_ts)} as ${p.approval_id}; approved by the ${wf?.tenant_id} approver at ${d ? D(d.ts) : "?"}; applied ${D(c.ts)}`);
    }
  }
  console.log(`  before (24h): ${kpis(wid, idx - 24, idx)}`);
  console.log(`  after  (24h): ${kpis(wid, idx, idx + 24)}`);
  console.log(`  primary KPI for this workflow: ${wf?.objective.primary}`);
  console.log("  what happened next (48h):");
  const next = store.all("SELECT ts, kind, summary FROM decisions WHERE workflow_id = ? AND kind NOT IN ('config_changed', 'approval_decided', 'validation_run') ORDER BY id", wid)
    .filter((r) => { const i = simTime(r.ts).idx; return i > idx && i <= idx + 48; });
  for (const r of next) console.log(`    ${D(r.ts)}  ${r.kind}: ${r.summary}`);
  if (!next.length) console.log("    nothing else changed");
}

function summary() {
  const now = store.get("sim_ts")!;
  const today = simTime(now).day;
  console.log(`SUMMARY at ${D(now)} · credits left ${store.get("credits")}\n`);
  for (const wf of workflows) {
    const wid = wf.workflow_id;
    const cfg = store.getJson(`config:${wid}`);
    const t = simTime(now).idx;
    console.log(`■ ${wid} (${wf.tenant_id}) — config v${cfg?.version}, prompt ${cfg?.config.prompt_version}, primary ${wf.objective.primary}`);
    console.log(`  last 24h: ${kpis(wid, t - 24, t)}    before D0: ${kpis(wid, -10000, 0)}`);
    const inc = store.getJson(`incident:${wid}`);
    if (inc && inc.status !== "verified" && inc.status !== "closed") console.log(`  INCIDENT: hallucination spike on ${inc.bad_prompt} since ${D(inc.detected_ts)} — ${inc.status}`);
    const bad = store.getJson(`bad_dids:${wid}`) ?? [];
    if (bad.length) console.log(`  caller IDs taken out of rotation: ${bad.join(", ")}`);
    for (const e of store.all("SELECT * FROM experiments WHERE workflow_id = ? ORDER BY cohort, dim", wid)) {
      const arms = Object.entries(JSON.parse(e.arms)).map(([k, v]) => `${k} ${Math.round(Number(v) * 100)}%`).join(" ");
      const winner = e.winner ? ` · winner ${e.winner} (${(e.win_rate * 100).toFixed(1)}% vs ${(e.control_rate * 100).toFixed(1)}%)` : "";
      console.log(`  test ${e.dim} · ${COHORT_LABEL[e.cohort]}: ${e.status} since ${D(e.since_ts)} · ${arms}${winner}`);
    }
    for (const p of store.all("SELECT * FROM proposals WHERE workflow_id = ? AND status IN ('pending','approved')", wid)) {
      console.log(`  WAITING ON YOU: ${p.approval_id} (${p.status}) ${p.summary}`);
    }
    const changed = store.all("SELECT ts, kind, summary FROM decisions WHERE workflow_id = ? AND kind IN ('applied','auto_applied','ALERT') ORDER BY id", wid)
      .filter((r) => simTime(r.ts).day === today);
    for (const r of changed) console.log(`  today ${r.ts.slice(11, 16)} ${r.kind === "ALERT" ? "ALERT" : "changed"}: ${r.summary}`);
    console.log("");
  }
}

if (what === "summary") summary();
else explain(what, when ? parseWhen(when) : undefined);
