import Papa from 'papaparse';
import { RAW_STOCK_DATA } from '../data';
import { StockData, parseCurrency, parsePercentage, parseNumber } from '../utils';

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
      ticker:           row.Ticker,
      empresa:          row.Empresa,
      preco:            parseCurrency(row['Preço Atual (R$)']),
      setor:            row.Setor || 'N/A',
      dy:               parsePercentage(row['Dividend Yield (%)']),
      pl:               parseNumber(row['P/L']),
      pvp:              parseNumber(row['P/VP']),
      var5a:            parsePercentage(row['Variação 5 Anos (%)']),
      upsideGraham:     parsePercentage(row['Upside Graham (%)']),
      varDia:           parsePercentage(row['Var. Dia (%)']),
      varSemana:        parsePercentage(row['Var. Semana (%)']),
      volume:           parseNumber(row.Volume),
      ultimaAtualizacao: row['Última Atualização'],
    }));
}

// ---------------------------------------------------------------------------
// Parsing do JSON retornado pela API
// ---------------------------------------------------------------------------
function parseApiResponse(data: any): StocksResponse {
  const acoes: StockData[] = (data.acoes ?? []).map((row: any) => ({
    ticker:            row.ticker ?? '',
    empresa:           row.empresa ?? row.ticker ?? '',
    preco:             typeof row.preco === 'number' ? row.preco : 0,
    setor:             row.setor ?? 'N/A',
    dy:                row.dy   ?? null,
    pl:                row.pl   ?? null,
    pvp:               row.pvp  ?? null,
    var5a:             row.var5a ?? null,
    upsideGraham:      row.upsideGraham ?? null,
    varDia:            row.varDia    ?? null,
    varSemana:         row.varSemana ?? null,
    volume:            row.volume    ?? null,
    ultimaAtualizacao: row.ultimaAtualizacao ?? data.atualizadoEm ?? '',
  }));

  return {
    stocks:         acoes,
    lastUpdate:     data.atualizadoEm   ?? '',
    dataReferencia: data.dataReferencia ?? '',
    fonte:          data.fonte          ?? 'yfinance',
    isLive:         true,
  };
}

// ---------------------------------------------------------------------------
// Função principal – tenta API, usa CSV estático como fallback
// ---------------------------------------------------------------------------
export async function getStocks(): Promise<StocksResponse> {
  try {
    const res = await fetch('/api/stocks', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const parsed = parseApiResponse(data);
    if (parsed.stocks.length === 0) throw new Error('API retornou lista vazia');
    return parsed;
  } catch {
    // Fallback: dados estáticos do CSV embutido
    const stocks = parseStaticCsv();
    const firstDate = stocks[0]?.ultimaAtualizacao ?? '';
    return {
      stocks,
      lastUpdate:     firstDate,
      dataReferencia: '',
      fonte:          'CSV estático (API indisponível)',
      isLive:         false,
    };
  }
}

// ---------------------------------------------------------------------------
// Dispara atualização na API (não-bloqueante)
// ---------------------------------------------------------------------------
export async function triggerUpdate(): Promise<{ ok: boolean; mensagem?: string }> {
  try {
    const res = await fetch('/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPreco: 10.0 }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    return { ok: res.ok, mensagem: body.mensagem ?? body.error };
  } catch (err: any) {
    return { ok: false, mensagem: err?.message };
  }
}
