import React from 'react';
import { CheckCircle2, AlertTriangle, Eye, Star } from 'lucide-react';
import { cn } from '../utils';
import type { AnalyzeResult, ChainRow } from '../services/stockService';

// Cores e rótulos por veredito
const VEREDITO_STYLE: Record<string, { bg: string; text: string; ring: string; label: string }> = {
  COMPRAR: { bg: 'bg-emerald-500', text: 'text-emerald-700', ring: 'border-emerald-200 bg-emerald-50', label: 'Comprar' },
  VENDER: { bg: 'bg-sky-500', text: 'text-sky-700', ring: 'border-sky-200 bg-sky-50', label: 'Vender' },
  EVITAR: { bg: 'bg-rose-500', text: 'text-rose-700', ring: 'border-rose-200 bg-rose-50', label: 'Evitar' },
  AGUARDAR: { bg: 'bg-amber-500', text: 'text-amber-700', ring: 'border-amber-200 bg-amber-50', label: 'Aguardar' },
};

const CONFIANCA_NIVEL = { BAIXA: 1, MEDIA: 2, ALTA: 3 } as const;
const CONFIANCA_LABEL = { BAIXA: 'baixa', MEDIA: 'média', ALTA: 'alta' } as const;

const brl = (v: number | null | undefined) =>
  v == null ? '—' : `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v: number | null | undefined, dec = 0) => (v == null ? '—' : `${(v * 100).toFixed(dec)}%`);

interface Props {
  result: AnalyzeResult;
  chain: ChainRow[];
  stockTicker: string;
  stockPrice: number;
  daysToExpiry: number | null;
}

/** Card visual da análise IA: veredito, números-chave, strikes e listas curtas. */
export function AiAnalysisCard({ result, chain, stockTicker, stockPrice, daysToExpiry }: Props) {
  const a = result.estruturada;

  // Modelo antigo / resposta fora do formato: mostra o texto simples
  if (!a) {
    return <p className="text-xs text-[#141414]/70 leading-relaxed whitespace-pre-wrap">{result.analise}</p>;
  }

  const style = VEREDITO_STYLE[a.veredito] ?? VEREDITO_STYLE.AGUARDAR;
  const focus = chain.find((r) => r.focus) ?? chain[0];

  // Prêmio x valor justo (Black-Scholes): usa o Ask; sem Ask, o último negócio
  const premio = focus?.ask ?? focus?.ultimo ?? null;
  const premioFonte = focus?.ask != null ? 'Ask' : 'Último';
  const desvio = premio != null && focus?.bsTeorico ? premio / focus.bsTeorico - 1 : null;
  const precoLabel = desvio == null
    ? 'sem referência'
    : Math.abs(desvio) < 0.05 ? 'no preço justo' : desvio > 0 ? `${pct(desvio)} caro` : `${pct(-desvio)} barato`;

  const melhor = a.melhorStrike?.toUpperCase().replace('★', '').trim() ?? null;
  const strikes = [...chain].sort((x, y) => (x.strike ?? 0) - (y.strike ?? 0)).slice(0, 8);

  return (
    <div className="space-y-3">
      {/* Veredito */}
      <div className={cn('rounded-xl border p-3', style.ring)}>
        <div className="flex items-center justify-between gap-2">
          <span className={cn('px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider text-white', style.bg)}>
            {style.label}
          </span>
          <div className="flex items-center gap-1.5" title={`Confiança ${CONFIANCA_LABEL[a.confianca]}`}>
            <span className="text-[9px] uppercase font-bold tracking-widest text-[#141414]/40">Confiança</span>
            {[1, 2, 3].map((n) => (
              <span
                key={n}
                className={cn('w-2 h-2 rounded-full', n <= CONFIANCA_NIVEL[a.confianca] ? style.bg : 'bg-[#141414]/10')}
              />
            ))}
          </div>
        </div>
        {a.manchete && <p className={cn('mt-2 text-sm font-semibold leading-snug', style.text)}>{a.manchete}</p>}
      </div>

      {/* Números-chave (calculados no site, não pela IA) */}
      <div className="grid grid-cols-2 gap-2">
        <Metric label={stockTicker} value={brl(stockPrice)} />
        <Metric label="Strike" value={brl(focus?.strike)} hint={daysToExpiry != null ? `${daysToExpiry} dias` : undefined} />
        <Metric label="P(exercício)" value={pct(focus?.pExercicio)} />
        <Metric
          label={`${premioFonte} vs justo`}
          value={brl(premio)}
          hint={precoLabel}
          tone={desvio == null ? 'neutral' : Math.abs(desvio) < 0.05 ? 'neutral' : desvio > 0 ? 'bad' : 'good'}
        />
      </div>

      {/* Strikes: barra = P(exercício) */}
      {strikes.length > 1 && (
        <div className="rounded-xl border border-[#141414]/5 bg-white p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[9px] uppercase font-bold tracking-widest text-[#141414]/40">Strikes · P(exercício)</span>
            {melhor && (
              <span className="flex items-center gap-1 text-[9px] font-bold text-amber-600">
                <Star className="w-3 h-3 fill-amber-400 text-amber-400" /> melhor relação
              </span>
            )}
          </div>
          {strikes.map((r) => {
            const isBest = melhor != null && r.ticker.toUpperCase() === melhor;
            return (
              <div key={r.ticker} className={cn('flex items-center gap-2 text-[11px]', r.focus && 'font-bold')}>
                <span className="w-12 font-mono text-[#141414]/70">{r.strike?.toFixed(2) ?? '—'}</span>
                <div className="flex-1 h-2.5 rounded-full bg-[#141414]/5 overflow-hidden">
                  <div
                    className={cn('h-full rounded-full', r.focus ? 'bg-violet-500' : isBest ? 'bg-amber-400' : 'bg-[#141414]/20')}
                    style={{ width: `${Math.max(2, Math.min(100, (r.pExercicio ?? 0) * 100))}%` }}
                  />
                </div>
                <span className="w-9 text-right font-mono text-[#141414]/60">{pct(r.pExercicio)}</span>
                <span className="w-4">{isBest && <Star className="w-3 h-3 fill-amber-400 text-amber-400" />}</span>
              </div>
            );
          })}
          <p className="text-[9px] text-[#141414]/40">Roxo = opção selecionada.</p>
        </div>
      )}
      {a.melhorStrike && a.motivoStrike && (
        <p className="text-[11px] text-[#141414]/60 leading-snug">
          <span className="font-bold text-amber-600">★ {a.melhorStrike}:</span> {a.motivoStrike}
        </p>
      )}

      {/* Listas curtas */}
      <ListBlock icon={<CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />} title="A favor" items={a.aFavor} />
      <ListBlock icon={<AlertTriangle className="w-3.5 h-3.5 text-rose-500" />} title="Contra" items={a.contra} />
      <ListBlock icon={<Eye className="w-3.5 h-3.5 text-sky-500" />} title="Monitorar" items={a.monitorar} />

      {a.resumo && <p className="text-[11px] text-[#141414]/60 leading-relaxed border-t border-violet-200/50 pt-2">{a.resumo}</p>}

      {result.modelo && (
        <p className="text-[9px] text-[#141414]/30 font-mono truncate" title={result.modelo}>IA: {result.modelo}</p>
      )}
    </div>
  );
}

function Metric({ label, value, hint, tone = 'neutral' }: {
  label: string; value: string; hint?: string; tone?: 'good' | 'bad' | 'neutral';
}) {
  return (
    <div className="rounded-lg bg-white border border-[#141414]/5 px-2.5 py-2">
      <div className="text-[9px] uppercase font-bold tracking-widest text-[#141414]/40 truncate">{label}</div>
      <div className="font-mono text-sm font-bold text-[#141414]">{value}</div>
      {hint && (
        <div className={cn('text-[10px]', tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-rose-600' : 'text-[#141414]/40')}>
          {hint}
        </div>
      )}
    </div>
  );
}

function ListBlock({ icon, title, items }: { icon: React.ReactNode; title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[9px] uppercase font-bold tracking-widest text-[#141414]/50">
        {icon} {title}
      </div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="text-xs text-[#141414]/75 leading-snug pl-5 relative">
            <span className="absolute left-1.5 top-[7px] w-1 h-1 rounded-full bg-[#141414]/30" />
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}
