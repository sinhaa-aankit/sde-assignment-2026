# Outcome-First Agent Loop — Submission

**Name:** _(your name)_ · **Date:** _(date)_ · **Hours actually spent:** _(fill in)_ · **Language / storage:** TypeScript on Node.js 24 (no runtime dependencies) / SQLite (Node's built-in `node:sqlite`, one file per scenario)

---

## 0. TL;DR

- An hourly loop: ingest events → follow up on approvals → three rules (hallucination incidents, caller-ID health, A/B tests) → at most one change per workflow, through governance → advance the simulator.
- **public_01:** +13% leads concluded vs the do-nothing baseline, **0 harmful changes** (9 beneficial, 7 neutral). **public_02:** +26% leads concluded, 0 harmful, the bad prompt was fixed **210 min** after the supervisor shipped it, the spam-flagged caller ID was out of rotation the same day, the decaying winner was fully rolled back, **5 credits** used.
- **public_03_load:** ~71 s wall-clock per simulated day (target < 10 min), 46–50k events/s, ≤ 396 MB RSS, +18.7% leads concluded, 0 harmful.
- Killing the controller 4 times mid-run produces a grade report byte-identical to an uninterrupted run.
- Deliberately **not built:** per-person call-time optimisation (C4), fair allocation across tenants (C15), a web UI (C11 is a CLI).

### How to run (new engineer, start here)

```bash
pip install -r requirements.txt          # the simulator (unchanged Python)
node --version                           # controller needs Node >= 24; no npm install needed to run it
python -m sim serve --scenario scenarios/public_01_dev.yaml --run-dir runs/mine01 --force &
./run.sh http://127.0.0.1:8700           # runs to the end; state in state/public_01_dev.db

node scripts/run-scenario.ts public_02_incidents     # start sim + controller + grade -> reports/
node scripts/crash-test.ts public_02_incidents       # 4 random kill -9s, then grade -> reports/crash_*
node controller/why.ts public_02_incidents summary   # supervisor view
node controller/why.ts public_02_incidents ks_cancel "D3 15:00"   # why did it change?
npm install && npm test                  # 14 unit tests (dev deps are editor types only)
```
Debugging: every decision is a row in `decisions` (`sqlite3 state/<scenario>.db "select ts,kind,summary from decisions"`);
`ALERT` rows and stderr lines are what an on-call engineer acts on. To add a rule, write `rule-x.ts` that edits a draft
config and returns a `Change`, then call it in `runWorkflow` (`main.ts`). Governance does the rest.

## 1. Assumptions

1. Voice and welcome message are heard *after* pickup, so they cannot move pickup. A pickup-primary workflow (nw_kyc) only gets caller-ID changes; no voice/greeting tests.
2. `guardrail.pickup_rate_max_drop: 0.02` is read as a *relative* 2% drop, and only counts when it is also statistically significant.
3. Caller-ID choice is randomised per call by the simulator, so comparing numbers over the same 24h window is a fair comparison (same people, same hours).
4. A caller ID whose pickup is far below the others (< 75% of the rest) is spam-flagged and stays out of rotation for the rest of the run. Real flags take weeks to clear.
5. Heavily used numbers degrade (carriers label high-volume numbers), so spreading dials evenly across healthy numbers is a good default. Untested numbers start at 5%.
6. Client preferences in the memos that are *stricter* than the signed policy are honoured voluntarily (Kestrel: ≤ 2 requests/day, none before 11:00). Preferences looser than the policy are not (the policy wins).
7. Incident fixes may exceed those voluntary limits (never the policy limit) and may be sent outside approver hours. They wait in the queue until the approver starts.
8. "Customer-facing" = welcome message, voice, prompt and cohorts. These are **never auto-applied**, even where the policy permits it (Northwind compliance). Only caller ID and schedule are auto-applied.
9. The hallucination detector's noise is stable, so the pre-D0 history gives the normal flag rate per workflow.
10. History ran only the default config (W1/V1, two caller IDs), so it tells us baselines but nothing about which variants work.

## 2. Scope decisions

| # | Capability | Built / Partial / Cut | Why | What it would take to finish |
|---|---|---|---|---|
| C1 | Ingestion | **Built** | Everything depends on it | — (see §8 for 10×) |
| C2 | Lead joins + one cohort object | **Built** | Product memo; experiments need it | Data-driven cohort discovery |
| C3 | Bootstrap from history | **Built** (baselines: hallucination rate, known-good prompts, caller-ID volumes, cohort sizes) | Cheap, needed for detection | — |
| C4 | Call-time optimisation | **Cut** | Most code, least data per person (~3 attempts per lead), risk of capacity going unused (hours with weight 0) | Per-cohort hour-of-day pickup curves from history → `schedule.hour_weights`, auto-applied where policy allows |
| C5 | Caller-ID health | **Built** | Biggest pickup lever; policy lets us auto-apply it | Let flagged numbers rest and re-test them |
| C6 | Experiments | **Built** | Core of the loop | Interaction tests (welcome × voice) |
| C7 | Promotion, decay, rollback | **Built** | Graded and safety-critical | Formal sequential test (alpha spending) |
| C8 | Hallucination response | **Built** | Regulated clients; graded on time-to-fix | Per-cohort prompt checks |
| C9 | Governance client | **Built** | Constraint #1 | Smarter batching across days |
| C10 | Impact, affected leads, dry run | **Partial** | Honest and simple, not a full replay | Replay the change against historical cohorts with an outcome model |
| C11 | Supervisor view | **Partial** (CLI: `why.ts summary`) | One screen, no UI to defend | Serve the same query as JSON/HTML |
| C12 | Audit store | **Built** (`why.ts`) | Floor requirement | — |
| C13 | Crash recovery, demonstrated | **Built** (`scripts/crash-test.ts`) | SRE non-negotiable | — |
| C14 | Loop observability | **Partial** (daily health line, ALERT rows) | Enough to run it | Export to their metrics stack |
| C15 | Fair allocation across tenants | **Cut** | Credits are only spent on incidents (5 per incident), so there's nothing to ration yet | Per-tenant credit budgets |

**Principle:** build the loop end to end and safe first (ingest → decide → govern → audit → survive crashes), then the levers with the best value per line of code: caller-ID health (pickup), incidents (risk), A/B tests (engagement). Anything that needed a lot of code for a small, uncertain gain was cut.

## 3. Stakeholders

### 01 — Nikhil Rao, VP Sales
- **Accepted:** less noise for supervisors: changes are batched into one request, at most 2 per workflow per day. Lift is reported per client and per KPI.
- **Declined:** a single blended score (Product definition and hard constraint #3). "Live by evening if winning by lunch": no winner before 200 connected calls per arm, and we test once a day. The persuasive prompt everywhere: prompts change only to fix an incident, with validation evidence.
- **Wrong claims:** *"Kestrel turned on auto-apply for everything"*: ks_cancel's policy excludes prompt and cohort changes and caps each move at 20% of traffic. *"Northwind is fine with auto-apply on KYC"*: `nw_kyc` has auto-apply **disabled**, and Northwind's compliance head requires named human approval for anything customer-facing. The persuasive prompt (P4) validated at 0.972 in our runs, below our 0.98 bar.
- **Reply:** "Nikhil — for the summit we can show real per-client lifts: on our test runs, +13% and +26% more leads concluded, with pickup and engagement shown separately, because that's the product definition. Two things I can't do: push winners live the same day (a lunch-time 'winner' is usually noise, and a wrong one hurts a client's customers), and auto-apply what customers hear. Kestrel's and Northwind's signed policies don't allow it. What I can promise: no request spam (one batched request, max two a day) and an audit trail that makes the story credible."

### 02 — Meera Iyer, Head of Compliance, Northwind
- **Accepted, all of it.** Customer-facing changes (greeting, voice, script, cohorts) always go through a named approver, even where policy would allow more. Prompt changes carry a `validation_run_id` (≥ 0.98 pass rate, stricter than the 0.97 policy floor). Requests go out only inside 10:00–18:00 (KYC 10:00–17:00), leaving the approver time to act the same day. "Slow and right": at most 40% of a cohort hears an untested variant, clear losers are dropped, and winners keep a 20% holdout.
- **Gap, stated honestly:** "why did *this customer* hear X" is answered at cohort level: the customer's cohort (from their features), the config version live at that time, and why it was live. Per-call variants are aggregated, not stored per call; storing them in cold storage would close the gap.
- **Reply:** "Meera — agreed on all five points. Nothing your customers hear changes without your approver; operational changes (caller-ID rotation) are logged and listed in a daily summary with the reason. Script changes always carry a validation run. For an IRDAI question we can show, within minutes, which variant a customer's cohort was on at any moment, which approval made it live and why. Today that's at cohort level; per-call records are on the roadmap."

### 03 — Kabir Menon, Platform & SRE
- **Accepted:** kill/restart test (`node scripts/crash-test.ts`: 4 random `kill -9`s, identical grade report). Idempotency: deterministic `proposal_id`s, a write-ahead `sending` row, reconciliation on restart, and chunk + cursor in one transaction. No new stateful infrastructure: SQLite is a file inside the process, so there's no server for anyone to run at 2 a.m. Loop health is printed once per simulated day (ingest rate, memory, credits). Alerts are `ALERT` rows and stderr lines saying what to look at.
- **Pushed back:** none. The one trade-off is that the store is a local file, so this runs as a single process (see §8 for partitioning).
- **Reply:** "Kabir — the kill test is in the repo (`scripts/crash-test.ts`, log in `reports/`): 4 random kill -9s, and the run finishes with a byte-identical outcome. Every write is idempotent. No new infra: state is one SQLite file per deployment, on the same tables I'd move to your Postgres. public_03 numbers and what breaks at 10× are in §8. Every alert names the workflow and what to check."

### 04 — Anita Desai, Operations Supervisor, Kestrel
- **Accepted:** at most **2 requests a day, none before 11:00** (stricter than the policy's 4/day from 10:00; incidents excepted). Several changes go in one request. One screen: `why.ts summary`. Her edits are never undone silently: after a supervisor edit the controller leaves that dimension alone for 48h, and the one time we reverted her prompt (a hallucination spike) it went to her approver with evidence. Never the "strict script": a long-proven prompt is never swapped automatically, and the first-choice fix is a prompt that already ran well on her calls.
- **Partly:** "tell me before anything changes on a running campaign": customer-facing changes always need her approver; caller-ID rotation is auto-applied under the signed policy and appears in the summary.
- **Reply:** "Anita — max two requests a day, never before 11:00, several changes per request. You'll see everything on one screen: what's being tested, what's winning, what's waiting for you, what changed today. I won't undo your edits behind your back; I'll leave anything you change alone for 48 hours. If your script ever causes a spike in made-up claims, you'll get a request with the evidence, not a silent revert. And no word-for-word compliance scripts: we fall back to the prompt that was already working on your line."

### 05 — Tara Kulkarni, Head of Product
- **Accepted:** separate KPIs everywhere. One cohort object (`controller/cohorts.ts`, the same definition sent to the simulator, so every call's `cohort_id` is ours). Every proposal has an impact score, diff, affected leads and dry run. Expired = rejected, and rules re-decide on fresh data under a new id. Only real calls count: stats come from each call's actual variant, and experiment state only moves when a config is actually applied.
- **Cohort size / window:** 2 cohorts (ages 46+ / 18–45), 200 connected calls per arm minimum, one look per day, 5-day time limit. Cost: only effects of roughly ≥ 10–15% are found within a week; smaller ones are missed (slower, fewer false winners).
- **Declined:** per-person call time (see C4). Done: supervisor view (CLI) and caller-ID health.
- **Reply:** "Tara — all definitions hold: separate KPIs, one shared cohort object, every proposal carries impact/diff/affected leads/dry run, expired means re-decide on fresh data, and only calls that actually happened count. On cohort size: two cohorts, ≥200 connected calls per arm, one look a day. It finds ~10%+ effects within a week and keeps false winners near 5%. I cut per-person call time: it's the most code for the least evidence per person. Caller-ID health and the one-screen view are in."

### 06 — Aryamann, CTO
- **Accepted:** explainable over clever (z-tests, Holm, fixed thresholds, all in ~40 lines of `stats.ts`). Credits only where they change a decision: a known-good prompt is tried before paying for LLM suggestions; 5 credits for the whole of public_02. Choosing: §2. Docs for whoever is paged: this file and the header comment of every file.
- **Reply:** "Aryamann — I built five things properly: ingestion, caller-ID health, A/B tests with rollback, incident response, and governance + audit + crash safety. I cut per-person call time and cross-tenant fairness, and wrote to Tara and Nikhil about it. Zero harmful changes on both public scenarios; the first thing that breaks at 10× is single-process ingest, and the fix is partitioning by workflow (§8)."

## 4. Architecture

```
            simulator (HTTP)                                  controller (one Node process)
 ┌──────────────────────────────┐   chunks (NDJSON)   ┌───────────────────────────────────────────┐
 │ /events/chunks  /sim/advance │ ──────────────────► │ ingest.ts  chunk + cursor in ONE tx       │
 │ /workflows/*/config          │                     │      │                                    │
 │ /approvals  /apply  PUT cfg  │ ◄────────────────── │ main.ts  every sim hour, per workflow:     │
 │ /validation  /llm            │   governed changes  │   governance.processInFlight (poll/apply) │
 └──────────────────────────────┘                     │   rule-hallucination → own request        │
                                                      │   rule-caller-id     → auto-apply / batch │
                                                      │   rule-experiments   → batch (1 look/day) │
                                                      │   governance.submit  (the only writer)    │
                                                      └───────────────┬───────────────────────────┘
                                                                      ▼
                                       state/<scenario>.db (SQLite): kv · leads · stats · proposals
                                                                     · experiments · decisions (audit)
                                                                      ▲
                                                     why.ts: "why did X change?" + summary screen
```

| File | Lines | Job |
|---|---|---|
| `store.ts` | 114 | Tables + transaction helper |
| `ingest.ts` | 75 | Chunk → counts per (workflow, day, hour, cohort, variant), idempotently |
| `sim.ts` | 48 | HTTP client: GETs retried; writes never retried blindly |
| `stats.ts` | 44 | Normal CDF, two-proportion z-test, one-sample tests, Holm |
| `cohorts.ts` | 25 | The one cohort definition |
| `governance.ts` | 274 | Policy checks, proposal state machine, crash reconciliation |
| `rule-caller-id.ts` / `rule-experiments.ts` / `rule-hallucination.ts` | 98 / 210 / 145 | The three rules (+ `rule-helpers.ts`, 28) |
| `main.ts` | 105 | The loop |
| `why.ts` | 106 | Audit + summary CLI |

About 1,270 lines of controller code in total, plus 135 lines of unit tests and 84 lines of scripts.

**On restart:** reopen the DB → `reconcile` (each `sending` row is looked up in the simulator, then finished or deleted) → ingest every chunk after the saved cursor → carry on. If the simulator itself restarted (sim time went backwards), the controller starts a fresh state file.

## 5. The learning loop

- **Cohorts:** two, by age (46+ vs 18–45), defined once in `cohorts.ts` and sent as `config.cohorts`, so each call event's `cohort_id` *is* our cohort. Two because each arm needs ≥ 200 connected calls and a workflow gets ~1,000 connected calls a day: more cohorts would never reach a decision. Age because it splits traffic ~50/50 and is the likeliest driver of voice/greeting preference.
- **Experiment design:** per (cohort, dimension), control keeps 60% and the alternatives share 40% equally. Welcome and voice are tested at the same time: the simulator samples them independently, so each comparison is balanced over the other (a factorial design). Interactions are not modelled.
- **Deciding a winner:** one-sided two-proportion z-test vs control on the primary KPI; ≥ 200 connected calls per arm; Holm correction across the alternatives at α = 0.01; ≥ 5% relative lift; guardrail not significantly broken. One look per day. α = 0.01 per look over ~8 looks is close to a Pocock boundary for an overall ~5% false-winner rate. A clearly worse arm (p < 0.05) is dropped early. After 5 days, arms still behind control are dropped.
- **Decay and rollback:** a promoted winner keeps a 20% holdout on the old control. Each day, over the last 48h, roll back if the holdout beats the winner (p < 0.10), or the winner fell ≥ 10% below the rate it won with (p < 0.01) while the holdout did not fall similarly (so it's not a bad day for everyone). public_01/02: the decaying W3 was fully rolled back (0% share by day 7 / day 6).
- **Call time and caller ID:** call time is cut (C4). Caller ID: compare each number's last-24h pickup with the other numbers combined. Bad = < 75% of the others and p < 0.01 → out of rotation. Otherwise spread evenly across proven numbers; new numbers get 5% until 150 dials. Auto-applied in steps of at most `max_shift` where policy allows; otherwise batched into the next approval.
- **Guardrail:** before promotion, the winner's pickup must not be significantly below control's by more than the allowed drop. Pickup-primary workflows get no voice/greeting tests (assumption 1).

## 6. Governance

- **State machine:** `sending → pending → approved → applied`, `pending → rejected | expired`, `approved → lapsed | stale`, `sending → auto_applied | failed`. Nothing is ever resent: rules re-decide next hour on fresh data under a new id, which covers expiry, lapse and stale-base re-proposal.
- **Timing and batching:** requests only within approver hours minus the last hour (Kestrel from 11:00). At most 2 per workflow per 24h (policy may allow more). One proposal in flight per workflow, so requests never conflict. All rule outputs from the same hour go in one request. Incidents skip the voluntary limits (never the policy's).
- **Auto-apply:** only caller ID and schedule, only where policy allows, and within `max_shift` per step. Voluntarily never voice, greeting, prompt or cohorts, even on ks_cancel, where policy would allow voice and greeting.
- **Impact / affected / dry run:** affected leads = leads in still-running campaigns in the affected cohort. Impact = expected relative lift × traffic share × 5 (capped at 1). Exploration is honestly 0.1, an incident scales with how far above normal the flag rate is, and pulling a bad number scales with its traffic share. The dry run is the evidence: per-arm rates since the test started, per-number pickup, or the fix prompt's record on real calls. For a new test: calls per day in that cohort and days until each arm reaches 200.
- **Supervisor edits mid-experiment:** detected because the live allocation no longer matches what we set. The experiment is marked `interrupted` and that dimension is left alone for 48h. In public_02 the D5 15:00 voice edit on nw_renewal was left in place, and no request was sent over it.

## 7. Incidents

- **Thresholds:** 6h window. For a prompt that recently changed: ≥ 200 connected calls, ≥ 2× the normal flag rate, p < 0.001. For a prompt already proven on thousands of calls: ≥ 300 calls, ≥ 2.5×, p < 0.0001, and **page a human instead of swapping prompts**. An earlier version without this split produced one false positive on a proven prompt; the LLM-suggested "strict" prompt it applied cut engagement 14% (harmful). That's why the rule exists.
- **Fix choice:** a prompt that already ran on 500+ real calls at a normal flag rate (free, and its engagement is known); only if none exists, `/llm/suggest-fixes` (3 credits). Each candidate is validated on 500 conversations (5 credits) and must reach 0.98. A 20-credit reserve is kept for the next incident. A fix found once is reused if the request has to be resent.
- **Verify:** after apply, 200+ connected calls must show the flag rate back under 2× normal; otherwise the incident reopens and pages.
- **public_02 timeline (ks_cancel), from `why.ts`:** D3 11:30 supervisor ships P2 → D3 14:00 detected (5.0% of 298 calls flagged vs 1.4% normal), P1 validated 0.986, request sent → 14:33 approved → **15:00 applied** → 18:00 verified (1.1% on 264 calls). Hallucinated calls 330 → ~95, 5 credits.
- **Caller ID (D2 flagged D2 10:00):** detected and moved off in two auto-applied steps the same afternoon (ks_cancel policy max_shift 0.2); 0% share from day 3.

## 8. Scale

Measured on public_03_load (12 workflows, ~650k dials/day) on a Windows laptop:

| Metric | Value (from `reports/load_public_03.log`) |
|---|---|
| Ingest throughput | **46–50k events/s**, single thread (JSON parse + SQLite upserts) |
| Wall-clock per simulated day | **67–75 s** (target < 10 min). Includes the simulator's own ~20 s/day |
| Bootstrap from history | 5.54M events (7 days) in 111 s |
| Decision lag | rules run every simulated hour right after that hour's chunk is ingested: data is at most 1 sim hour old; ~3 s wall per sim hour |
| Peak memory (RSS) | **396 MB** |
| State file | 339 MB after 12 days, mostly the `leads` table |
| Outcome | +18.7% leads concluded vs baseline, 52 changes applied, **0 harmful** (`reports/public_03_load.md`) |

**What breaks first at 10×** (~6.5M dials/day, ~8.4M events/day): ingest alone becomes ~3 min per sim day and history bootstrap ~20 min. Still workable, but (1) the `leads` table grows ~3 GB per 12 days and its inserts dominate, (2) SQLite's single writer serialises everything, (3) one slow workflow delays all the others in the same hourly pass. **Partitioning:** the loop is already per-workflow with no shared state between workflows (only the event cursor). Shard workflows across N worker processes, each with its own cursor and store (or its own Postgres schema), with a tenant → worker map. Events would be routed by `workflow_id` from a queue instead of shared chunks. Raw-ish data stays bounded: `stats` grows with workflows × hours × cohorts × variants, not with calls.

## 9. Reliability

- **Test:** `node scripts/crash-test.ts public_02_incidents` kills the controller with SIGKILL 4 times at random points (3–10 s each, landing mid-ingest, mid-rules or mid-request), restarts it each time, and grades. Result: `reports/crash_public_02_incidents.md` is **byte-identical** to the uninterrupted `reports/public_02_incidents.md` (log: `reports/crash_test_public_02.log`).
- **State lost:** none that matters. A validation run started just before a kill could be paid for twice (≤ 5 credits). It's a POST without an idempotency key in the simulator API.
- **Idempotency keys:** chunk number (with the cursor in the same transaction); `proposal_id = <workflow>:<kind>:<sim minute>` (deterministic, so a restart in the same hour can't create a second request); `sending` rows reconciled against `/approvals` and `/config/history`.
- **4xx/5xx:** GETs retry with backoff on network errors and 5xx. Writes are never blindly retried; a 4xx on a write marks the proposal `failed` (logged) and the rules re-decide next hour. 409 stale or 410 lapsed on apply → `stale` / `lapsed`. A network error leaves the row `sending` for reconciliation.

## 10. Audit & observability

```
$ node controller/why.ts public_02_incidents ks_cancel "D3 15:00"
ks_cancel changed to config v9 at D3 15:00 (2027-01-07T15:00:00+05:30)
  what:  prompt_version
  why:   Fix hallucinations: switch prompt P2 → P1
         5.0% of 298 connected calls flagged in the last 6h on P2 vs 1.4% normally. P1 ran safely on real calls before;
         validation pass rate 0.986 on 500 conversations (val_00001).
  evidence (dry run): {"prompt_P1_on_real_calls":{"connected":20246,"flag_rate":"1.3%","engagement_rate":"50.6%"}}
  impact score 0.92, affected leads 4500, proposal ks_cancel:incident:5160
  who:   requested D3 14:00 as apr_00007; approved by the kestrel_finance approver at D3 14:33; applied D3 15:00
  before (24h): pickup 26.2% (4800 dials), engagement 51.2% (1259 connected)
  after  (24h): pickup 25.5% (4800 dials), engagement 49.9% (1224 connected)
  what happened next (48h):
    D3 18:00  incident_verified: prompt P1: flag rate 1.1% on 264 calls after the fix
    ...
```
`node controller/why.ts <scenario> <workflow>` lists every change; `node controller/why.ts <scenario> summary` is the one-screen supervisor view.

- **Page on:** a hallucination spike with no validated fix; a fix that didn't work; a spike on a long-proven prompt; credits below the reserve; the controller not advancing (ingest lag > 1 sim hour); every caller ID flagged for a workflow.
- **Don't page (summary screen / morning):** rejected or expired proposals, a single caller ID flagged and rotated out, experiments interrupted by a supervisor, tests ending without a winner.

## 11. Results

**public_01_dev** (`reports/public_01_dev.md`): 16 changes applied: 9 beneficial, 7 neutral, **0 harmful**. 0 credits.

| workflow | conclusion rate | Δ | pickup | Δ | engagement | Δ | engagement gap captured | hallucinated calls (base) |
|---|---|---|---|---|---|---|---|---|
| ks_cancel | 0.389 | +16.7% | 0.261 | +9.5% | 0.520 | +5.9% | 29% | 59 (47) |
| nw_kyc | 0.431 | +18.4% | 0.278 | +14.8% | 0.598 | +1.2% | 0% | 25 (21) |
| nw_renewal | 0.445 | +6.0% | 0.279 | +5.9% | 0.549 | +0.7% | 10% | 43 (42) |
| ALL | 0.416 | +13.0% | 0.270 | +9.2% | 0.546 | +3.0% | 15% | 127 (110) |

**public_02_incidents** (`reports/public_02_incidents.md`): 19 changes applied: 11 beneficial, 8 neutral, **0 harmful**. Incident fixed in 210 min. 5 credits.

| workflow | conclusion rate | Δ | pickup | Δ | engagement | Δ | engagement gap captured | hallucinated calls (base) |
|---|---|---|---|---|---|---|---|---|
| ks_cancel | 0.367 | +48.5% | 0.247 | +34.2% | 0.509 | +6.9% | 38% | 95 (330) |
| nw_kyc | 0.472 | +26.0% | 0.294 | +21.3% | 0.606 | +2.4% | 0% | 35 (31) |
| nw_renewal | 0.459 | +7.6% | 0.287 | +9.5% | 0.539 | -1.7% | -5% | 60 (55) |
| ALL | 0.420 | +25.7% | 0.270 | +21.4% | 0.540 | +2.0% | 20% | 190 (416) |

**Where it helped:** pickup, everywhere. Spreading dials across healthy caller IDs and pulling the flagged one is the biggest lever (+9% to +34%), and it's operational, so it's auto-applied where allowed. ks_cancel: the hallucination fix (330 → 95 flagged calls) plus D2 removal. Engagement lifts came from promoted greetings/voices.

**Where it fell short:** nw_renewal engagement −1.7% in public_02. The decaying W3 was promoted, then rolled back. The supervisor's D5 voice edit was left in place (by design). Exploration traffic cost a little. nw_kyc engagement gap captured 0%, by design (pickup-primary: no voice/greeting tests). Hallucinated-call counts rise slightly where pickup rose: more connected calls at the same rate.

**Harmful changes during development** (fixed, kept here because they shaped the design): (1) a false hallucination alarm on the long-proven prompt led to an LLM "strict" prompt (−14% engagement). Proven prompts are now never swapped automatically. (2) Timed-out tests reverting everything to control threw away an unproven but real gain (−1.6%). Now only arms behind control are dropped.

**What I'd change next:** language-aware cohorts once volumes allow; rest-and-retest for flagged caller IDs; call-time weights (C4).

## 12. Trade-offs & rejected alternatives

| Option | Why considered | Why rejected / what instead |
|---|---|---|
| Thompson sampling / bandits | Faster exploitation | The winner must be chosen statistically and deterministically and be explainable to compliance; fixed splits + a z-test are easy to audit |
| Many fine-grained cohorts (age × language) | Effects are cohort-specific | Too few calls per arm to ever decide; two cohorts reach 200 calls per arm in days |
| Auto-applying voice/greeting on ks_cancel (policy allows) | Faster | Northwind/Kestrel memos: customer-facing changes need a human; the approval latency there is short anyway |
| Postgres | SRE already runs it | Would add a network dependency to the graded box; same tables port directly |
| Storing raw calls | Per-customer audit | Size; aggregates answer every decision. Raw calls belong in cold storage |
| LLM picks the fix | Fast | Never decides; a known-good prompt is tried first and every candidate needs a validation pass |
| Ending timed-out tests by reverting to control | Simple | Threw away a real (unproven) gain once → harmful. Now only arms behind control are dropped |

## 13. Known weaknesses

- Up to 40% of a cohort hears untested variants while exploring; dropping losers limits the harm but doesn't prevent it.
- Load fatigue and spam flagging aren't told apart: a heavily overused number can be flagged as bad (nw_kyc D1) and is never re-tested.
- Two fixed age cohorts. An effect that exists only for one language is diluted, so it's found later or not at all.
- Daily looks with a fixed α are a practical approximation, not a formal alpha-spending plan.
- For `mid_flight: next_campaign_only` workflows, older campaigns keep the old allocation, which can slightly bias an experiment's control arm.
- One-hour reaction granularity. Hallucination detection needs ~2–3 hours of calls.
- The impact score is a heuristic, not a forecast with an interval.
- Validation calls can be paid twice if the controller dies mid-call.

## 14. If this went to production at Formi next month

1. Put the store on the existing Postgres (same tables), keep one process per shard of workflows.
2. Wire the ALERT rows and the daily health line into the existing pager/metrics stack; add an "ingest lag" alarm.
3. Shadow mode for a week: compute every decision, send none, and compare with what supervisors actually did.
4. Turn on caller-ID health first (operational, auto-apply, biggest pickup win), then incidents, then experiments per client as approvers opt in.
5. Store raw call outcomes in cold storage for per-customer audits (Northwind/IRDAI).
6. Then C4: per-cohort call-time weights from history.
