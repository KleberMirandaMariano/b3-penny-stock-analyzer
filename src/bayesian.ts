// ---------------------------------------------------------------------------
// Atualização Bayesiana da taxa de acerto de uma estratégia (modelo Beta-Binomial)
// ---------------------------------------------------------------------------

export interface BayesianStats {
  wins: number;
  losses: number;
  priorAlpha: number;
  priorBeta: number;
  posteriorAlpha: number;
  posteriorBeta: number;
  winRateMap: number;   // moda da posterior (MAP), em fração (0–1)
  winRateMean: number;  // média da posterior, em fração (0–1)
  probOver50: number;   // P(taxa de acerto > 50%), em fração (0–1)
}

/** ln(Γ(x)) — aproximação de Lanczos. */
function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflexão: Γ(x)Γ(1-x) = π / sin(πx)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Fração continuada de Lentz para a função beta incompleta (Numerical Recipes). */
function betacf(x: number, a: number, b: number): number {
  const FPMIN = 1e-30;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h;
}

/** Função beta incompleta regularizada I_x(a, b) = CDF da distribuição Beta(a, b). */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta =
    logGamma(a + b) - logGamma(a) - logGamma(b) +
    a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lbeta);
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(x, a, b)) / a;
  return 1 - (bt * betacf(1 - x, b, a)) / b;
}

/**
 * Atualização Bayesiana: prior Beta(priorAlpha, priorBeta) + (wins, losses)
 * → posterior Beta(priorAlpha + wins, priorBeta + losses).
 */
export function bayesianUpdate(
  wins: number,
  losses: number,
  priorAlpha = 1,
  priorBeta = 1,
): BayesianStats {
  const a = priorAlpha + Math.max(0, wins);
  const b = priorBeta + Math.max(0, losses);
  // Moda (MAP) só é definida para a, b > 1; senão usa a média como melhor estimativa pontual.
  const winRateMap = a > 1 && b > 1 ? (a - 1) / (a + b - 2) : a / (a + b);
  const winRateMean = a / (a + b);
  const probOver50 = 1 - regularizedIncompleteBeta(0.5, a, b);
  return {
    wins: Math.max(0, wins),
    losses: Math.max(0, losses),
    priorAlpha,
    priorBeta,
    posteriorAlpha: a,
    posteriorBeta: b,
    winRateMap,
    winRateMean,
    probOver50,
  };
}
