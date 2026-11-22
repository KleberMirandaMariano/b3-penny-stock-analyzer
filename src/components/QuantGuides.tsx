/**
 * Guias de decisão dos cards da "Leitura quant do ativo".
 * Abrem ao passar o mouse (ou focar/tocar) no título de cada card e destacam
 * a linha que vale para o ativo aberto.
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
// Popover acessível: hover, foco do teclado e toque.
// Renderizado num portal (position: fixed) para não ser cortado por caixas
// com rolagem, como as tabelas de opções.
// ---------------------------------------------------------------------------
const GAP = 8;
const EDGE = 12;

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
  const [pos, setPos] = useState<React.CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const show = () => {
    cancelClose();
    openedAt.current = Date.now();
    setOpen(true);
  };
  // Pequeno atraso: dá tempo de levar o mouse do título até o guia
  const hideSoon = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };

  // Posição: abaixo do título (ou acima, se faltar espaço), sempre dentro da tela
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const btn = btnRef.current?.getBoundingClientRect();
      const tip = tipRef.current;
      if (!btn || !tip) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(vw - 2 * EDGE, 576);
      let left = align === 'right' ? btn.right - w : btn.left;
      left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
      const below = vh - btn.bottom - GAP - EDGE;
      const above = btn.top - GAP - EDGE;
      const h = tip.scrollHeight;
      const placeBelow = below >= Math.min(h, 320) || below >= above;
      const maxH = Math.max(160, placeBelow ? below : above);
      setPos({
        left,
        width: w,
        maxHeight: maxH,
        ...(placeBelow ? { top: btn.bottom + GAP } : { bottom: vh - btn.top + GAP }),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, align]);

  // Fecha ao tocar/clicar fora
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !tipRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  useEffect(() => cancelClose, []);

  return (
    <span className={cn('relative inline-flex', className)}>
      <button
        ref={btnRef}
        type="button"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        // Só mouse de verdade abre/fecha por hover; no toque, quem decide é o clique
        onPointerEnter={(e) => e.pointerType === 'mouse' && show()}
        onPointerLeave={(e) => e.pointerType === 'mouse' && hideSoon()}
        onClick={(e) => {
          e.stopPropagation();
          if (Date.now() - openedAt.current < 500) setOpen(true);
          else setOpen((o) => !o);
        }}
        onFocus={show}
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (next && !tipRef.current?.contains(next)) setOpen(false);
        }}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        className="inline-flex items-center gap-1 cursor-help text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
      >
        {label}
        <Info className="w-3 h-3 opacity-60 shrink-0" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            style={{ position: 'fixed', ...pos }}
            onPointerEnter={(e) => e.pointerType === 'mouse' && cancelClose()}
            onPointerLeave={(e) => e.pointerType === 'mouse' && hideSoon()}
            className="z-[100] overflow-y-auto bg-white border border-[#141414]/10 rounded-xl shadow-xl p-4 text-left normal-case tracking-normal font-normal"
          >
            <p className="text-sm font-bold text-[#141414] mb-2">{title}</p>
            <div className="space-y-3 text-xs text-[#3f3f3f] leading-relaxed">{children}</div>
            <p className="mt-3 pt-2 border-t border-[#141414]/5 text-[10px] text-[#5c5c5c]">
              Guia de leitura educativo, não é recomendação de investimento.
            </p>
          </div>,
          document.body
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

// ---------------------------------------------------------------------------
// Colunas da tabela de opções
// ---------------------------------------------------------------------------
export interface ColCtx {
  ivAtm: number | null;    // IV ATM do vencimento, %
  volPrev: number | null;  // vol prevista até o vencimento, %
  metodo?: string;         // "GARCH(1,1)" / "EWMA"
}

export function ColVIGuide({ ctx }: { ctx: ColCtx }) {
  const ref = ctx.volPrev;
  return (
    <>
      <Purpose>saber quanto de movimento o mercado está cobrando <strong>nesta série</strong>.</Purpose>
      <p>
        É a volatilidade que, no Black-Scholes, reproduz o preço da opção. Usa o preço médio entre compra e venda; sem as
        duas ofertas, usa o último negócio.
      </p>
      <Now>
        Referências deste vencimento: IV ATM {pct(ctx.ivAtm, 1)} · vol prevista {pct(ref, 1)}
      </Now>
      <Table
        head={['VI da série vs vol prevista', 'Leitura', 'Uso']}
        rows={[
          { cells: ['< 0,8 ×', 'Série barata', 'Candidata para a ponta comprada.'] },
          { cells: ['0,8 – 1,2 ×', 'Em linha', 'Sem vantagem de vol nesta série.'] },
          { cells: ['> 1,2 ×', 'Série cara', 'Candidata para a ponta vendida (com risco definido).'] },
        ]}
      />
      <H>Leia com cuidado</H>
      <Table
        head={['Se…', 'Então']}
        rows={[
          { cells: ['VI muito diferente das séries vizinhas', 'Provável preço velho (último negócio) ou spread largo. Confira Compra e Venda.'] },
          { cells: ['Puts fora do dinheiro com VI maior que as calls', 'Normal: é o "smile"/skew, o mercado cobra mais pela proteção.'] },
          { cells: ['"—"', 'Sem preço, ou preço fora dos limites de arbitragem: não dá para calcular.'] },
        ]}
      />
    </>
  );
}

export function ColDeltaGuide() {
  return (
    <>
      <Purpose>medir a exposição direcional da opção e estimar a chance de ela terminar dentro do dinheiro.</Purpose>
      <p>
        Δ = quanto o prêmio varia para R$ 1 de variação no ativo. Calculado com a VI da própria série (ou a vol prevista,
        se não houver VI). Calls têm Δ positivo; puts, negativo.
      </p>
      <Table
        head={['|Δ|', 'Perfil', 'Uso típico']}
        rows={[
          { cells: ['0,05 – 0,25', 'Fora do dinheiro', 'Prêmio baixo, pouca chance. Ponta vendida de travas/condor; compra só como "loteria" controlada.'] },
          { cells: ['0,40 – 0,60', 'No dinheiro', 'Maior sensibilidade a vol e tempo. Ponta comprada de travas direcionais.'] },
          { cells: ['> 0,70', 'Dentro do dinheiro', 'Se comporta quase como a ação. Substitui o papel com menos capital.'] },
        ]}
      />
      <H>Na prática</H>
      <Table
        head={['Para…', 'Use o Δ assim']}
        rows={[
          { cells: ['Estimar P_mercado', '|Δ| ≈ probabilidade de terminar no dinheiro (Δ 0,20 ≈ 20%). Compare com a coluna P(exerc.).'] },
          { cells: ['Hedge', 'Ações para neutralizar = Δ × quantidade de opções.'] },
          { cells: ['Somar posições', 'O Δ total da estrutura diz o seu viés líquido: perto de zero = neutro.'] },
        ]}
      />
    </>
  );
}

export function ColJustoGuide({ ctx }: { ctx: ColCtx }) {
  return (
    <>
      <Purpose>ter um preço de referência do modelo para comparar com o que o mercado pede.</Purpose>
      <p>
        Binomial americano (permite exercício antecipado) com a <strong>vol prevista</strong> até o vencimento, a Selic e
        o spot do último pregão.
      </p>
      <Now>
        Vol usada neste vencimento: {pct(ctx.volPrev, 1)} {ctx.metodo ? `(${ctx.metodo})` : ''}
      </Now>
      <Table
        head={['Se você vai…', 'Compare o Justo com']}
        rows={[
          { cells: ['Comprar', 'A coluna Compra (o preço que você paga). Justo acima dela = a favor.'] },
          { cells: ['Vender', 'A coluna Venda (o preço que você recebe). Justo abaixo dela = a favor.'] },
          { cells: ['Sem ofertas', 'O Último, com cautela: pode ser um negócio antigo.'] },
        ]}
      />
      <H>Limites do modelo</H>
      <Table
        head={['Atenção', 'Efeito']}
        rows={[
          { cells: ['É um modelo, não o preço "certo"', 'Muda junto com a vol prevista. Use para comparar, não como alvo.'] },
          { cells: ['Dividendos até o vencimento não entram', 'O justo da call fica alto e o da put fica baixo perto de uma data-com.'] },
          { cells: ['Vol única para todos os strikes', 'Não captura o smile: puts muito fora do dinheiro tendem a parecer "caras".'] },
        ]}
      />
    </>
  );
}

export function ColEdgeGuide() {
  return (
    <>
      <Purpose>apontar as séries em que o mercado está mais longe do preço do modelo.</Purpose>
      <p className="font-mono text-[11px]">Mercado × justo = preço médio (ou último) ÷ justo − 1</p>
      <Table
        head={['Valor (referência)', 'Leitura', 'Candidata a']}
        rows={[
          { cells: ['< −20% (abaixo)', 'Barata pelo modelo', 'Ponta comprada'] },
          { cells: ['−20% a +20%', 'Perto do justo', 'Sem vantagem relevante'] },
          { cells: ['> +20% (acima)', 'Cara pelo modelo', 'Ponta vendida, com risco definido'] },
        ]}
      />
      <H>Como ler direito</H>
      <Table
        head={['Se…', 'Então']}
        rows={[
          { cells: ['Quase toda a cadeia está "abaixo"', 'É a vol implícita inteira abaixo da prevista: decisão de vol (card Volatilidade), não de strike. Procure as séries que destoam das vizinhas.'] },
          { cells: ['O valor veio do último negócio', 'Pode ser preço velho. Prefira séries com Compra e Venda.'] },
          { cells: ['Spread largo (Compra × Venda)', 'O preço médio não é executável. Calcule com o lado que você vai operar.'] },
          { cells: ['Prêmio muito pequeno (centavos)', 'Percentuais exagerados: um centavo vira dezenas de %.'] },
        ]}
      />
    </>
  );
}

export function ColPExercGuide() {
  return (
    <>
      <Purpose>comparar a probabilidade do modelo com a embutida no preço (o uso mais valioso do Monte Carlo).</Purpose>
      <p>
        Fração das trajetórias do Monte Carlo (vol prevista + deriva bayesiana) que terminam dentro do dinheiro: acima do
        strike para calls, abaixo para puts.
      </p>
      <Table
        head={['Compare com |Δ| (P_mercado)', 'Leitura', 'Estrutura favorecida']}
        rows={[
          { cells: ['P(exerc.) > |Δ| + 5 p.p.', 'Barata pelo modelo', 'Comprar / trava comprada nesse strike'] },
          { cells: ['P(exerc.) < |Δ| − 5 p.p.', 'Cara pelo modelo', 'Vender, com risco definido'] },
          { cells: ['Diferença < 5 p.p.', 'Sem vantagem', 'Nada a fazer nesse strike'] },
        ]}
      />
      <H>Atenção</H>
      <Table
        head={['Se…', 'Então']}
        rows={[
          { cells: ['Calls todas acima e puts todas abaixo do Δ (ou o contrário)', 'É a deriva do modelo puxando para um lado. Confira o card Monte Carlo antes de confiar.'] },
          { cells: ['Vencimento muito curto', 'Poucas trajetórias cruzam strikes distantes: o número fica instável.'] },
        ]}
      />
    </>
  );
}
