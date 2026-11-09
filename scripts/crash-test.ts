// Crash-recovery test: kill -9 the controller several times mid-run, restart it each time, let it finish,
// then grade. Compare reports/crash_<scenario>.md with reports/<scenario>.md (uninterrupted run):
// the controller makes the same decisions, so the numbers should match.
//   node scripts/crash-test.ts public_02_incidents
import { rmSync } from "node:fs";
import { ensureBaseline, exited, grade, startController, startSim } from "./lib.ts";

const scenario = process.argv[2] ?? "public_02_incidents";
const port = Number(process.argv[3] ?? 8711);
const kills = Number(process.argv[4] ?? 4);
const runDir = `runs/crash_${scenario}`;
const db = `state/crash_${scenario}.db`;

ensureBaseline(scenario);
for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
const sim = await startSim(scenario, runDir, port);

for (let i = 1; i <= kills; i++) {
  const ctl = startController(port, db);
  const after = 3000 + Math.floor(Math.random() * 7000); // somewhere 3-10 s in: mid-ingest, mid-rules, mid-request...
  await new Promise((r) => setTimeout(r, after));
  const state = await (await fetch(`http://127.0.0.1:${port}/sim/state`)).json();
  ctl.kill("SIGKILL");
  await exited(ctl);
  console.log(`\n### CRASH TEST: killed controller (kill ${i}/${kills}) after ${after} ms at sim time ${state.ts}\n`);
}
console.log("### CRASH TEST: final restart, running to the end");
const code = await exited(startController(port, db));
sim.kill();
console.log(`### CRASH TEST: controller exited with code ${code}`);
grade(scenario, runDir, `reports/crash_${scenario}.md`);
