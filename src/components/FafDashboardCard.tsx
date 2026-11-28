import { ArrowUpRight, LayoutDashboard, Radar } from 'lucide-react';

// Dashboard Streamlit do financial-analysis-framework, servido pelo Traefik em
// analisekmm.tech/faf/ atrás do mesmo login Google deste site. O link abre a
// página do Monitor de Mercado; o menu lateral do Streamlit leva às demais.
const FAF_URL = import.meta.env.VITE_FAF_URL || '/faf/Monitor_de_Mercado';

const LISTAS = ['Índices e macro', 'ETFs da carteira', 'B3 abaixo de R$ 10', 'Destaques B3', 'Destaques EUA', 'Metais'];
const PAGINAS = ['Opções', 'Backtesting', 'Previsões', 'Walk-Forward', 'Screening', 'On-Chain'];

export function FafDashboardCard() {
  return (
    <a
      href={FAF_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex flex-col h-full bg-white p-4 md:p-6 rounded-2xl border border-[#141414]/5 shadow-sm hover:border-[#141414]/20 transition-all"
    >
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="font-semibold text-lg">Financial Analysis Framework</h3>
          <p className="text-xs text-[#141414]/40">Dashboard quant com cotações atualizadas</p>
        </div>
        <LayoutDashboard className="w-4 h-4 text-[#141414]/40" />
      </div>

      <div className="flex-1 min-h-[250px] w-full flex flex-col justify-between gap-4">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-[#F5F5F4] rounded-xl group-hover:bg-[#141414] group-hover:text-white transition-colors">
              <Radar className="w-5 h-5" />
            </div>
            <div>
              <p className="font-bold">Monitor de Mercado</p>
              <p className="text-xs text-[#141414]/50">Atualizado a cada 15 min durante o pregão</p>
            </div>
          </div>

          <div>
            <p className="text-[10px] uppercase font-bold tracking-widest text-[#141414]/40 mb-2">Watchlists</p>
            <div className="flex flex-wrap gap-1.5">
              {LISTAS.map((l) => (
                <span key={l} className="text-[11px] px-2 py-1 rounded-full bg-[#F5F5F4] text-[#141414]/70">{l}</span>
              ))}
            </div>
          </div>

          <div className="hidden md:block">
            <p className="text-[10px] uppercase font-bold tracking-widest text-[#141414]/40 mb-2">Outras páginas</p>
            <div className="flex flex-wrap gap-1.5">
              {PAGINAS.map((p) => (
                <span key={p} className="text-[11px] px-2 py-1 rounded-full border border-[#141414]/10 text-[#141414]/60">{p}</span>
              ))}
            </div>
          </div>
        </div>

        <span className="inline-flex items-center justify-center gap-2 w-full rounded-full bg-[#141414] text-white font-semibold py-3 group-hover:bg-[#141414]/85 transition-colors">
          Abrir dashboard
          <ArrowUpRight className="w-4 h-4" />
        </span>
      </div>
    </a>
  );
}
