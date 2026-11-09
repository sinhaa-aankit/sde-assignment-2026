// The only statistics the controller uses. Plain, deterministic, no LLM anywhere near it.

// Standard normal CDF. Abramowitz & Stegun 7.1.26 approximation (error < 1.5e-7).
export function normCdf(z: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp((-z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export const rate = (x: number, n: number) => (n > 0 ? x / n : 0);

// One-sided two-proportion z-test. Small p => rate A (xa/na) is really higher than rate B (xb/nb).
export function pGreater(xa: number, na: number, xb: number, nb: number): number {
  if (na === 0 || nb === 0) return 1;
  const pooled = (xa + xb) / (na + nb);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / na + 1 / nb));
  if (se === 0) return 1;
  return 1 - normCdf((xa / na - xb / nb) / se);
}

// One-sided one-sample z-test. Small p => observed x/n is really above the expected rate p0.
export function pAbove(x: number, n: number, p0: number): number {
  if (n === 0 || p0 <= 0 || p0 >= 1) return 1;
  return 1 - normCdf((x / n - p0) / Math.sqrt((p0 * (1 - p0)) / n));
}

// The other direction. Small p => observed x/n is really below p0 (e.g. a winner that stopped winning).
export function pBelow(x: number, n: number, p0: number): number {
  if (n === 0 || p0 <= 0 || p0 >= 1) return 1;
  return normCdf((x / n - p0) / Math.sqrt((p0 * (1 - p0)) / n));
}

// Holm-Bonferroni: which of these p-values are significant when testing them all together at `alpha`.
// Controls the chance of even one false winner across all challengers.
export function holm(ps: number[], alpha: number): boolean[] {
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const out = ps.map(() => false);
  for (let k = 0; k < order.length; k++) {
    if (order[k][0] > alpha / (order.length - k)) break; // stop at the first one that fails
    out[order[k][1]] = true;
  }
  return out;
}
