// Turns one event chunk (NDJSON text) into rows in the store.
// Idempotent: a chunk and the "last_chunk" marker are saved in ONE transaction,
// so after a crash a chunk is either fully counted or not counted at all — never twice.
import type { Store, StatRow } from "./store.ts";

const D0 = Date.parse("2027-01-04T00:00:00+05:30"); // simulator day 0 (history days are negative)

// "2027-01-05T14:00:00+05:30" -> { minute: 2280, day: 1, hour: 14, idx: 38 }
// idx = day * 24 + hour: one number per simulated hour, handy for "since" windows in SQL.
export function simTime(ts: string) {
  const minute = Math.round((Date.parse(ts) - D0) / 60000);
  const day = Math.floor(minute / 1440);
  const hour = Number(ts.slice(11, 13));
  return { minute, day, hour, idx: day * 24 + hour };
}

// "D3 14:00" -> hour index, for the CLI
export function parseWhen(s: string): number {
  const [d, hm] = s.trim().split(/\s+/);
  return Number(d.replace(/^D/i, "")) * 24 + Number((hm ?? "0").split(":")[0]);
}

export function lastChunk(store: Store): number {
  return Number(store.get("last_chunk") ?? -1);
}

export function ingestChunk(store: Store, chunkNo: number, text: string): number {
  if (chunkNo <= lastChunk(store)) return 0; // already ingested before a restart

  const stats = new Map<string, StatRow>(); // add up calls in memory first, then write once
  const leads: any[] = [];
  const audit: any[] = [];
  let events = 0;

  for (const line of text.split("\n")) {
    if (!line) continue;
    const ev = JSON.parse(line);
    events++;
    if (ev.type === "lead") leads.push(ev);
    else if (ev.type === "call") addCall(stats, ev);
    else if (ev.type === "config_changed" || ev.type === "approval_decided") audit.push(ev);
  }

  store.tx(() => {
    for (const l of leads) store.addLead(l, simTime(l.ts).day);
    for (const r of stats.values()) store.addStat(r);
    for (const ev of audit) store.logDecision(ev.ts, ev.workflow_id, ev.type, describe(ev), ev);
    store.set("last_chunk", String(chunkNo));
  });
  return events;
}

function addCall(stats: Map<string, StatRow>, ev: any) {
  const { day, hour } = simTime(ev.ts);
  const v = ev.variant;
  const key = [ev.workflow_id, day, hour, ev.cohort_id, v.welcome_message, v.voice, v.caller_id, v.prompt_version].join("|");
  let r = stats.get(key);
  if (!r) {
    r = {
      workflow_id: ev.workflow_id, day, hour, cohort: ev.cohort_id,
      welcome: v.welcome_message, voice: v.voice, caller_id: v.caller_id, prompt: v.prompt_version,
      dials: 0, connected: 0, engaged: 0, halluc: 0,
    };
    stats.set(key, r);
  }
  r.dials += 1;
  r.connected += ev.connected ? 1 : 0;
  r.engaged += ev.engaged ? 1 : 0;
  r.halluc += ev.qa?.hallucination_flag ? 1 : 0;
}

function describe(ev: any): string {
  if (ev.type === "config_changed") return `config v${ev.version} by ${ev.actor}: ${ev.changed_dims.join(", ")}`;
  return `approval ${ev.approval_id} ${ev.status}${ev.reasons?.length ? ": " + ev.reasons.join("; ") : ""}`;
}
