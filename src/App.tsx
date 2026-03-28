import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getStocks, getOptions, getOptionsLive, analyzeOption, triggerUpdate, getUpdateStatus, type StocksResponse, type LiveOptionData } from './services/stockService';
import { cn, type StockData, type OptionData } from './utils';
import {
  TrendingUp,
  TrendingDown,
  BarChart3,
  PieChart as PieChartIcon,
  Search,
  ArrowUpDown,
  Activity,
  DollarSign,
  Layers,
  RefreshCw,
  Wifi,
  WifiOff,
  AlertTriangle,
  ChevronLeft,
  X,
  Calendar,
  Target,
  Percent,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];

// Tickers fixos exibidos sempre na tela inicial (em ordem)
const FIXED_TICKERS = [
  'RAIZ4', 'QUAL3', 'CVCB3', 'PCAR3', 'COGN3', 'LWSA3', 'VAMO3', 'ANIM3', 'BEEF3', 'BMGB4',
  'CMIN3', 'GMAT3', 'CSAN3', 'POMO4', 'USIM5', 'PETR4', 'VALE3', 'ITUB4', 'BBAS3', 'BBDC4',
];

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const [response, setResponse] = useState<StocksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [sortConfig, setSortConfig] = useState<{ key: keyof StockData; direction: 'asc' | 'desc' } | null>(
    { key: 'var1a', direction: 'desc' }
  );
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [expandedTickers, setExpandedTickers] = useState<Set<string>>(new Set());
  const [optionsCache, setOptionsCache] = useState<Record<string, OptionData[]>>({});
  const [loadingOptions, setLoadingOptions] = useState<string | null>(null);
  const [showStocksList, setShowStocksList] = useState(false);

  const toggleExpand = async (ticker: string) => {
    const isExpanded = expandedTickers.has(ticker);

    setExpandedTickers((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });

    // Busca opções ao expandir (se ainda não tem no cache)
    if (!isExpanded && !optionsCache[ticker]) {
      setLoadingOptions(ticker);
      const opcoes = await getOptions(ticker);
      setOptionsCache((prev) => ({ ...prev, [ticker]: opcoes }));
      setLoadingOptions(null);
    }
  };

  // ---- carregamento inicial ------------------------------------------------
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Avisa após 5s que o servidor pode estar iniciando (cold start Render)
    const wakeupTimer = setTimeout(() => {
      setError('Servidor iniciando, aguarde...');
    }, 5000);
    try {
      const res = await getStocks();
      clearTimeout(wakeupTimer);
      setError(null);
      setResponse(res);
      
      const newCache: Record<string, OptionData[]> = {};
      res.stocks.forEach(s => {
        if (s.opcoes && s.opcoes.length > 0) {
          newCache[s.ticker] = s.opcoes;
        }
      });
      setOptionsCache(prev => ({ ...prev, ...newCache }));

      if (!selectedTicker) {
        const first = FIXED_TICKERS.find(t => res.stocks.some(s => s.ticker === t));
        if (first) setSelectedTicker(first);
      }
    } catch (err: any) {
      clearTimeout(wakeupTimer);
      setError(err?.message ?? 'Erro desconhecido ao carregar dados.');
    } finally {
      setLoading(false);
    }
  }, [selectedTicker]);

  useEffect(() => { loadData(); }, []);

  // ---- atualização via API -------------------------------------------------
  const handleRefresh = async () => {
    if (refreshing) return;
    
    const targetTicker = searchTerm.trim() ? searchTerm.trim().toUpperCase() : undefined;
    
    setRefreshing(true);
    setUpdateMsg(targetTicker ? `Pesquisando ${targetTicker}...` : 'Solicitando pesquisa geral...');
    const { ok, mensagem } = await triggerUpdate(targetTicker);
    setUpdateMsg(ok ? '✓ Atualização iniciada — aguardando conclusão...' : `Erro: ${mensagem}`);

    if (ok) {
      // Poll /api/status a cada 3s até updateInProgress=false (máx 90s)
      const maxWait = 90_000;
      const interval = 3_000;
      const start = Date.now();

      const poll = async () => {
        const { updateInProgress } = await getUpdateStatus();
        if (!updateInProgress || Date.now() - start >= maxWait) {
          await loadData();
          if (targetTicker) {
            setSelectedTicker(targetTicker);
            if (!expandedTickers.has(targetTicker)) {
              setExpandedTickers(prev => new Set(prev).add(targetTicker));
            }
          }
          setRefreshing(false);
          setUpdateMsg(null);
        } else {
          setTimeout(poll, interval);
        }
      };

      setTimeout(poll, interval);
    } else {
      setRefreshing(false);
      setTimeout(() => setUpdateMsg(null), 4000);
    }
  };

  const allStocks = response?.stocks ?? [];
  const isLive = response?.isLive ?? false;
  const fonte = response?.fonte ?? '';
  const lastUpdate = response?.lastUpdate ?? allStocks[0]?.ultimaAtualizacao ?? '';

  // Mantém apenas os tickers fixos, na ordem definida
  const displayStocks = useMemo(() =>
    FIXED_TICKERS
      .map(t => allStocks.find(s => s.ticker === t))
      .filter((s): s is StockData => s !== undefined),
    [allStocks]
  );

  const isSearching = searchTerm.trim().length > 0;

  // ---- filtro + ordenação --------------------------------------------------
  const filteredStocks = useMemo(() => {
    const source = isSearching ? allStocks : displayStocks;
    let stocks = source.filter(
      (s) =>
        s.ticker.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.empresa.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.setor.toLowerCase().includes(searchTerm.toLowerCase())
    );

    if (sortConfig) {
      stocks = [...stocks].sort((a, b) => {
        const aVal = a[sortConfig.key];
        const bVal = b[sortConfig.key];
        if (aVal === null) return 1;
        if (bVal === null) return -1;
        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return stocks;
  }, [allStocks, displayStocks, isSearching, searchTerm, sortConfig]);

  // ---- estatísticas --------------------------------------------------------
  const stats = useMemo(() => {
    if (displayStocks.length === 0)
      return { avgPrice: 0, topGainer: null, topLoser: null, pieData: [] };

    const avgPrice = displayStocks.reduce((a, s) => a + s.preco, 0) / displayStocks.length;
    const topGainer = [...displayStocks].sort((a, b) => (b.varDia ?? -999) - (a.varDia ?? -999))[0];
    const topLoser = [...displayStocks].sort((a, b) => (a.varDia ?? 999) - (b.varDia ?? 999))[0];

    const sectorMap = displayStocks.reduce<Record<string, number>>((acc, s) => {
      acc[s.setor] = (acc[s.setor] || 0) + 1;
      return acc;
    }, {});
    const pieData = Object.entries(sectorMap).map(([name, value]) => ({ name, value }));

    return { avgPrice, topGainer, topLoser, pieData };
  }, [displayStocks]);

  const handleSort = (key: keyof StockData) => {
    setSortConfig((prev) =>
      prev?.key === key && prev.direction === 'asc'
        ? { key, direction: 'desc' }
        : { key, direction: 'asc' }
    );
  };

  // ---- estados de carregamento / erro --------------------------------------
  if (loading) {
    return (
      <div className="min-h-screen bg-[#F5F5F4] flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="w-10 h-10 border-2 border-[#141414] border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-[#141414]/60 font-mono">Carregando dados da B3...</p>
        </div>
      </div>
    );
  }

  if (error && allStocks.length === 0) {
    return (
      <div className="min-h-screen bg-[#F5F5F4] flex items-center justify-center p-8">
        <div className="bg-white rounded-2xl border border-rose-200 p-8 max-w-md text-center space-y-4">
          <AlertTriangle className="w-10 h-10 text-rose-500 mx-auto" />
          <h2 className="font-bold text-lg">Erro ao carregar dados</h2>
          <p className="text-sm text-[#141414]/60">{error}</p>
          <button
            onClick={loadData}
            className="px-6 py-2 bg-[#141414] text-white rounded-full text-sm hover:bg-[#141414]/80 transition-colors"
          >
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }


  // ---- página: lista de ativos ---------------------------------------------
  if (showStocksList) {
    return (
      <div className="min-h-screen bg-[#F5F5F4] text-[#141414] font-sans">
        <div className="bg-white border-b border-[#141414]/10 px-6 py-4 flex items-center gap-4 sticky top-0 z-10">
          <button
            onClick={() => setShowStocksList(false)}
            className="p-2 rounded-full hover:bg-[#F5F5F4] transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="font-bold text-lg">Carteira Monitorada</h2>
            <p className="text-xs text-[#141414]/40">{displayStocks.length} ativos</p>
          </div>
        </div>
        <div className="max-w-2xl mx-auto p-6 space-y-2">
          {displayStocks.map((stock, idx) => (
            <motion.div
              key={stock.ticker}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.03 }}
              className="bg-white rounded-2xl border border-[#141414]/5 px-5 py-4 flex items-center justify-between hover:border-[#141414]/20 transition-all cursor-pointer"
              onClick={() => { setShowStocksList(false); setSelectedTicker(stock.ticker); }}
            >
              <div className="flex items-center gap-4">
                <span className="text-[10px] font-bold text-[#141414]/30 w-5 text-right">{idx + 1}</span>
                <div>
                  <p className="font-mono font-bold text-sm">{stock.ticker}</p>
                  <p className="text-xs text-[#141414]/50 truncate max-w-[200px]">{stock.empresa}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="font-mono font-bold text-sm">R$ {stock.preco.toFixed(2)}</p>
                <p className={cn("text-xs font-mono", varClass(stock.varDia))}>
                  {fmtPct(stock.varDia)}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    );
  }

  // ---- render principal ----------------------------------------------------
  return (
    <div className="min-h-screen bg-[#F5F5F4] text-[#141414] font-sans p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-8">

        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-[#141414]/10 pb-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Stock Radar BR</h1>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {/* Badge de fonte */}
            <div className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider",
              isLive
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-amber-50 text-amber-700 border border-amber-200"
            )}>
              {isLive ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              {isLive ? 'Dados ao Vivo' : 'Cache Estático'}
            </div>

            {/* Busca */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#141414]/40" />
              <input
                type="text"
                placeholder="Buscar qualquer ativo..."
                className="pl-10 pr-8 py-2 bg-white border border-[#141414]/10 rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-[#141414]/10 w-full md:w-64 transition-all"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
              {isSearching && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#141414]/30 hover:text-[#141414]/60"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Botão de pesquisar */}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              title={searchTerm.trim() ? `Pesquisar e atualizar dados de ${searchTerm.toUpperCase()}` : "Pesquisar e atualizar todos os dados"}
              className={cn(
                "flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold transition-all border",
                refreshing
                  ? "bg-[#141414] text-white/50 border-[#141414] cursor-not-allowed shadow-none"
                  : "bg-[#141414] text-white border-[#141414] hover:bg-[#141414]/90 shadow-md hover:shadow-lg hover:-translate-y-0.5"
              )}
            >
              <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
              {refreshing ? 'Pesquisando...' : 'Pesquisar'}
            </button>

            {/* Última atualização */}
            <div className="hidden lg:block text-right">
              <p className="text-[10px] uppercase font-bold text-[#141414]/40">Última Atualização</p>
              <p className="text-xs font-mono">{lastUpdate}</p>
            </div>
          </div>
        </header>

        {/* Mensagem de status da atualização */}
        <AnimatePresence>
          {updateMsg && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-700"
            >
              {updateMsg}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Vista de busca: só tabela */}
        {isSearching ? (
          <div className="bg-white rounded-2xl border border-[#141414]/5 shadow-sm overflow-hidden">
            <div className="p-6 border-b border-[#141414]/5 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-lg">Resultados para "{searchTerm}"</h3>
                <p className="text-xs text-[#141414]/40 mt-0.5">{filteredStocks.length} ativo{filteredStocks.length !== 1 ? 's' : ''} encontrado{filteredStocks.length !== 1 ? 's' : ''}</p>
              </div>
              <Activity className="w-4 h-4 text-[#141414]/40" />
            </div>
            <StocksTable
              stocks={filteredStocks}
              selectedTicker={selectedTicker}
              expandedTickers={expandedTickers}
              optionsCache={optionsCache}
              loadingOptions={loadingOptions}
              onSort={handleSort}
              onRowClick={(ticker) => { setSelectedTicker(ticker); toggleExpand(ticker); }}
            />
          </div>
        ) : (
          <>
            {/* Stats Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                label="Total de Ativos"
                value={displayStocks.length}
                icon={<Layers className="w-4 h-4" />}
                onIconClick={() => setShowStocksList(true)}
              />
              <StatCard label="Preço Médio" value={`R$ ${stats.avgPrice.toFixed(2)}`} icon={<DollarSign className="w-4 h-4" />} />
              <StatCard
                label="Maior Alta (Dia)"
                value={stats.topGainer?.ticker ?? '-'}
                subValue={stats.topGainer?.varDia != null ? `${stats.topGainer.varDia.toFixed(2)}%` : undefined}
                icon={<TrendingUp className="w-4 h-4 text-emerald-500" />}
              />
              <StatCard
                label="Maior Baixa (Dia)"
                value={stats.topLoser?.ticker ?? '-'}
                subValue={stats.topLoser?.varDia != null ? `${stats.topLoser.varDia.toFixed(2)}%` : undefined}
                icon={<TrendingDown className="w-4 h-4 text-rose-500" />}
              />
            </div>

        {/* Charts Section */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 space-y-6">

            {/* Comparativo de Preços */}
            <div className="bg-white p-4 md:p-6 rounded-2xl border border-[#141414]/5 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="font-semibold text-lg">Comparativo de Preços</h3>
                  <p className="text-xs text-[#141414]/40">Clique em uma barra para ver o histórico detalhado</p>
                </div>
                <BarChart3 className="w-4 h-4 text-[#141414]/40" />
              </div>
              <div className="h-[250px] md:h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={displayStocks}
                    margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                    onClick={(data) => data && setSelectedTicker(data.activeLabel ?? null)}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#14141410" />
                    <XAxis dataKey="ticker" axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 500 }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10 }} />
                    <Tooltip contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)', fontSize: '12px' }} cursor={{ fill: '#14141405' }} />
                    <Bar dataKey="preco" fill="#141414" radius={[4, 4, 0, 0]} barSize={32} className="cursor-pointer">
                      {displayStocks.map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={entry.ticker === selectedTicker ? '#3b82f6' : '#141414'}
                          fillOpacity={entry.ticker === selectedTicker ? 1 : 0.8}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Setor */}
          <div className="bg-white p-4 md:p-6 rounded-2xl border border-[#141414]/5 shadow-sm h-fit">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-semibold text-lg">Setores</h3>
              <PieChartIcon className="w-4 h-4 text-[#141414]/40" />
            </div>
            <div className="h-[250px] md:h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={stats.pieData} cx="50%" cy="45%" innerRadius="60%" outerRadius="80%" paddingAngle={4} dataKey="value">
                    {stats.pieData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: '12px', fontSize: '12px' }} />
                  <Legend verticalAlign="bottom" align="center" iconType="circle" wrapperStyle={{ fontSize: '10px', paddingTop: '20px' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Tabela */}
        <div className="bg-white rounded-2xl border border-[#141414]/5 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-[#141414]/5 flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-lg">Visão Detalhada</h3>
              <p className="text-xs text-[#141414]/40 mt-0.5">{filteredStocks.length} de {displayStocks.length} ativos</p>
            </div>
            <Activity className="w-4 h-4 text-[#141414]/40" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#F5F5F4]/50 border-b border-[#141414]/5">
                  <TableHead label="Ticker" sortKey="ticker" onSort={handleSort} />
                  <TableHead label="Empresa" sortKey="empresa" onSort={handleSort} />
                  <TableHead label="Preço" sortKey="preco" onSort={handleSort} />
                  <TableHead label="Setor" sortKey="setor" onSort={handleSort} />
                  <TableHead label="Var. Dia" sortKey="varDia" onSort={handleSort} />
                  <TableHead label="Var. Semana" sortKey="varSemana" onSort={handleSort} />
                  <TableHead label="Var. Ano" sortKey="var1a" onSort={handleSort} />
                  <TableHead label="P/L" sortKey="pl" onSort={handleSort} />
                  <TableHead label="P/VP" sortKey="pvp" onSort={handleSort} />
                  <TableHead label="Upside" sortKey="upsideGraham" onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                <AnimatePresence mode="popLayout">
                  {filteredStocks.map((stock) => (
                    <React.Fragment key={stock.ticker}>
                      <motion.tr
                        layout
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={() => {
                          setSelectedTicker(stock.ticker);
                          toggleExpand(stock.ticker);
                        }}
                        className={cn(
                          "border-b border-[#141414]/5 hover:bg-[#F5F5F4]/30 transition-colors cursor-pointer",
                          selectedTicker === stock.ticker && "bg-blue-50/20"
                        )}
                      >
                        <td className="px-6 py-4 font-mono font-bold text-sm">
                          <div className="flex items-center gap-2">
                            <motion.span
                              animate={{ rotate: expandedTickers.has(stock.ticker) ? 180 : 0 }}
                              className="text-[#141414]/20"
                            >
                              ▾
                            </motion.span>
                            {stock.ticker}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-[#141414]/70 truncate max-w-[200px]">{stock.empresa}</td>
                        <td className="px-6 py-4 font-mono text-sm">R$ {stock.preco.toFixed(2)}</td>
                        <td className="px-6 py-4 text-xs uppercase tracking-wider text-[#141414]/50">{stock.setor}</td>
                        <td className={cn("px-6 py-4 font-mono text-sm", varClass(stock.varDia))}>
                          {fmtPct(stock.varDia)}
                        </td>
                        <td className={cn("px-6 py-4 font-mono text-sm", varClass(stock.varSemana))}>
                          {fmtPct(stock.varSemana)}
                        </td>
                        <td className={cn("px-6 py-4 font-mono text-sm", varClass(stock.var1a))}>
                          {fmtPct(stock.var1a)}
                        </td>
                        <td className="px-6 py-4 font-mono text-sm">{stock.pl?.toFixed(2) ?? '-'}</td>
                        <td className="px-6 py-4 font-mono text-sm">{stock.pvp?.toFixed(2) ?? '-'}</td>
                        <td className={cn("px-6 py-4 font-mono text-sm", varClass(stock.upsideGraham))}>
                          {fmtPct(stock.upsideGraham)}
                        </td>
                      </motion.tr>

                      {/* Visão Detalhada de Opções (lazy-loaded) */}
                      <AnimatePresence>
                        {expandedTickers.has(stock.ticker) && (
                          <ExpandedOptionsRow
                            key={`opts-${stock.ticker}`}
                            ticker={stock.ticker}
                            currentPrice={stock.preco}
                            opts={optionsCache[stock.ticker]}
                            isLoading={loadingOptions === stock.ticker || !optionsCache[stock.ticker]}
                          />
                        )}
                      </AnimatePresence>
                    </React.Fragment>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
        </div>
          </>
        )}

                {/* Footer */}
        <footer className="pt-8 pb-12 text-center space-y-2">
          <p className="text-[10px] uppercase tracking-[0.2em] text-[#141414]/40">
            Atualizado em: {lastUpdate || new Date().toLocaleDateString('pt-BR')}
            {fonte && <> · Fonte: {fonte}</>}
          </p>
          <p className="text-[10px] uppercase tracking-[0.2em] text-[#141414]/40">
            Não representa recomendação de investimento. Dados: B3, rb3, Yahoo Finance.
          </p>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers de formatação
// ---------------------------------------------------------------------------
function fmtPct(val: number | null): string {
  if (val == null) return '-';
  return `${val > 0 ? '+' : ''}${val.toFixed(2)}%`;
}

function varClass(val: number | null): string {
  if (val == null) return 'text-[#141414]/40';
  return val > 0 ? 'text-emerald-600' : val < 0 ? 'text-rose-600' : 'text-[#141414]/40';
}

// ---------------------------------------------------------------------------
// StocksTable
// ---------------------------------------------------------------------------
function StocksTable({
  stocks,
  selectedTicker,
  expandedTickers,
  optionsCache,
  loadingOptions,
  onSort,
  onRowClick,
}: {
  stocks: StockData[];
  selectedTicker: string | null;
  expandedTickers: Set<string>;
  optionsCache: Record<string, OptionData[]>;
  loadingOptions: string | null;
  onSort: (key: keyof StockData) => void;
  onRowClick: (ticker: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="bg-[#F5F5F4]/50 border-b border-[#141414]/5">
            <TableHead label="Ticker" sortKey="ticker" onSort={onSort} />
            <TableHead label="Empresa" sortKey="empresa" onSort={onSort} />
            <TableHead label="Preço" sortKey="preco" onSort={onSort} />
            <TableHead label="Setor" sortKey="setor" onSort={onSort} />
            <TableHead label="Var. Dia" sortKey="varDia" onSort={onSort} />
            <TableHead label="Var. Semana" sortKey="varSemana" onSort={onSort} />
            <TableHead label="Var. Ano" sortKey="var1a" onSort={onSort} />
            <TableHead label="P/L" sortKey="pl" onSort={onSort} />
            <TableHead label="P/VP" sortKey="pvp" onSort={onSort} />
            <TableHead label="Upside" sortKey="upsideGraham" onSort={onSort} />
          </tr>
        </thead>
        <tbody>
            {stocks.map((stock) => (
              <React.Fragment key={stock.ticker}>
                <tr
                  onClick={() => onRowClick(stock.ticker)}
                  className={cn(
                    "border-b border-[#141414]/5 hover:bg-[#F5F5F4]/30 transition-colors cursor-pointer",
                    selectedTicker === stock.ticker && "bg-blue-50/20"
                  )}
                >
                  <td className="px-6 py-4 font-mono font-bold text-sm">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "text-[#141414]/20 transition-transform duration-200 inline-block",
                          expandedTickers.has(stock.ticker) && "rotate-180"
                        )}
                      >
                        ▾
                      </span>
                      {stock.ticker}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm text-[#141414]/70 truncate max-w-[200px]">{stock.empresa}</td>
                  <td className="px-6 py-4 font-mono text-sm">R$ {stock.preco.toFixed(2)}</td>
                  <td className="px-6 py-4 text-xs uppercase tracking-wider text-[#141414]/50">{stock.setor}</td>
                  <td className={cn("px-6 py-4 font-mono text-sm", varClass(stock.varDia))}>
                    {fmtPct(stock.varDia)}
                  </td>
                  <td className={cn("px-6 py-4 font-mono text-sm", varClass(stock.varSemana))}>
                    {fmtPct(stock.varSemana)}
                  </td>
                  <td className={cn("px-6 py-4 font-mono text-sm", varClass(stock.var1a))}>
                    {fmtPct(stock.var1a)}
                  </td>
                  <td className="px-6 py-4 font-mono text-sm">{stock.pl?.toFixed(2) ?? '-'}</td>
                  <td className="px-6 py-4 font-mono text-sm">{stock.pvp?.toFixed(2) ?? '-'}</td>
                  <td className={cn("px-6 py-4 font-mono text-sm", varClass(stock.upsideGraham))}>
                    {fmtPct(stock.upsideGraham)}
                  </td>
                </tr>

                {expandedTickers.has(stock.ticker) && (
                  <ExpandedOptionsRow
                    key={`opts-${stock.ticker}`}
                    ticker={stock.ticker}
                    currentPrice={stock.preco}
                    opts={optionsCache[stock.ticker]}
                    isLoading={loadingOptions === stock.ticker || !optionsCache[stock.ticker]}
                  />
                )}
              </React.Fragment>
            ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function StatCard({
  label, value, subValue, icon, onIconClick,
}: {
  label: string; value: string | number; subValue?: string; icon: React.ReactNode; onIconClick?: () => void;
}) {
  return (
    <div className="bg-white p-6 rounded-2xl border border-[#141414]/5 shadow-sm flex flex-col justify-between group hover:border-[#141414]/20 transition-all">
      <div className="flex items-center justify-between mb-4">
        <span className="text-[10px] uppercase font-bold tracking-widest text-[#141414]/40">{label}</span>
        <div
          onClick={onIconClick}
          className={cn(
            "p-2 bg-[#F5F5F4] rounded-lg group-hover:bg-[#141414] group-hover:text-white transition-colors",
            onIconClick && "cursor-pointer"
          )}
        >
          {icon}
        </div>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold">{value}</span>
        {subValue && <span className="text-sm font-mono text-[#141414]/40">{subValue}</span>}
      </div>
    </div>
  );
}

function TableHead({
  label, sortKey, onSort,
}: {
  label: string; sortKey: keyof StockData; onSort: (key: keyof StockData) => void;
}) {
  return (
    <th
      className="px-6 py-4 text-[10px] uppercase font-bold tracking-widest text-[#141414]/40 cursor-pointer hover:text-[#141414] transition-colors"
      onClick={() => onSort(sortKey)}
    >
      <div className="flex items-center gap-2">
        {label}
        <ArrowUpDown className="w-3 h-3 opacity-50" />
      </div>
    </th>
  );
}

// ---------------------------------------------------------------------------
// Black-Scholes Greeks
// ---------------------------------------------------------------------------
function normCDF(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function bsPrice(tipo: 'CALL' | 'PUT', S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0) return tipo === 'CALL' ? Math.max(0, S - K) : Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (tipo === 'CALL') return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

function calcIV(tipo: 'CALL' | 'PUT', S: number, K: number, T: number, r: number, marketPrice: number): number | null {
  if (T <= 0 || marketPrice <= 0 || S <= 0 || K <= 0) return null;
  let low = 0.001, high = 10.0;
  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2;
    const price = bsPrice(tipo, S, K, T, r, mid);
    if (Math.abs(price - marketPrice) < 0.00001) return mid;
    if (price < marketPrice) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

function calcGreeks(tipo: 'CALL' | 'PUT', S: number, K: number, T: number, r: number, sigma: number) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const delta = tipo === 'CALL' ? normCDF(d1) : normCDF(d1) - 1;
  const gamma = normPDF(d1) / (S * sigma * sqrtT);
  const theta = tipo === 'CALL'
    ? (-S * normPDF(d1) * sigma / (2 * sqrtT) - r * K * Math.exp(-r * T) * normCDF(d2)) / 365
    : (-S * normPDF(d1) * sigma / (2 * sqrtT) + r * K * Math.exp(-r * T) * normCDF(-d2)) / 365;
  const vega = S * normPDF(d1) * sqrtT / 100;
  return { delta, gamma, theta, vega };
}

// ---------------------------------------------------------------------------
// Moneyness helpers (alinhado com padrão da main)
// ---------------------------------------------------------------------------
function getMoneyness(strike: number | null, currentPrice: number, tipo: 'CALL' | 'PUT'): 'ITM' | 'ATM' | 'OTM' {
  if (strike === null) return 'OTM';
  const diff = Math.abs(strike - currentPrice) / currentPrice;
  if (diff <= 0.02) return 'ATM';
  if (tipo === 'CALL') return strike < currentPrice ? 'ITM' : 'OTM';
  return strike > currentPrice ? 'ITM' : 'OTM';
}

function MoneynessBadge({ moneyness }: { moneyness: 'ITM' | 'ATM' | 'OTM' }) {
  const styles = {
    ITM: 'bg-emerald-100 text-emerald-700',
    ATM: 'bg-amber-100 text-amber-700',
    OTM: 'bg-[#141414]/5 text-[#141414]/40',
  };
  return (
    <span translate="no" className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${styles[moneyness]}`}>
      {moneyness}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Option Detail Modal
// ---------------------------------------------------------------------------
function OptionDetailModal({
  opt,
  stockPrice,
  stockTicker,
  onClose,
}: {
  opt: OptionData;
  stockPrice: number;
  stockTicker: string;
  onClose: () => void;
}) {
  const status = getMoneyness(opt.strike, stockPrice, opt.tipo);
  const daysToExpiry = opt.vencimento
    ? Math.max(0, Math.ceil((new Date(opt.vencimento + 'T12:00:00Z').getTime() - Date.now()) / 86400000))
    : null;
  const intrinsic = opt.strike != null
    ? Math.max(0, opt.tipo === 'CALL' ? stockPrice - opt.strike : opt.strike - stockPrice)
    : null;
  const timeValue = opt.preco != null && intrinsic != null ? Math.max(0, opt.preco - intrinsic) : null;
  const moneynessPct = opt.strike ? ((stockPrice - opt.strike) / opt.strike) * 100 : null;

  // Dados ao vivo (bid/ask via yfinance)
  const [liveData, setLiveData] = useState<LiveOptionData | null>(null);
  const [liveLoading, setLiveLoading] = useState(true);
  const [liveAviso, setLiveAviso] = useState<string | null>(null);

  useEffect(() => {
    setLiveLoading(true);
    setLiveData(null);
    getOptionsLive(stockTicker).then(({ opcoes, aviso }) => {
      // Tenta casar por strike + tipo + vencimento (yfinance usa formato diferente de ticker)
      const match = opcoes.find(
        (o) => o.tipo === opt.tipo && o.strike === opt.strike && o.vencimento === opt.vencimento
      ) ?? null;
      setLiveData(match);
      setLiveAviso(aviso ?? (opcoes.length === 0 ? 'Dados ao vivo indisponíveis no Yahoo Finance para este ticker.' : null));
      setLiveLoading(false);
    });
  }, [opt.tipo, opt.strike, opt.vencimento, stockTicker]);

  // Análise IA
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Black-Scholes calculations (usa IV do yfinance se disponível, senão calcula)
  const SELIC = 0.1375; // taxa livre de risco Brasil
  const T = daysToExpiry != null ? daysToExpiry / 365 : 0;
  const ivYf = liveData?.impliedVolatility ?? null;
  const ivBs = opt.preco != null && opt.strike != null
    ? calcIV(opt.tipo, stockPrice, opt.strike, T, SELIC, opt.preco)
    : null;
  const iv = ivYf ?? ivBs;
  const greeks = iv != null && opt.strike != null
    ? calcGreeks(opt.tipo, stockPrice, opt.strike, T, SELIC, iv)
    : null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px]" onClick={onClose} />
      <motion.div
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 220 }}
        className="fixed top-0 right-0 z-50 w-full max-w-sm h-full bg-white shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-[#141414]/5 p-5 flex items-start justify-between">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2.5">
              <span className="font-mono font-bold text-xl tracking-tight">{opt.ticker}</span>
              <MoneynessBadge moneyness={status} />
            </div>
            <div className="flex items-center gap-2">
              {opt.tipo === 'CALL' ? (
                <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
              ) : (
                <TrendingDown className="w-3.5 h-3.5 text-rose-500" />
              )}
              <span className={`text-xs font-semibold ${opt.tipo === 'CALL' ? 'text-emerald-600' : 'text-rose-600'}`}>
                Opção {opt.tipo} · {opt.tipo === 'CALL' ? 'Direito de Compra' : 'Direito de Venda'}
              </span>
              <span className="text-[10px] text-[#141414]/30 font-mono">({stockTicker})</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[#F5F5F4] transition-colors text-[#141414]/40 hover:text-[#141414]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Key metrics */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[#FBFBFA] rounded-xl p-4 border border-[#141414]/5">
              <div className="text-[9px] uppercase font-bold text-[#141414]/40 tracking-widest mb-1.5 flex items-center gap-1">
                <DollarSign className="w-3 h-3" /> Prêmio
              </div>
              <div className={`font-mono font-bold text-2xl ${opt.tipo === 'CALL' ? 'text-emerald-600' : 'text-rose-600'}`}>
                R$ {opt.preco?.toFixed(2) ?? '-'}
              </div>
            </div>
            <div className="bg-[#FBFBFA] rounded-xl p-4 border border-[#141414]/5">
              <div className="text-[9px] uppercase font-bold text-[#141414]/40 tracking-widest mb-1.5 flex items-center gap-1">
                <Target className="w-3 h-3" /> Strike
              </div>
              <div className="font-mono font-bold text-2xl">R$ {opt.strike?.toFixed(2) ?? '-'}</div>
            </div>
          </div>

          {/* Situação */}
          <div className="bg-[#FBFBFA] rounded-xl p-4 border border-[#141414]/5 space-y-3">
            <div className="text-[9px] uppercase font-bold text-[#141414]/40 tracking-widest">Situação no Mercado</div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-[#141414]/60">Preço do ativo ({stockTicker})</span>
              <span className="font-mono font-bold text-sm">R$ {stockPrice.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-[#141414]/60">Status</span>
              <div className="flex items-center gap-2">
                <MoneynessBadge moneyness={status} />
                <span className="text-xs text-[#141414]/40">
                  {status === 'ITM' ? '(no dinheiro)' : status === 'ATM' ? '(na batida)' : '(fora do dinheiro)'}
                </span>
              </div>
            </div>
            {moneynessPct !== null && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-[#141414]/60 flex items-center gap-1">
                  <Percent className="w-3 h-3" /> Distância do strike
                </span>
                <span className={`font-mono text-sm font-bold ${moneynessPct > 0 ? 'text-emerald-600' : moneynessPct < 0 ? 'text-rose-600' : 'text-[#141414]/40'}`}>
                  {moneynessPct > 0 ? '+' : ''}{moneynessPct.toFixed(2)}%
                </span>
              </div>
            )}
          </div>

          {/* Decomposição do prêmio */}
          {opt.preco != null && intrinsic !== null && timeValue !== null && (
            <div className="bg-[#FBFBFA] rounded-xl p-4 border border-[#141414]/5 space-y-3">
              <div className="text-[9px] uppercase font-bold text-[#141414]/40 tracking-widest">Decomposição do Prêmio</div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-[#141414]/60">Valor Intrínseco</span>
                <span className="font-mono text-sm font-bold text-emerald-600">R$ {intrinsic.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-[#141414]/60">Valor do Tempo</span>
                <span className="font-mono text-sm font-bold text-blue-600">R$ {timeValue.toFixed(2)}</span>
              </div>
              {opt.preco > 0 && (
                <div className="space-y-1.5">
                  <div className="h-1.5 bg-[#141414]/5 rounded-full overflow-hidden flex">
                    <div
                      className="h-full bg-emerald-500 rounded-full transition-all"
                      style={{ width: `${Math.min(100, (intrinsic / opt.preco) * 100)}%` }}
                    />
                    <div
                      className="h-full bg-blue-400 rounded-full transition-all"
                      style={{ width: `${Math.min(100, (timeValue / opt.preco) * 100)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[9px] text-[#141414]/40">
                    <span className="text-emerald-600">■ Intrínseco {((intrinsic / opt.preco) * 100).toFixed(0)}%</span>
                    <span className="text-blue-500">■ Tempo {((timeValue / opt.preco) * 100).toFixed(0)}%</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Vencimento */}
          <div className="bg-[#FBFBFA] rounded-xl p-4 border border-[#141414]/5 space-y-3">
            <div className="text-[9px] uppercase font-bold text-[#141414]/40 tracking-widest flex items-center gap-1">
              <Calendar className="w-3 h-3" /> Vencimento
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-[#141414]/60">Data de vencimento</span>
              <span className="font-mono text-sm font-bold">
                {opt.vencimento ? new Date(opt.vencimento + 'T12:00:00Z').toLocaleDateString('pt-BR') : '-'}
              </span>
            </div>
            {daysToExpiry !== null && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-[#141414]/60">Dias até vencimento</span>
                <span className={`font-mono text-sm font-bold ${daysToExpiry <= 7 ? 'text-rose-600' : daysToExpiry <= 30 ? 'text-amber-600' : 'text-[#141414]'}`}>
                  {daysToExpiry} dias
                </span>
              </div>
            )}
          </div>

          {/* Gregas */}
          {greeks && iv != null ? (
            <div className="bg-[#FBFBFA] rounded-xl p-4 border border-[#141414]/5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-[9px] uppercase font-bold text-[#141414]/40 tracking-widest">Gregas (Black-Scholes)</div>
                <span className="text-[9px] font-mono text-[#141414]/30">IV {(iv * 100).toFixed(1)}%</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[#141414]/50">Δ Delta</span>
                  <span className={`font-mono text-xs font-bold ${greeks.delta > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {greeks.delta.toFixed(4)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[#141414]/50">Γ Gamma</span>
                  <span className="font-mono text-xs font-bold text-blue-600">
                    {greeks.gamma.toFixed(4)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[#141414]/50">Θ Theta/dia</span>
                  <span className="font-mono text-xs font-bold text-rose-600">
                    {greeks.theta.toFixed(4)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[#141414]/50">V Vega/1%</span>
                  <span className="font-mono text-xs font-bold text-purple-600">
                    {greeks.vega.toFixed(4)}
                  </span>
                </div>
              </div>
              <div className="pt-1 border-t border-[#141414]/5">
                <div className="text-[9px] text-[#141414]/30 leading-relaxed">
                  Calculadas com Black-Scholes · Taxa SELIC {(SELIC * 100).toFixed(2)}% · Baseado no último preço de fechamento
                </div>
              </div>
            </div>
          ) : T > 0 && opt.preco != null ? (
            <div className="bg-[#FBFBFA] rounded-xl p-4 border border-[#141414]/5">
              <div className="text-[9px] uppercase font-bold text-[#141414]/40 tracking-widest mb-2">Gregas</div>
              <p className="text-xs text-[#141414]/40">Não foi possível calcular a volatilidade implícita para esta opção.</p>
            </div>
          ) : null}

          {/* Bid / Ask ao vivo */}
          <div className={`rounded-xl p-4 border space-y-3 ${liveData ? 'bg-[#FBFBFA] border-[#141414]/5' : 'bg-amber-50 border-amber-200/60'}`}>
            <div className="flex items-center justify-between">
              <div className={`text-[9px] uppercase font-bold tracking-widest ${liveData ? 'text-[#141414]/40' : 'text-amber-700/70'}`}>
                Ofertas (Yahoo Finance)
              </div>
              {liveLoading ? (
                <RefreshCw className="w-3 h-3 animate-spin text-[#141414]/30" />
              ) : liveData ? (
                <span className="text-[9px] font-mono text-[#141414]/30">~15 min delay</span>
              ) : null}
            </div>

            {liveLoading ? (
              <div className="flex items-center gap-2 py-2 text-[#141414]/40">
                <RefreshCw className="w-3 h-3 animate-spin" />
                <span className="text-xs">Buscando dados ao vivo...</span>
              </div>
            ) : liveData ? (
              <>
                <div className="flex items-center gap-3">
                  <div className="flex-1 text-center bg-white rounded-lg p-3 border border-[#141414]/5">
                    <div className="text-[9px] text-[#141414]/40 font-bold uppercase mb-1">Bid</div>
                    <div className="font-mono text-base font-bold text-emerald-600">
                      {liveData.bid != null ? `R$ ${liveData.bid.toFixed(2)}` : 'N/D'}
                    </div>
                  </div>
                  <div className="flex-1 text-center bg-white rounded-lg p-3 border border-[#141414]/5">
                    <div className="text-[9px] text-[#141414]/40 font-bold uppercase mb-1">Ask</div>
                    <div className="font-mono text-base font-bold text-rose-600">
                      {liveData.ask != null ? `R$ ${liveData.ask.toFixed(2)}` : 'N/D'}
                    </div>
                  </div>
                  <div className="flex-1 text-center bg-white rounded-lg p-3 border border-[#141414]/5">
                    <div className="text-[9px] text-[#141414]/40 font-bold uppercase mb-1">Último</div>
                    <div className={`font-mono text-base font-bold ${opt.tipo === 'CALL' ? 'text-emerald-600' : 'text-rose-600'}`}>
                      R$ {(liveData.preco ?? opt.preco)?.toFixed(2) ?? '-'}
                    </div>
                  </div>
                </div>
                {(liveData.bid != null && liveData.ask != null) && (
                  <div className="flex items-center justify-between text-xs text-[#141414]/50">
                    <span>Spread</span>
                    <span className="font-mono font-bold">
                      R$ {(liveData.ask - liveData.bid).toFixed(2)}
                      {' '}
                      ({liveData.bid > 0 ? (((liveData.ask - liveData.bid) / liveData.bid) * 100).toFixed(1) : '—'}%)
                    </span>
                  </div>
                )}
                {(liveData.volume != null || liveData.openInterest != null) && (
                  <div className="grid grid-cols-2 gap-2 pt-1 border-t border-[#141414]/5">
                    {liveData.volume != null && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-[#141414]/50">Volume</span>
                        <span className="font-mono text-xs font-bold">{liveData.volume.toLocaleString('pt-BR')}</span>
                      </div>
                    )}
                    {liveData.openInterest != null && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-[#141414]/50">Open Interest</span>
                        <span className="font-mono text-xs font-bold">{liveData.openInterest.toLocaleString('pt-BR')}</span>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-xs text-amber-700/60 leading-relaxed">
                  {liveAviso ?? 'Yahoo Finance não possui dados ao vivo para este contrato. O COTAHIST B3 registra apenas o preço de fechamento.'}
                </p>
                <div className="flex items-center gap-3">
                  <div className="flex-1 text-center bg-white rounded-lg p-2 border border-amber-200/40">
                    <div className="text-[9px] text-amber-600/60 font-bold uppercase">Bid</div>
                    <div className="font-mono text-sm text-amber-700/40">N/D</div>
                  </div>
                  <div className="flex-1 text-center bg-white rounded-lg p-2 border border-amber-200/40">
                    <div className="text-[9px] text-amber-600/60 font-bold uppercase">Ask</div>
                    <div className="font-mono text-sm text-amber-700/40">N/D</div>
                  </div>
                  <div className="flex-1 text-center bg-white rounded-lg p-2 border border-amber-200/40">
                    <div className="text-[9px] text-amber-600/60 font-bold uppercase">Último</div>
                    <div className={`font-mono text-sm font-bold ${opt.tipo === 'CALL' ? 'text-emerald-600' : 'text-rose-600'}`}>
                      R$ {opt.preco?.toFixed(2) ?? '-'}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
          {/* Análise IA */}
          <div className="bg-gradient-to-br from-violet-50 to-indigo-50 rounded-xl p-4 border border-violet-200/60 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[9px] uppercase font-bold tracking-widest text-violet-700/70 flex items-center gap-1.5">
                <span>✦</span> Análise IA
              </div>
              {!aiAnalysis && !aiLoading && (
                <button
                  onClick={() => {
                    setAiLoading(true);
                    setAiError(null);
                    analyzeOption({
                      opt: { ticker: opt.ticker, tipo: opt.tipo, strike: opt.strike, preco: opt.preco },
                      stockPrice,
                      stockTicker,
                      greeks,
                      iv,
                      daysToExpiry,
                      liveData: liveData ? { bid: liveData.bid, ask: liveData.ask, volume: liveData.volume, openInterest: liveData.openInterest } : null,
                    }).then((res) => {
                      if ('analise' in res) setAiAnalysis(res.analise);
                      else setAiError(res.error);
                      setAiLoading(false);
                    }).catch(() => {
                      setAiError('Não foi possível conectar ao servidor.');
                      setAiLoading(false);
                    });
                  }}
                  className="text-[10px] font-semibold text-violet-700 bg-white border border-violet-200 rounded-lg px-2.5 py-1 hover:bg-violet-50 transition-colors"
                >
                  Analisar
                </button>
              )}
              {aiAnalysis && (
                <button
                  onClick={() => setAiAnalysis(null)}
                  className="text-[10px] text-violet-500/60 hover:text-violet-700 transition-colors"
                >
                  Limpar
                </button>
              )}
            </div>
            {aiLoading && (
              <div className="flex items-center gap-2 py-2 text-violet-600/60">
                <RefreshCw className="w-3 h-3 animate-spin" />
                <span className="text-xs">Gerando análise...</span>
              </div>
            )}
            {aiError && (
              <p className="text-xs text-rose-600/70">{aiError}</p>
            )}
            {aiAnalysis && (
              <p className="text-xs text-[#141414]/70 leading-relaxed whitespace-pre-wrap">{aiAnalysis}</p>
            )}
            {!aiAnalysis && !aiLoading && !aiError && (
              <p className="text-xs text-violet-600/50">Clique em "Analisar" para gerar uma análise com IA desta opção.</p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-[#141414]/5 p-4">
          <p className="text-[9px] uppercase tracking-widest text-[#141414]/30 text-center">
            Não representa recomendação de investimento
          </p>
        </div>
      </motion.div>
    </>
  );
}

function ExpandedOptionsRow({
  ticker,
  isLoading,
  opts,
  currentPrice,
}: {
  key?: string;
  ticker: string;
  isLoading: boolean;
  opts: OptionData[] | undefined;
  currentPrice: number;
}) {
  const [selectedOption, setSelectedOption] = useState<OptionData | null>(null);

  const vencimentos = useMemo(() => {
    if (!opts) return [];
    const v = new Set(opts.map((o) => o.vencimento));
    return Array.from(v).filter(Boolean).sort();
  }, [opts]);

  const [selectedVenc, setSelectedVenc] = useState<string>('');

  useEffect(() => {
    if (!selectedVenc && vencimentos.length > 0) {
      setSelectedVenc(vencimentos[0]);
    } else if (selectedVenc && !vencimentos.includes(selectedVenc) && vencimentos.length > 0) {
      setSelectedVenc(vencimentos[0]);
    }
  }, [vencimentos, selectedVenc]);

  const filteredOpts = useMemo(() => {
    if (!opts) return [];
    if (!selectedVenc) return opts;
    return opts.filter((o) => o.vencimento === selectedVenc);
  }, [opts, selectedVenc]);

  const calls = filteredOpts.filter((o) => o.tipo === 'CALL');
  const puts = filteredOpts.filter((o) => o.tipo === 'PUT');

  return (
    <tr className="bg-[#FBFBFA]">
      <td colSpan={9} className="px-6 py-8">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[#141414]/40">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span className="text-xs">Carregando opções para {ticker}...</span>
          </div>
        ) : (
          <div className="space-y-6">
            {vencimentos.length > 0 ? (
              <div className="flex items-center gap-4">
                <label className="text-[10px] uppercase font-bold text-[#141414]/40 tracking-widest">
                  Data de Vencimento:
                </label>
                <div className="relative">
                  <select
                    className="appearance-none bg-white border border-[#141414]/10 rounded-lg pl-3 pr-8 py-1.5 text-sm font-bold text-[#141414] focus:outline-none focus:ring-2 focus:ring-[#141414]/20 cursor-pointer shadow-sm"
                    value={selectedVenc}
                    onChange={(e) => setSelectedVenc(e.target.value)}
                  >
                    {vencimentos.map((v) => (
                      <option key={v} value={v}>
                        {new Date(v + 'T12:00:00Z').toLocaleDateString('pt-BR')}
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-[#141414]/40">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path>
                    </svg>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* CALLS */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-emerald-500" />
                    <h4 className="text-[10px] font-bold uppercase tracking-widest text-emerald-600">
                      Opções CALL (Compra)
                    </h4>
                  </div>
                  {selectedVenc && (
                    <span className="text-[10px] font-mono text-[#141414]/40 uppercase">
                      Venc: {new Date(selectedVenc + 'T12:00:00Z').toLocaleDateString('pt-BR')}
                    </span>
                  )}
                </div>
                <div className="bg-white rounded-xl border border-[#141414]/5 overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#F5F5F4]/50 border-b border-[#141414]/5">
                      <tr>
                        <th className="px-4 py-2 font-bold text-[#141414]/40 whitespace-nowrap">Símbolo</th>
                        <th className="px-4 py-2 w-20 text-center"></th>
                        <th className="px-4 py-2 font-bold text-[#141414]/40">Strike</th>
                        <th className="px-4 py-2 font-bold text-[#141414]/40 text-right">Prêmio</th>
                      </tr>
                    </thead>
                    <tbody>
                      {calls.map((opt) => {
                        const moneyness = getMoneyness(opt.strike, currentPrice, 'CALL');
                        return (
                          <tr
                            key={opt.ticker}
                            className="border-b border-[#141414]/5 last:border-0 hover:bg-[#F5F5F4]/50 transition-colors cursor-pointer"
                            onClick={() => setSelectedOption(opt)}
                          >
                            <td className="px-4 py-2 font-mono font-bold whitespace-nowrap hover:text-emerald-600 transition-colors">{opt.ticker}</td>
                            <td className="px-4 py-2 w-20 text-center">
                              <MoneynessBadge moneyness={moneyness} />
                            </td>
                            <td className="px-4 py-2 font-mono text-[#141414]/60">R$ {opt.strike?.toFixed(2)}</td>
                            <td className="px-4 py-2 font-mono text-right text-emerald-600 font-bold">
                              R$ {opt.preco?.toFixed(2)}
                            </td>
                          </tr>
                        );
                      })}
                      {calls.length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-4 py-4 text-center text-[#141414]/30">
                            Nenhuma CALL disponível
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* PUTS */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <TrendingDown className="w-4 h-4 text-rose-500" />
                    <h4 className="text-[10px] font-bold uppercase tracking-widest text-rose-600">
                      Opções PUT (Venda)
                    </h4>
                  </div>
                  {selectedVenc && (
                    <span className="text-[10px] font-mono text-[#141414]/40 uppercase">
                      Venc: {new Date(selectedVenc + 'T12:00:00Z').toLocaleDateString('pt-BR')}
                    </span>
                  )}
                </div>
                <div className="bg-white rounded-xl border border-[#141414]/5 overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#F5F5F4]/50 border-b border-[#141414]/5">
                      <tr>
                        <th className="px-4 py-2 font-bold text-[#141414]/40 whitespace-nowrap">Símbolo</th>
                        <th className="px-4 py-2 w-20 text-center"></th>
                        <th className="px-4 py-2 font-bold text-[#141414]/40">Strike</th>
                        <th className="px-4 py-2 font-bold text-[#141414]/40 text-right">Prêmio</th>
                      </tr>
                    </thead>
                    <tbody>
                      {puts.map((opt) => {
                        const moneyness = getMoneyness(opt.strike, currentPrice, 'PUT');
                        return (
                          <tr key={opt.ticker} className="border-b border-[#141414]/5 last:border-0 hover:bg-[#F5F5F4]/50 transition-colors cursor-pointer" onClick={() => setSelectedOption(opt)}>
                            <td className="px-4 py-2 font-mono font-bold whitespace-nowrap hover:text-rose-600 transition-colors">{opt.ticker}</td>
                            <td className="px-4 py-2 w-20 text-center">
                              <MoneynessBadge moneyness={moneyness} />
                            </td>
                            <td className="px-4 py-2 font-mono text-[#141414]/60">R$ {opt.strike?.toFixed(2)}</td>
                            <td className="px-4 py-2 font-mono text-right text-rose-600 font-bold">
                              R$ {opt.preco?.toFixed(2)}
                            </td>
                          </tr>
                        );
                      })}
                      {puts.length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-4 py-4 text-center text-[#141414]/30">
                            Nenhuma PUT disponível
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}
        <AnimatePresence>
          {selectedOption && (
            <OptionDetailModal
              opt={selectedOption}
              stockPrice={currentPrice}
              stockTicker={ticker}
              onClose={() => setSelectedOption(null)}
            />
          )}
        </AnimatePresence>
      </td>
    </tr>
  );
}
