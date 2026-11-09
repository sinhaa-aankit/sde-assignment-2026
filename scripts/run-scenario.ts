// Run one scenario end to end and grade it.
//   node scripts/run-scenario.ts public_01_dev            -> reports/public_01_dev.md
import { rmSync } from "node:fs";
import { ensureBaseline, exited, grade, startController, startSim } from "./lib.ts";

const scenario = process.argv[2] ?? "public_01_dev";
const port = Number(process.argv[3] ?? 8700);
const runDir = `runs/mine_${scenario}`;
const db = `state/${scenario}.db`;

ensureBaseline(scenario);
for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
const sim = await startSim(scenario, runDir, port);
const code = await exited(startController(port, db));
sim.kill();
if (code !== 0) throw new Error(`controller exited with ${code}`);
grade(scenario, runDir, `reports/${scenario}.md`);
