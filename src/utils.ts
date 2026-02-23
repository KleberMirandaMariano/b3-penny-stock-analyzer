import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface OptionData {
  ticker: string;
  tipo: 'CALL' | 'PUT';
  strike: number | null;
  preco: number | null;
  vencimento: string;
}

export interface StockData {
  ticker: string;
  empresa: string;
  preco: number;
  setor: string;
  dy: number | null;
  pl: number | null;
  pvp: number | null;
  var5a: number | null;
  upsideGraham: number | null;
  varDia: number | null;
  varSemana: number | null;
  volume: number | null;
  ultimaAtualizacao: string;
  opcoes?: OptionData[];
}

export function parseCurrency(val: string): number {
  if (!val) return 0;
  return parseFloat(val.replace('R$', '').replace('.', '').replace(',', '.').trim());
}

export function parsePercentage(val: string): number | null {
  if (!val || val === '') return null;
  return parseFloat(val.replace('%', '').replace('+', '').replace(',', '.').trim());
}

export function parseNumber(val: string): number | null {
  if (!val || val === '') return null;
  return parseFloat(val.replace('.', '').replace(',', '.').trim());
}
