import { describe, it, expect } from 'vitest';
import { normCDF, normPDF, bsPrice, calcIV, calcGreeks } from './blackScholes';

// Parâmetros de referência (exemplo clássico de livro-texto)
const S = 100, K = 100, T = 1, r = 0.05, sigma = 0.2;

describe('normCDF', () => {
  it('vale 0.5 em x=0', () => {
    expect(normCDF(0)).toBeCloseTo(0.5, 6);
  });

  it('é simétrica: N(-x) = 1 - N(x)', () => {
    expect(normCDF(-1.3)).toBeCloseTo(1 - normCDF(1.3), 6);
  });

  it('tende aos limites 0 e 1 nas caudas', () => {
    expect(normCDF(-6)).toBeCloseTo(0, 4);
    expect(normCDF(6)).toBeCloseTo(1, 4);
  });

  it('bate com valor conhecido N(1.96) ≈ 0.975', () => {
    expect(normCDF(1.96)).toBeCloseTo(0.975, 3);
  });
});

describe('normPDF', () => {
  it('pico em x=0 é 1/sqrt(2π)', () => {
    expect(normPDF(0)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 6);
  });
});

describe('bsPrice', () => {
  it('preço de CALL bate com o valor de referência (~10.4506)', () => {
    expect(bsPrice('CALL', S, K, T, r, sigma)).toBeCloseTo(10.4506, 2);
  });

  it('preço de PUT bate com o valor de referência (~5.5735)', () => {
    expect(bsPrice('PUT', S, K, T, r, sigma)).toBeCloseTo(5.5735, 2);
  });

  it('respeita a paridade put-call: C - P = S - K·e^(-rT)', () => {
    const call = bsPrice('CALL', S, K, T, r, sigma);
    const put = bsPrice('PUT', S, K, T, r, sigma);
    expect(call - put).toBeCloseTo(S - K * Math.exp(-r * T), 6);
  });

  it('no vencimento (T=0) retorna o valor intrínseco', () => {
    expect(bsPrice('CALL', 120, 100, 0, r, sigma)).toBe(20);
    expect(bsPrice('CALL', 80, 100, 0, r, sigma)).toBe(0);
    expect(bsPrice('PUT', 80, 100, 0, r, sigma)).toBe(20);
    expect(bsPrice('PUT', 120, 100, 0, r, sigma)).toBe(0);
  });
});

describe('calcIV', () => {
  it('recupera a volatilidade usada para precificar (round-trip CALL)', () => {
    const trueSigma = 0.35;
    const price = bsPrice('CALL', S, K, T, r, trueSigma);
    const iv = calcIV('CALL', S, K, T, r, price);
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(trueSigma, 3);
  });

  it('recupera a volatilidade usada para precificar (round-trip PUT)', () => {
    const trueSigma = 0.18;
    const price = bsPrice('PUT', 95, 100, 0.5, r, trueSigma);
    const iv = calcIV('PUT', 95, 100, 0.5, r, price);
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(trueSigma, 3);
  });

  it('retorna null para parâmetros inválidos', () => {
    expect(calcIV('CALL', S, K, 0, r, 5)).toBeNull();
    expect(calcIV('CALL', S, K, T, r, 0)).toBeNull();
    expect(calcIV('CALL', 0, K, T, r, 5)).toBeNull();
  });
});

describe('calcGreeks', () => {
  it('delta de CALL fica em (0, 1) e de PUT em (-1, 0)', () => {
    const call = calcGreeks('CALL', S, K, T, r, sigma)!;
    const put = calcGreeks('PUT', S, K, T, r, sigma)!;
    expect(call.delta).toBeGreaterThan(0);
    expect(call.delta).toBeLessThan(1);
    expect(put.delta).toBeGreaterThan(-1);
    expect(put.delta).toBeLessThan(0);
  });

  it('relação de delta entre CALL e PUT: deltaCall - deltaPut = 1', () => {
    const call = calcGreeks('CALL', S, K, T, r, sigma)!;
    const put = calcGreeks('PUT', S, K, T, r, sigma)!;
    expect(call.delta - put.delta).toBeCloseTo(1, 6);
  });

  it('gamma e vega são positivos e idênticos entre CALL e PUT', () => {
    const call = calcGreeks('CALL', S, K, T, r, sigma)!;
    const put = calcGreeks('PUT', S, K, T, r, sigma)!;
    expect(call.gamma).toBeGreaterThan(0);
    expect(call.vega).toBeGreaterThan(0);
    expect(call.gamma).toBeCloseTo(put.gamma, 9);
    expect(call.vega).toBeCloseTo(put.vega, 9);
  });

  it('theta de CALL comprada é negativo (decaimento temporal)', () => {
    const call = calcGreeks('CALL', S, K, T, r, sigma)!;
    expect(call.theta).toBeLessThan(0);
  });

  it('retorna null para parâmetros inválidos', () => {
    expect(calcGreeks('CALL', S, K, 0, r, sigma)).toBeNull();
    expect(calcGreeks('CALL', S, K, T, r, 0)).toBeNull();
    expect(calcGreeks('CALL', S, 0, T, r, sigma)).toBeNull();
  });
});
