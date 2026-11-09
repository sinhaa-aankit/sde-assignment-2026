// All controller state lives in one SQLite file. Kill the process, restart, and nothing is lost.
// Uses Node's built-in SQLite (node:sqlite) — no npm dependency.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const SCHEMA = `
  -- small key/value state: last ingested chunk, incidents, bad caller IDs, ...
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- lead features, so we can count which leads a change affects
  CREATE TABLE IF NOT EXISTS leads (
    lead_id TEXT PRIMARY KEY, workflow_id TEXT, person_id TEXT, day INT,
    lang TEXT, city_tier TEXT, age_band TEXT, value_band TEXT
  );
  CREATE INDEX IF NOT EXISTS leads_wf_day ON leads (workflow_id, day);

  -- call counts per (workflow, day, hour, cohort, variant). Raw calls are never stored.
  CREATE TABLE IF NOT EXISTS stats (
    workflow_id TEXT, day INT, hour INT, cohort TEXT,
    welcome TEXT, voice TEXT, caller_id TEXT, prompt TEXT,
    dials INT, connected INT, engaged INT, halluc INT,
    PRIMARY KEY (workflow_id, day, hour, cohort, welcome, voice, caller_id, prompt)
  );

  -- every change we send, keyed by our own proposal_id (the idempotency key)
  CREATE TABLE IF NOT EXISTS proposals (
    proposal_id TEXT PRIMARY KEY, workflow_id TEXT, kind TEXT, auto INT, status TEXT,
    approval_id TEXT, base_version INT, created_ts TEXT, created_min INT, updated_ts TEXT,
    summary TEXT, body TEXT, outcome TEXT
  );

  -- one row per (workflow, cohort, dimension) experiment. Changes ONLY when a config is actually applied.
  CREATE TABLE IF NOT EXISTS experiments (
    workflow_id TEXT, cohort TEXT, dim TEXT, status TEXT, control TEXT, winner TEXT,
    arms TEXT, win_rate REAL, control_rate REAL, since_ts TEXT, since_idx INT,
    PRIMARY KEY (workflow_id, cohort, dim)
  );

  -- the audit log: every decision, with why. Answers "why did X change?"
  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, workflow_id TEXT,
    kind TEXT, summary TEXT, detail TEXT
  );
`;

export type StatRow = {
  workflow_id: string; day: number; hour: number; cohort: string;
  welcome: string; voice: string; caller_id: string; prompt: string;
  dials: number; connected: number; engaged: number; halluc: number;
};

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);

  const getKv = db.prepare("SELECT value FROM kv WHERE key = ?");
  const setKv = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const addLead = db.prepare("INSERT OR IGNORE INTO leads VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const addStat = db.prepare(`
    INSERT INTO stats VALUES ($workflow_id, $day, $hour, $cohort, $welcome, $voice, $caller_id, $prompt,
                              $dials, $connected, $engaged, $halluc)
    ON CONFLICT DO UPDATE SET dials = dials + excluded.dials, connected = connected + excluded.connected,
                              engaged = engaged + excluded.engaged, halluc = halluc + excluded.halluc`);
  const addDecision = db.prepare("INSERT INTO decisions (ts, workflow_id, kind, summary, detail) VALUES (?, ?, ?, ?, ?)");

  return {
    db,

    // Run fn inside one transaction: either everything is saved or nothing is.
    tx<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },

    // small query helpers
    all: (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).all(...p) as any[],
    one: (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).get(...p) as any,
    run: (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p),

    get(key: string): string | undefined {
      return (getKv.get(key) as { value: string } | undefined)?.value;
    },
    set(key: string, value: string) {
      setKv.run(key, value);
    },
    getJson: (key: string) => {
      const v = (getKv.get(key) as { value: string } | undefined)?.value;
      return v ? JSON.parse(v) : undefined;
    },
    setJson: (key: string, value: unknown) => setKv.run(key, JSON.stringify(value)),

    addLead(l: { lead_id: string; workflow_id: string; person_id: string; features: Record<string, string> }, day: number) {
      const f = l.features;
      addLead.run(l.lead_id, l.workflow_id, l.person_id, day, f.lang, f.city_tier, f.age_band, f.value_band);
    },

    addStat(r: StatRow) {
      addStat.run(r);
    },

    logDecision(ts: string, workflow_id: string, kind: string, summary: string, detail: object = {}) {
      addDecision.run(ts, workflow_id, kind, summary, JSON.stringify(detail));
    },
  };
}

export type Store = ReturnType<typeof openStore>;
