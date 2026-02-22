import Papa from 'papaparse';
import { RAW_STOCK_DATA } from '../data';
import { StockData, parseCurrency, parsePercentage, parseNumber } from '../utils';

export function getStocks(): StockData[] {
  const results = Papa.parse(RAW_STOCK_DATA, {
    header: true,
    skipEmptyLines: true,
  });

  return (results.data as any[])
    .filter(row => row.Ticker && row.Empresa) // Filter out incomplete rows like PETZ3
    .map(row => ({
      ticker: row.Ticker,
      empresa: row.Empresa,
      preco: parseCurrency(row['Preço Atual (R$)']),
      setor: row.Setor || 'N/A',
      dy: parsePercentage(row['Dividend Yield (%)']),
      pl: parseNumber(row['P/L']),
      pvp: parseNumber(row['P/VP']),
      var5a: parsePercentage(row['Variação 5 Anos (%)']),
      upsideGraham: parsePercentage(row['Upside Graham (%)']),
      varDia: parsePercentage(row['Var. Dia (%)']),
      varSemana: parsePercentage(row['Var. Semana (%)']),
      volume: parseNumber(row.Volume),
      ultimaAtualizacao: row['Última Atualização'],
    }));
}
