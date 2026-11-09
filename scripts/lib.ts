// Shared helpers for the scripts: start the (unchanged) Python simulator, run the controller, grade.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

process.env.PYTHONUTF8 = "1"; // the grader writes "Δ"; Windows' default encoding can't
export const PYTHON = process.env.PYTHON
  ?? [".venv/Scripts/python.exe", ".venv/bin/python"].find((p) => existsSync(p)) ?? "python3";

export async function startSim(scenario: string, runDir: string, port: number): Promise<ChildProcess> {
  const p = spawn(PYTHON, ["-m", "sim", "serve", "--scenario", `scenarios/${scenario}.yaml`, "--run-dir", runDir,
    "--port", String(port), "--force"], { stdio: "inherit" });
  for (let i = 0; i < 600; i++) { // the load scenario needs a while to generate history
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return p;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("simulator did not start");
}

export function startController(port: number, db: string, logFile?: string): ChildProcess {
  return spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "controller/main.ts", `http://127.0.0.1:${port}`],
    { stdio: "inherit", env: { ...process.env, CONTROLLER_DB: db } });
}

export const exited = (p: ChildProcess) => new Promise<number>((r) => p.on("exit", (code) => r(code ?? -1)));

export function ensureBaseline(scenario: string) {
  if (existsSync(`runs/base_${scenario}/_truth/aggregates.json`)) return;
  spawnSync(PYTHON, ["-m", "sim", "baseline", "--scenario", `scenarios/${scenario}.yaml`, "--run-dir", `runs/base_${scenario}`], { stdio: "inherit" });
}

export function grade(scenario: string, runDir: string, out: string) {
  mkdirSync("reports", { recursive: true });
  spawnSync(PYTHON, ["-m", "sim", "grade", "--run", runDir, "--baseline", `runs/base_${scenario}`, "--out", out], { stdio: "inherit" });
}
