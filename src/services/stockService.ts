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
      bid: o.bid ?? null,
      ask: o.ask ?? null,
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
// Camada quant (financial-analysis-framework) para a cadeia de um ativo
// ---------------------------------------------------------------------------
export interface QuantSerie {
  iv: number | null;       // % a.a.
  delta: number | null;
  justo: number | null;    // R$ (binomial americano, vol realizada)
  edgePct: number | null;  // mercado × justo, %
  pExerc: number | null;   // %
}
export interface QuantVencimento {
  pregoes: number;
  probAlta: number | null;
  p5: number | null;
  p95: number | null;
  ivAtm: number | null;
  volPrev?: number | null;  // vol prevista média até o vencimento, % a.a.
}
export interface QuantVol {
  rv10?: number;
  rv30?: number;
  rv60?: number;
  rvRobusta30?: number;
  ewma?: number;
  maiorMov?: { data: string; pct: number };
  evento?: boolean;          // maior movimento > 3 desvios robustos
  metodoPrev?: string;       // "GARCH(1,1)" ou "EWMA"
}
export interface OptionsQuant {
  disponivel: boolean;
  preparando?: boolean;   // histórico da B3 ainda sendo baixado no servidor
  motivo?: string;
  dataReferencia?: string;
  spot?: number;
  selic?: number;
  rv30?: number;
  vol?: QuantVol;
  regime?: { rotulo: string; prob: number; pregoes: number } | null;
  vencimentos?: Record<string, QuantVencimento>;
  series?: Record<string, QuantSerie>;
  simulacoes?: number;
  faf?: string;
}

export async function getOptionsQuant(ticker: string): Promise<OptionsQuant> {
  try {
    const res = await fetch(`${API_BASE}/api/options/${ticker}/quant`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { disponivel: false, motivo: `HTTP ${res.status}` };
    return await res.json();
  } catch (err: any) {
    return { disponivel: false, motivo: err?.message ?? 'Falha de rede' };
  }
}

// ---------------------------------------------------------------------------
// Análise IA de uma opção via OpenRouter (servidor)
// ---------------------------------------------------------------------------
export interface ChainRow {
  ticker: string;
  strike: number | null;
  ultimo: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  bsTeorico: number | null;
  pExercicio: number | null;
  focus?: boolean;
}

export interface AnaliseEstruturada {
  veredito: 'COMPRAR' | 'VENDER' | 'EVITAR' | 'AGUARDAR';
  confianca: 'BAIXA' | 'MEDIA' | 'ALTA';
  manchete: string;
  resumo: string;
  melhorStrike: string | null;
  motivoStrike: string | null;
  aFavor: string[];
  contra: string[];
  monitorar: string[];
}

export interface AnalyzeResult {
  analise: string;
  estruturada?: AnaliseEstruturada;
  modelo?: string;
}

export async function analyzeOption(payload: {
  opt: { ticker: string; tipo: string; strike: number | null; preco: number | null };
  stockPrice: number;
  stockTicker: string;
  greeks?: { delta: number; gamma: number; theta: number; vega: number } | null;
  iv?: number | null;
  daysToExpiry?: number | null;
  liveData?: { bid: number | null; ask: number | null; volume: number | null; openInterest: number | null } | null;
  vencimento?: string | null;
  chain?: ChainRow[] | null;
  bayesian?: {
    wins: number;
    losses: number;
    priorAlpha: number;
    priorBeta: number;
    posteriorAlpha: number;
    posteriorBeta: number;
    winRateMap: number;
    probOver50: number;
    sensitivity?: { rho: number; nEff: number; probOver50: number }[];
  } | null;
}): Promise<AnalyzeResult | { error: string }> {
  const res = await fetch(`${API_BASE}/api/options/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(70_000), // Aumentado de 30s para 70s (backend espera 60s)
  });
  return res.json();
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

// ---------------------------------------------------------------------------
// Usuário logado (login Google no VPS). Fora do VPS (dev) retorna email null.
// ---------------------------------------------------------------------------
export async function getMe(): Promise<{ email: string | null; logoutUrl: string | null }> {
  try {
    const res = await fetch(`${API_BASE}/api/me`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { email: null, logoutUrl: null };
    return await res.json();
  } catch {
    return { email: null, logoutUrl: null };
  }
}
