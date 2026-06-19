// ---------------------------------------------------------------------------
// Black-Scholes: precificação, volatilidade implícita e gregas
// ---------------------------------------------------------------------------

export type OptionType = 'CALL' | 'PUT';

export interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

/** Função de distribuição acumulada da normal padrão (aproximação de Abramowitz & Stegun). */
export function normCDF(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/** Densidade de probabilidade da normal padrão. */
export function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Preço teórico de uma opção europeia.
 * @param T tempo até o vencimento em anos
 * @param r taxa livre de risco (anual)
 * @param sigma volatilidade (anual)
 */
export function bsPrice(tipo: OptionType, S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0) return tipo === 'CALL' ? Math.max(0, S - K) : Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (tipo === 'CALL') return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

/** Volatilidade implícita por bisseção. Retorna null quando os parâmetros são inválidos. */
export function calcIV(tipo: OptionType, S: number, K: number, T: number, r: number, marketPrice: number): number | null {
  if (T <= 0 || marketPrice <= 0 || S <= 0 || K <= 0) return null;
  let low = 0.001, high = 10.0;
  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2;
    const price = bsPrice(tipo, S, K, T, r, mid);
    if (Math.abs(price - marketPrice) < 0.00001) return mid;
    if (price < marketPrice) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Gregas (delta, gamma, theta/dia, vega/1%). Retorna null quando os parâmetros são inválidos. */
export function calcGreeks(tipo: OptionType, S: number, K: number, T: number, r: number, sigma: number): Greeks | null {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const delta = tipo === 'CALL' ? normCDF(d1) : normCDF(d1) - 1;
  const gamma = normPDF(d1) / (S * sigma * sqrtT);
  const theta = tipo === 'CALL'
    ? (-S * normPDF(d1) * sigma / (2 * sqrtT) - r * K * Math.exp(-r * T) * normCDF(d2)) / 365
    : (-S * normPDF(d1) * sigma / (2 * sqrtT) + r * K * Math.exp(-r * T) * normCDF(-d2)) / 365;
  const vega = S * normPDF(d1) * sqrtT / 100;
  return { delta, gamma, theta, vega };
}
