// The ONE shared cohort definition. Experiments, the affected-lead counts and the summary screen all use it,
// and it is the same object we send to the simulator in config.cohorts — so every call event's cohort_id
// already says which of our cohorts it belongs to.
//
// Why only two, split by age: every arm in an experiment needs ~200+ connected calls before we test it.
// A workflow gets ~1,000 connected calls a day; more cohorts would split that too thin to ever reach a decision.
// Age is the feature most likely to change how people react to a voice or greeting, and it splits traffic ~50/50.

const OLDER = ["46-60", "60+"];

export const COHORT_DEFS = [{ id: "older", where: { age_band: OLDER } }];
export const COHORT_IDS = ["older", "default"]; // "default" = everyone not in an earlier cohort (ages 18-45)

export const COHORT_LABEL: Record<string, string> = { older: "ages 46+", default: "ages 18-45" };

// SQL condition on the leads table for "is in this cohort".
export function cohortSql(cohort: string): string {
  const list = OLDER.map((a) => `'${a}'`).join(",");
  return cohort === "older" ? `age_band IN (${list})` : `age_band NOT IN (${list})`;
}

// True when the config has no cohorts yet (we may add ours) or already has exactly ours.
export function cohortsAreOurs(config: any): boolean {
  return config.cohorts.length === 0 || JSON.stringify(config.cohorts) === JSON.stringify(COHORT_DEFS);
}
