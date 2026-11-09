// The controller loop. Every simulated hour:
//   1. catch up on events            (ingest.ts)
//   2. per workflow: follow up on approvals, then run the rules, then send at most one change
//   3. advance the simulator one hour
// Usage: node controller/main.ts <SIM_URL>     (state: CONTROLLER_DB, default state/<scenario>.db)
import { mkdirSync, rmSync } from "node:fs";
import { openStore } from "./store.ts";
import { simClient } from "./sim.ts";
import { ingestChunk, lastChunk, simTime } from "./ingest.ts";
import { type Change, type Ctx, type Now, canAutoApply, canSendApproval, clone, changedDims, hasInFlight, processInFlight, reconcile, submit } from "./governance.ts";
import { hallucinationRule } from "./rule-hallucination.ts";
import { callerIdRule } from "./rule-caller-id.ts";
import { experimentRule } from "./rule-experiments.ts";

const SIM_URL = process.argv[2] ?? "http://127.0.0.1:8700";
const STEP_MINUTES = 60;
const sim = simClient(SIM_URL);

// One state file per scenario. If the simulator was restarted (a new world: time went backwards), start fresh.
const first = await sim.get("/sim/state");
const dbPath = process.env.CONTROLLER_DB ?? `state/${first.scenario}.db`;
mkdirSync("state", { recursive: true });
let store = openStore(dbPath);
const saved = store.get("sim_ts");
if (saved && simTime(saved).minute > first.sim_minute) {
  console.log(`state file ${dbPath} belongs to an older run of ${first.scenario} — starting fresh`);
  store.db.close();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  store = openStore(dbPath);
}
console.log(`controller: ${SIM_URL} scenario=${first.scenario} state=${dbPath} resume_from_chunk=${lastChunk(store)}`);

const workflows: any[] = await sim.get("/workflows");
store.setJson("workflows", workflows); // so the audit CLI can explain things without the simulator
await reconcile(sim, store, first.ts); // finish anything we were sending when we last stopped

let ingestMs = 0, ingestEvents = 0; // loop health, printed once per simulated day

async function catchUp() {
  const after = lastChunk(store);
  const history = await sim.get(`/events/chunks?kind=history&after=${after}`);
  const live = await sim.get(`/events/chunks?kind=events&after=${after}`);
  for (const c of [...history, ...live].sort((a, b) => a.chunk - b.chunk)) {
    const t0 = performance.now();
    ingestEvents += ingestChunk(store, c.chunk, await sim.get(`/events/chunks/${c.chunk}`));
    ingestMs += performance.now() - t0;
  }
}

async function runWorkflow(wf: any, now: Now, credits: number) {
  const wid = wf.workflow_id;
  const load = () => sim.get(`/workflows/${wid}/config`);
  const ctx: Ctx = { sim, store, wf, cfg: await load(), now, credits };
  if (await processInFlight(ctx)) ctx.cfg = await load();
  store.setJson(`config:${wid}`, ctx.cfg);

  // 1. Safety first: a hallucination incident gets its own request, ahead of everything else.
  const fix = clone(ctx.cfg.config);
  const incident = await hallucinationRule(ctx, fix);
  if (incident && canSendApproval(ctx, true)) await submit(ctx, "incident", fix, [incident], false);

  // 2. Caller IDs are operational: auto-apply when policy allows, otherwise batch into the next request.
  const draft = clone(ctx.cfg.config);
  const changes: Change[] = [];
  const cid = callerIdRule(ctx, draft);
  if (cid) {
    if (canAutoApply(ctx, draft) && (cid.urgent || !hasInFlight(ctx))) return submit(ctx, "caller_id", draft, [cid], true);
    changes.push(cid);
  }

  // 3. Experiments: one look per day, and only when the result could actually be sent now.
  if (hasInFlight(ctx) || !canSendApproval(ctx)) return;
  const looked = store.get(`exp_look:${wid}`) === String(now.day);
  if (!looked) changes.push(...experimentRule(ctx, draft));
  if (changes.length && changedDims(ctx.cfg.config, draft).length) {
    await submit(ctx, changes.length > 1 ? "batch" : changes[0].kind, draft, changes, false); // one request, many changes
  }
  if (!looked) store.set(`exp_look:${wid}`, String(now.day));
}

const started = performance.now();
let dayStarted = performance.now();
while (true) {
  await catchUp();
  const state = await sim.get("/sim/state");
  const now: Now = { ts: state.ts, ...simTime(state.ts) };
  store.set("sim_ts", state.ts);
  store.set("credits", String(state.credits_remaining));

  if (now.minute >= 0) {
    for (const wf of workflows) await runWorkflow(wf, now, state.credits_remaining);
  }

  if (now.hour === 0 || state.finished) {
    const decisions = store.one("SELECT COUNT(*) n FROM decisions WHERE ts >= ?", new Date(Date.parse(state.ts) - 86400000 + 19800000).toISOString().slice(0, 19)).n;
    const wall = (performance.now() - dayStarted) / 1000;
    console.log(`${state.ts} | day wall ${wall.toFixed(1)}s | ingested ${ingestEvents} events in ${(ingestMs / 1000).toFixed(1)}s ` +
      `(${Math.round(ingestEvents / Math.max(ingestMs / 1000, 0.001))}/s) | audit rows 24h ${decisions} | credits ${state.credits_remaining} | ` +
      `rss ${Math.round(process.memoryUsage().rss / 1e6)}MB`);
    ingestEvents = 0; ingestMs = 0; dayStarted = performance.now();
  }
  if (state.finished) break;
  await sim.post("/sim/advance", { minutes: STEP_MINUTES });
}
console.log(`finished in ${((performance.now() - started) / 1000).toFixed(1)}s`);
