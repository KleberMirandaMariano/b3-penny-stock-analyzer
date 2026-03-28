import Papa from 'papaparse';
import { RAW_STOCK_DATA, MOCK_OPTIONS_DATA } from '../data';
import { StockData, OptionData, parseCurrency, parsePercentage, parseNumber } from '../utils';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

export interface StocksResponse {
  stocks: StockData[];
  lastUpdate: string;
  dataReferencia: string;
  fonte: string;
  isLive: boolean;
}

// ---------------------------------------------------------------------------
// Parsing do CSV estático (fallback)
// ---------------------------------------------------------------------------
function parseStaticCsv(): StockData[] {
  const results = Papa.parse(RAW_STOCK_DATA, {
    header: true,
    skipEmptyLines: true,
  });

  return (results.data as any[])
    .filter((row) => row.Ticker && row.Empresa)
    .map((row) => ({
      ticker: row.Ticker,
      empresa: row.Empresa,
      preco: parseCurrency(row['Preço Atual (R$)']),
      setor: row.Setor || 'N/A',
      dy: parsePercentage(row['Dividend Yield (%)']),
      pl: parseNumber(row['P/L']),
      pvp: parseNumber(row['P/VP']),
      var1a: null,
      var5a: parsePercentage(row['Variação 5 Anos (%)']),
      upsideGraham: parsePercentage(row['Upside Graham (%)']),
      varDia: parsePercentage(row['Var. Dia (%)']),
      varSemana: parsePercentage(row['Var. Semana (%)']),
      volume: parseNumber(row.Volume),
      ultimaAtualizacao: row['Última Atualização'],
      opcoes: MOCK_OPTIONS_DATA[row.Ticker] || [],
    }));
}

// ---------------------------------------------------------------------------
// Parsing do JSON retornado pela API
// ---------------------------------------------------------------------------
function parseApiResponse(data: any): StocksResponse {
  const acoes: StockData[] = (data.acoes ?? []).map((row: any) => ({
    ticker: row.ticker ?? '',
    empresa: row.empresa ?? row.ticker ?? '',
    preco: typeof row.preco === 'number' ? row.preco : 0,
    setor: row.setor ?? 'N/A',
    dy: row.dy ?? null,
    pl: row.pl ?? null,
    pvp: row.pvp ?? null,
    var1a: row.var1a ?? null,
    var5a: row.var5a ?? null,
    upsideGraham: row.upsideGraham ?? null,
    varDia: row.varDia ?? null,
    varSemana: row.varSemana ?? null,
    volume: row.volume ?? null,
    ultimaAtualizacao: row.ultimaAtualizacao ?? data.atualizadoEm ?? '',
    opcoes: row.opcoes ?? [],
  }));

  return {
    stocks: acoes,
    lastUpdate: data.atualizadoEm ?? '',
    dataReferencia: data.dataReferencia ?? '',
    fonte: data.fonte ?? 'yfinance',
    isLive: true,
  };
}

// ---------------------------------------------------------------------------
// Função principal – tenta API, usa CSV estático como fallback
// ---------------------------------------------------------------------------
export async function getStocks(): Promise<StocksResponse> {
  try {
    // Render free tier pode demorar até 50s no cold start
    const res = await fetch(`${API_BASE}/api/stocks`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const parsed = parseApiResponse(data);
    if (parsed.stocks.length < 10) throw new Error('Dados insuficientes da API');
    return parsed;
  } catch {
    // Fallback: dados estáticos do CSV embutido
    const stocks = parseStaticCsv();
    const firstDate = stocks[0]?.ultimaAtualizacao ?? '';
    return {
      stocks,
      lastUpdate: firstDate,
      dataReferencia: '',
      fonte: 'CSV estático (API indisponível)',
      isLive: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Busca opções de uma ação específica (lazy-loading)
// ---------------------------------------------------------------------------
export async function getOptions(ticker: string): Promise<OptionData[]> {
  try {
    const res = await fetch(`${API_BASE}/api/options/${ticker}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.opcoes ?? []).map((o: any) => ({
      ticker: o.ticker ?? '',
      tipo: o.tipo ?? 'CALL',
      strike: o.strike ?? null,
      preco: o.preco ?? null,
      vencimento: o.vencimento ?? '',
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Busca bid/ask ao vivo para opções de um ticker via yfinance (~15 min delay)
// ---------------------------------------------------------------------------
export interface LiveOptionData {
  ticker: string;
  tipo: 'CALL' | 'PUT';
  strike: number | null;
  preco: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  vencimento: string;
}

export async function getOptionsLive(ticker: string): Promise<{ opcoes: LiveOptionData[]; aviso?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/options/${ticker}/live`, { signal: AbortSignal.timeout(35_000) });
    if (!res.ok) return { opcoes: [] };
    const data = await res.json();
    return {
      opcoes: (data.opcoes ?? []).map((o: any) => ({
        ticker: o.ticker ?? '',
        tipo: o.tipo ?? 'CALL',
        strike: o.strike ?? null,
        preco: o.preco ?? null,
        bid: o.bid ?? null,
        ask: o.ask ?? null,
        volume: o.volume ?? null,
        openInterest: o.openInterest ?? null,
        impliedVolatility: o.impliedVolatility ?? null,
        vencimento: o.vencimento ?? '',
      })),
      aviso: data.aviso,
    };
  } catch {
    return { opcoes: [] };
  }
}

// ---------------------------------------------------------------------------
// Consulta o status da atualização em andamento
// ---------------------------------------------------------------------------
export async function getUpdateStatus(): Promise<{ updateInProgress: boolean }> {
  try {
    const res = await fetch(`${API_BASE}/api/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { updateInProgress: false };
    const data = await res.json();
    return { updateInProgress: data.updateInProgress ?? false };
  } catch {
    return { updateInProgress: false };
  }
}

// ---------------------------------------------------------------------------
// Dispara atualização na API (não-bloqueante)
// ---------------------------------------------------------------------------
export async function triggerUpdate(ticker?: string): Promise<{ ok: boolean; mensagem?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPreco: 10.0, ticker }),
      signal: AbortSignal.timeout(60_000), // aguarda cold start do Render
    });
    const body = await res.json();
    return { ok: res.ok, mensagem: body.mensagem ?? body.error };
  } catch (err: any) {
    return { ok: false, mensagem: err?.message };
  }
}
