/**
 * Guias de decisão dos cards da "Leitura quant do ativo".
 * Abrem ao passar o mouse (ou focar/tocar) no título de cada card e destacam
 * a linha que vale para o ativo aberto.
 */
import React, { useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { cn } from '../utils';

// ---------------------------------------------------------------------------
// Leitura atual (calculada no QuantStrip e repassada aos guias)
// ---------------------------------------------------------------------------
export interface GuideCtx {
  pAlta: number | null;          // P(regime de alta), 0–100
  razaoPrev: number | null;      // IV ATM / vol prevista
  razaoRv30: number | null;      // IV ATM / realizada 30d
  evento: boolean;               // realizada 30d inflada por um dia
  probAlta: number | null;       // Monte Carlo, 0–100
  mcLargura: number | null;      // meia-largura da faixa 90% do MC, %
  ivLargura: number | null;      // meia-largura da faixa 90% pela IV, %
  ivP5: number | null;
  ivP95: number | null;
  mcP5: number | null;
  mcP95: number | null;
  spotPos: number | null;        // posição do spot na faixa do MC, 0–100
}

const pct = (v: number | null | undefined, d = 0) =>
  v == null ? '—' : `${v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
const num = (v: number | null | undefined, d = 2) =>
  v == null ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });

// ---------------------------------------------------------------------------
// Popover acessível: hover, foco do teclado e toque
// ---------------------------------------------------------------------------
export function GuideTip({
  label,
  title,
  align = 'left',
  className,
  children,
}: {
  label: React.ReactNode;
  title: string;
  align?: 'left' | 'right';
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const openedAt = useRef(0);
  const id = useId();
  // No toque, foco/hover e clique chegam juntos: o clique logo após abrir não fecha
  const show = () => {
    openedAt.current = Date.now();
    setOpen(true);
  };
  return (
    <span
      className={cn('relative inline-flex', className)}
      // Só mouse de verdade abre/fecha por hover; no toque, quem decide é o clique
      onPointerEnter={(e) => e.pointerType === 'mouse' && show()}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setOpen(false)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => (Date.now() - openedAt.current < 500 ? setOpen(true) : setOpen((o) => !o))}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        className="inline-flex items-center gap-1 cursor-help text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
      >
        {label}
        <Info className="w-3 h-3 opacity-60 shrink-0" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          role="tooltip"
          className={cn(
            'absolute top-full mt-2 z-50 w-[min(92vw,36rem)] max-h-[70vh] overflow-y-auto',
            // celular: centralizado na tela, sem vazar pelas bordas
            'max-sm:fixed max-sm:inset-x-3 max-sm:top-16 max-sm:mt-0 max-sm:w-auto max-sm:max-h-[80vh]',
            'bg-white border border-[#141414]/10 rounded-xl shadow-xl p-4 text-left normal-case tracking-normal font-normal',
            align === 'right' ? 'sm:right-0' : 'sm:left-0'
          )}
        >
          <p className="text-sm font-bold text-[#141414] mb-2">{title}</p>
          <div className="space-y-3 text-xs text-[#3f3f3f] leading-relaxed">{children}</div>
          <p className="mt-3 pt-2 border-t border-[#141414]/5 text-[10px] text-[#5c5c5c]">
            Guia de leitura educativo, não é recomendação de investimento.
          </p>
        </div>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Blocos de conteúdo
// ---------------------------------------------------------------------------
function Purpose({ children }: { children: React.ReactNode }) {
  return (
    <p className="bg-blue-50/70 text-blue-900 rounded-lg px-3 py-2">
      <strong>Para que serve:</strong> {children}
    </p>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return <p className="font-bold text-[#141414] text-[11px] uppercase tracking-wider">{children}</p>;
}

type Row = { cells: React.ReactNode[]; active?: boolean };

function Table({ head, rows }: { head: string[]; rows: Row[] }) {
  return (
    <table className="w-full border-collapse text-[11px]">
      <thead>
        <tr className="text-[#5c5c5c]">
          {head.map((h) => (
            <th key={h} className="text-left font-semibold py-1 pr-2 border-b border-[#141414]/10 align-bottom">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={cn('align-top', r.active && 'bg-amber-50')}>
            {r.cells.map((c, j) => (
              <td key={j} className={cn('py-1.5 pr-2 border-b border-[#141414]/5', j === 0 && 'font-semibold whitespace-nowrap')}>
                {c}
                {r.active && j === 0 && (
                  <span className="ml-1 text-[9px] font-bold uppercase text-amber-800 bg-amber-100 rounded px-1">agora</span>
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Now({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[11px] bg-[#F7F7F6] rounded-lg px-3 py-2 text-[#141414]">{children}</p>;
}

const inRange = (v: number | null, lo: number, hi: number) => v != null && v >= lo && v < hi;

// ---------------------------------------------------------------------------
// Card 1 — Regime bayesiano
// ---------------------------------------------------------------------------
export function RegimeGuide({ ctx }: { ctx: GuideCtx }) {
  const p = ctx.pAlta;
  return (
    <>
      <Purpose>definir o viés direcional e o tamanho da exposição. Não serve para cronometrar a entrada.</Purpose>
      <Now>Agora: P(regime de alta) = {pct(p)}</Now>
      <Table
        head={['P(regime de alta)', 'Leitura', 'O que fazer']}
        rows={[
          { cells: ['≥ 80%', 'Alta bem definida', 'Permitir estruturas com viés de alta. Tamanho de posição normal.'], active: p != null && p >= 80 },
          { cells: ['60–80%', 'Alta, com dúvida', 'Viés de alta com tamanho reduzido e risco definido (travas em vez de posições a seco).'], active: inRange(p, 60, 80) },
          { cells: ['40–60%', 'Indefinido / transição', 'Não tomar viés pelo regime. Estruturas neutras ou ficar de fora.'], active: inRange(p, 40, 60) },
          { cells: ['20–40%', 'Baixa, com dúvida', 'Reduzir posições compradas. Considerar proteção.'], active: inRange(p, 20, 40) },
          { cells: ['≤ 20%', 'Baixa bem definida', 'Evitar viés de alta. Proteger a carteira, ou viés de baixa com risco definido.'], active: p != null && p < 20 },
        ]}
      />
      <H>Mais importante que o nível: a variação</H>
      <Table
        head={['Se…', 'Faça']}
        rows={[
          { cells: ['Caiu de ~100% para < 70% em 1–2 pregões', 'Alerta de troca de regime. Revise as posições que dependem de alta.'] },
          { cells: ['Oscila entre 30% e 70% todo dia', 'O modelo não está discriminando. Ignore o card até estabilizar.'] },
          { cells: ['Está em 100% há muito tempo', 'Tudo certo, mas um único dia de queda forte pode virar a leitura.'] },
        ]}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Card 2 — Volatilidade
// ---------------------------------------------------------------------------
export function VolGuide({ ctx }: { ctx: GuideCtx }) {
  const r = ctx.razaoPrev ?? ctx.razaoRv30;
  return (
    <>
      <Purpose>decidir se você deve ser <strong>comprador ou vendedor</strong> de opções. É o card mais acionável do painel.</Purpose>
      <p>
        Use a <strong>razão</strong> entre a implícita e a volatilidade de referência. Ela é mais comparável entre ativos do
        que a diferença em p.p. O painel usa a <strong>vol prevista</strong> (GARCH), que já desconta choques passados, e
        mostra também a razão contra a realizada de 30 dias.
      </p>
      <Now>
        Agora: IV / prevista = {num(ctx.razaoPrev)} · IV / realizada 30d = {num(ctx.razaoRv30)}
      </Now>
      <Table
        head={['Razão', 'Leitura', 'O que fazer']}
        rows={[
          { cells: ['< 0,8', 'Opções baratas vs. o movimento', 'Favorece comprar opções: travas de débito, compra de call/put, straddle comprado se espera movimento. Evitar vender a seco.'], active: r != null && r < 0.8 },
          { cells: ['0,8 – 1,2', 'Preço justo', 'A vol não dá vantagem. Escolha a estrutura pela direção (card Regime) e pelo custo.'], active: inRange(r, 0.8, 1.2) },
          { cells: ['> 1,2', 'Opções caras', 'Favorece vender prêmio: venda coberta, travas de crédito, iron condor. Sempre com risco definido.'], active: r != null && r >= 1.2 },
        ]}
      />
      <H>Antes de agir, 3 verificações</H>
      <Table
        head={['Verificação', 'Se…', 'Então']}
        rows={[
          {
            cells: [
              'A realizada foi inflada por 1 dia?',
              'A robusta ou a de 10d ficam bem abaixo da de 30d',
              <>O sinal de "barata" contra a realizada é falso: o mercado já precificou o fim da agitação.{ctx.evento && <strong className="text-amber-800"> O painel detectou um evento neste ativo.</strong>}</>,
            ],
            active: ctx.evento,
          },
          { cells: ['Há evento até o vencimento? (balanço, dividendos, Copom)', 'Há', 'A IV tende a subir antes e despencar depois. Ajuste a leitura.'] },
          { cells: ['IV rank (IV atual entre a mínima e a máxima do último ano)', '< 20% reforça "barata"; > 80% reforça "cara"', 'Use como confirmação do sinal da razão.'] },
        ]}
      />
      <p>
        <strong>Liquidez:</strong> se o spread entre compra e venda da opção ATM passar de ~5% do preço dela, a IV exibida
        não é confiável.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Card 3 — Monte Carlo
// ---------------------------------------------------------------------------
export function MonteCarloGuide({ ctx }: { ctx: GuideCtx }) {
  const p = ctx.probAlta;
  const conflito = ctx.pAlta != null && ctx.pAlta >= 80 && p != null && p < 40;
  return (
    <>
      <Purpose>
        testar se há vantagem direcional no prazo e, principalmente, comparar a probabilidade do modelo com a embutida no
        preço da opção.
      </Purpose>
      <H>Uso 1 · P(alta)</H>
      <p>O erro do próprio modelo é de pelo menos ±1–2 p.p.; a incerteza real é maior.</p>
      <Now>Agora: P(alta) = {pct(p)}</Now>
      <Table
        head={['P(alta)', 'Leitura', 'O que fazer']}
        rows={[
          { cells: ['45 – 55%', 'Sem vantagem direcional', 'Não opere direção por este card. Decida pela volatilidade.'], active: p != null && p >= 45 && p <= 55 },
          { cells: ['55 – 65% (ou 35 – 45%)', 'Viés leve', 'Pode confirmar o regime, mas não justifica posição sozinho.'], active: p != null && ((p > 55 && p <= 65) || (p >= 35 && p < 45)) },
          { cells: ['> 65% (ou < 35%)', 'Viés forte', 'Desconfie primeiro: em poucos pregões isso exige drift enorme. Verifique se o μ não está inflado.'], active: p != null && (p > 65 || p < 35) },
        ]}
      />
      <H>Uso 2 · Comparar com o preço da opção (o mais valioso)</H>
      <p>
        Para um strike K, compare <strong>P_modelo</strong> (coluna <em>P(exerc.)</em> da tabela) com <strong>P_mercado</strong>
        {' '}(aproximação: o <em>Δ</em> da opção; Δ 0,20 ≈ 20% de terminar no dinheiro).
      </p>
      <Table
        head={['Se…', 'Leitura', 'Estrutura favorecida']}
        rows={[
          { cells: ['P_modelo > P_mercado (ex.: 30% vs Δ 0,15)', 'Opção barata pelo modelo', 'Comprar a opção / trava comprada nesse strike'] },
          { cells: ['P_modelo < P_mercado (ex.: 5% vs Δ 0,15)', 'Opção cara pelo modelo', 'Vender a opção, com risco definido'] },
          { cells: ['Diferença < 5 p.p.', 'Sem vantagem', 'Nada a fazer nesse strike'] },
        ]}
      />
      <Table
        head={['Sinal de alerta', 'Faça']}
        rows={[{ cells: ['Regime "Alta" ≥ 80% e P(alta) < 40%', 'Modelos em conflito. Investigue o drift antes de usar qualquer um dos dois.'], active: conflito }]}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Card 4 — Faixa de preço
// ---------------------------------------------------------------------------
export function FaixaGuide({ ctx }: { ctx: GuideCtx }) {
  const mcMaisLarga = ctx.mcLargura != null && ctx.ivLargura != null ? ctx.mcLargura > ctx.ivLargura : null;
  const pos = ctx.spotPos;
  const centro = pos != null && pos >= 35 && pos <= 65;
  return (
    <>
      <Purpose>escolher strikes, stops e alvos.</Purpose>
      <Now>
        Agora: faixa 90% do Monte Carlo R$ {num(ctx.mcP5)} – R$ {num(ctx.mcP95)} (±{pct(ctx.mcLargura, 1)}) · pela IV
        R$ {num(ctx.ivP5)} – R$ {num(ctx.ivP95)} (±{pct(ctx.ivLargura, 1)})
      </Now>
      <H>Uso 1 · Escolha de strikes</H>
      <Table
        head={['Se você vai…', 'Regra prática']}
        rows={[
          { cells: ['Vender opção (crédito, iron condor)', <>Strike fora da faixa de 90%: put vendida abaixo de R$ {num(ctx.mcP5)} e call vendida acima de R$ {num(ctx.mcP95)}. Pelo modelo, ~5% de chance de cada lado.</>] },
          { cells: ['Comprar opção para direção', 'Strike dentro da faixa. Fora dela exige um movimento que o modelo considera de cauda.'] },
          { cells: ['Montar trava', 'Ponta comprada perto do spot, ponta vendida perto da borda da faixa.'] },
        ]}
      />
      <H>Uso 2 · Stops e alvos</H>
      <Table
        head={['Se…', 'Então']}
        rows={[
          { cells: ['O stop está dentro da faixa', 'Pode ser atingido por ruído normal. Alargue o stop ou reduza o tamanho.'] },
          { cells: ['O alvo está fora da faixa', 'Improvável no prazo. Reveja o alvo ou o prazo.'] },
        ]}
      />
      <H>Uso 3 · Faixa do Monte Carlo vs faixa da IV</H>
      <p className="font-mono text-[11px]">faixa IV = spot × e^(±1,645 × IV × √(pregões/252))</p>
      <Table
        head={['Se…', 'Leitura']}
        rows={[
          { cells: ['Faixa do MC mais larga', 'O modelo espera mais movimento do que as opções cobram. Confirma "comprar vol".'], active: mcMaisLarga === true },
          { cells: ['Faixa do MC mais estreita', 'Confirma "vender vol".'], active: mcMaisLarga === false },
        ]}
      />
      <H>Uso 4 · Posição do spot na barra</H>
      <Table
        head={['Spot', 'Leitura']}
        rows={[
          { cells: ['No meio', 'Distribuição simétrica, sem drift relevante.'], active: pos != null && centro },
          { cells: ['Deslocado para uma borda', 'O modelo tem drift forte. Confira se faz sentido (alerta do card Monte Carlo).'], active: pos != null && !centro },
        ]}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Matriz Regime × Volatilidade (título da faixa)
// ---------------------------------------------------------------------------
export function MatrizGuide({ ctx }: { ctx: GuideCtx }) {
  const p = ctx.pAlta;
  const r = ctx.razaoPrev ?? ctx.razaoRv30;
  const lin = p == null ? -1 : p >= 80 ? 0 : p > 20 ? 1 : 2;
  const col = r == null ? -1 : r < 0.8 ? 0 : r <= 1.2 ? 1 : 2;
  const linhas = ['Regime alta (≥ 80%)', 'Indefinido (entre)', 'Regime baixa (≤ 20%)'];
  const celulas = [
    ['Compra de call, trava de alta com calls (débito)', 'Trava de alta (débito ou crédito)', 'Venda de put coberta por caixa, trava de alta com puts (crédito), venda coberta'],
    ['Straddle ou strangle comprado (movimento, sem direção)', 'Ficar de fora', 'Iron condor, strangle vendido com asas (risco definido)'],
    ['Compra de put, trava de baixa com puts (débito), proteção barata', 'Trava de baixa', 'Trava de baixa com calls (crédito), reduzir exposição comprada'],
  ];
  return (
    <>
      <Purpose>
        combinar os cards. O <strong>Regime</strong> dá a direção; a <strong>Volatilidade</strong> diz se você compra ou
        vende opção. O cruzamento indica a família de estruturas.
      </Purpose>
      <Now>
        Agora: P(regime de alta) {pct(p)} · razão IV/prevista {num(ctx.razaoPrev)}
      </Now>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="text-[#5c5c5c]">
            <th className="py-1 pr-2 border-b border-[#141414]/10" />
            {['Vol barata (< 0,8)', 'Vol justa (0,8–1,2)', 'Vol cara (> 1,2)'].map((h) => (
              <th key={h} className="text-left font-semibold py-1 pr-2 border-b border-[#141414]/10">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {linhas.map((l, i) => (
            <tr key={l} className="align-top">
              <td className="font-semibold py-1.5 pr-2 border-b border-[#141414]/5">{l}</td>
              {celulas[i].map((c, j) => (
                <td
                  key={j}
                  className={cn(
                    'py-1.5 pr-2 border-b border-[#141414]/5',
                    i === lin && j === col && 'bg-amber-50 outline outline-1 outline-amber-300 rounded'
                  )}
                >
                  {c}
                  {i === lin && j === col && (
                    <span className="ml-1 text-[9px] font-bold uppercase text-amber-800 bg-amber-100 rounded px-1">agora</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Depois: o <strong>Monte Carlo</strong> escolhe o strike com a melhor relação entre P_modelo e P_mercado, e a{' '}
        <strong>Faixa</strong> posiciona strikes, stop e alvo.
      </p>
    </>
  );
}
