import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getStocks, triggerUpdate, type StocksResponse } from './services/stockService';
import { cn, type StockData } from './utils';
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
  Legend,
  Line,
  Area,
  ComposedChart,
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];

// ---------------------------------------------------------------------------
// Dados históricos sintéticos para o gráfico de médias móveis
// ---------------------------------------------------------------------------
function generateHistory(currentPrice: number, var5y: number | null) {
  const points = 200;
  const history: { day: number; price: number }[] = [];
  const startPrice = currentPrice / (1 + (var5y || 0) / 100);
  const step = (currentPrice - startPrice) / points;

  for (let i = 0; i <= points; i++) {
    const noise = (Math.random() - 0.5) * currentPrice * 0.02;
    history.push({ day: i, price: parseFloat((startPrice + step * i + noise).toFixed(2)) });
  }

  return history.map((point, idx) => ({
    ...point,
    ma50:  idx >= 50  ? history.slice(idx - 50,  idx).reduce((a, p) => a + p.price, 0) / 50  : null,
    ma200: idx >= 199 ? history.slice(idx - 200, idx).reduce((a, p) => a + p.price, 0) / 200 : null,
  }));
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const [response, setResponse]       = useState<StocksResponse | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [refreshing, setRefreshing]   = useState(false);
  const [updateMsg, setUpdateMsg]     = useState<string | null>(null);

  const [searchTerm, setSearchTerm]   = useState('');
  const [sortConfig, setSortConfig]   = useState<{ key: keyof StockData; direction: 'asc' | 'desc' } | null>(
    { key: 'varDia', direction: 'desc' }
  );
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);

  // ---- carregamento inicial ------------------------------------------------
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getStocks();
      setResponse(res);
      if (!selectedTicker && res.stocks.length > 0) {
        setSelectedTicker(res.stocks[0].ticker);
      }
    } catch (err: any) {
      setError(err?.message ?? 'Erro desconhecido ao carregar dados.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ---- atualização via API -------------------------------------------------
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setUpdateMsg('Solicitando atualização...');
    const { ok, mensagem } = await triggerUpdate();
    setUpdateMsg(ok ? '✓ Atualização iniciada — recarregando em 5s' : `Erro: ${mensagem}`);
    if (ok) {
      setTimeout(async () => {
        await loadData();
        setRefreshing(false);
        setUpdateMsg(null);
      }, 5000);
    } else {
      setRefreshing(false);
      setTimeout(() => setUpdateMsg(null), 4000);
    }
  };

  const allStocks  = response?.stocks ?? [];
  const isLive     = response?.isLive ?? false;
  const fonte      = response?.fonte  ?? '';
  const lastUpdate = response?.lastUpdate ?? allStocks[0]?.ultimaAtualizacao ?? '';

  // ---- ação selecionada ----------------------------------------------------
  const selectedStock = useMemo(
    () => allStocks.find((s) => s.ticker === selectedTicker),
    [allStocks, selectedTicker]
  );

  const historicalData = useMemo(() => {
    if (!selectedStock) return [];
    return generateHistory(selectedStock.preco, selectedStock.var5a);
  }, [selectedStock]);

  // ---- filtro + ordenação --------------------------------------------------
  const filteredStocks = useMemo(() => {
    let stocks = allStocks.filter(
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
  }, [allStocks, searchTerm, sortConfig]);

  // ---- estatísticas --------------------------------------------------------
  const stats = useMemo(() => {
    if (allStocks.length === 0)
      return { avgPrice: 0, topGainer: null, topLoser: null, pieData: [] };

    const avgPrice  = allStocks.reduce((a, s) => a + s.preco, 0) / allStocks.length;
    const topGainer = [...allStocks].sort((a, b) => (b.varDia ?? -999) - (a.varDia ?? -999))[0];
    const topLoser  = [...allStocks].sort((a, b) => (a.varDia ?? 999)  - (b.varDia ?? 999))[0];

    const sectorMap = allStocks.reduce<Record<string, number>>((acc, s) => {
      acc[s.setor] = (acc[s.setor] || 0) + 1;
      return acc;
    }, {});
    const pieData = Object.entries(sectorMap).map(([name, value]) => ({ name, value }));

    return { avgPrice, topGainer, topLoser, pieData };
  }, [allStocks]);

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

  // ---- render principal ----------------------------------------------------
  return (
    <div className="min-h-screen bg-[#F5F5F4] text-[#141414] font-sans p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-8">

        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-[#141414]/10 pb-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Stock Radar BR</h1>
            <p className="text-sm text-[#141414]/60 uppercase tracking-widest mt-1">
              Ações abaixo de R$ 10,00 • B3
            </p>
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
                placeholder="Buscar ticker, empresa ou setor..."
                className="pl-10 pr-4 py-2 bg-white border border-[#141414]/10 rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-[#141414]/10 w-full md:w-64 transition-all"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            {/* Botão de atualizar */}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              title="Atualizar dados via rb3/yfinance"
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all border",
                refreshing
                  ? "bg-[#141414]/5 text-[#141414]/40 border-[#141414]/10 cursor-not-allowed"
                  : "bg-[#141414] text-white border-[#141414] hover:bg-[#141414]/80"
              )}
            >
              <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} />
              {refreshing ? 'Atualizando...' : 'Atualizar'}
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

        {/* Stats Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Total de Ativos"  value={allStocks.length}                  icon={<Layers className="w-4 h-4" />} />
          <StatCard label="Preço Médio"       value={`R$ ${stats.avgPrice.toFixed(2)}`} icon={<DollarSign className="w-4 h-4" />} />
          <StatCard
            label="Maior Alta (Dia)"
            value={stats.topGainer?.ticker ?? '-'}
            subValue={stats.topGainer?.varDia != null ? `${stats.topGainer.varDia > 0 ? '+' : ''}${stats.topGainer.varDia.toFixed(2)}%` : undefined}
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
                    data={allStocks.slice(0, 15)}
                    margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                    onClick={(data) => data && setSelectedTicker(data.activeLabel ?? null)}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#14141410" />
                    <XAxis dataKey="ticker" axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 500 }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10 }} />
                    <Tooltip contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)', fontSize: '12px' }} cursor={{ fill: '#14141405' }} />
                    <Bar dataKey="preco" fill="#141414" radius={[4, 4, 0, 0]} barSize={32} className="cursor-pointer">
                      {allStocks.slice(0, 15).map((entry, index) => (
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

            {/* Médias Móveis (histórico sintético) */}
            <AnimatePresence mode="wait">
              {selectedStock && (
                <motion.div
                  key={selectedStock.ticker}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="bg-white p-4 md:p-6 rounded-2xl border border-[#141414]/5 shadow-sm"
                >
                  <div className="flex items-center justify-between mb-6">
                    <div>
                      <h3 className="font-semibold text-lg">Médias Móveis: {selectedStock.ticker}</h3>
                      <p className="text-xs text-[#141414]/40">Tendência projetada com base no preço atual e variação de 5 anos</p>
                    </div>
                    <div className="flex items-center gap-4 text-[10px] font-bold uppercase tracking-wider">
                      <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-[#141414]" /> Preço</div>
                      <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-blue-500" /> MA50</div>
                      <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-orange-500" /> MA200</div>
                    </div>
                  </div>
                  <div className="h-[250px] md:h-[300px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={historicalData}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#14141405" />
                        <XAxis dataKey="day" hide />
                        <YAxis domain={['auto', 'auto']} axisLine={false} tickLine={false} tick={{ fontSize: 10 }} orientation="right" />
                        <Tooltip contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)', fontSize: '12px' }} />
                        <Area type="monotone" dataKey="price" fill="#f3f4f6" stroke="#141414" strokeWidth={1} fillOpacity={0.5} />
                        <Line type="monotone" dataKey="ma50"  stroke="#3b82f6" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="ma200" stroke="#f97316" strokeWidth={2} dot={false} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
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
              <p className="text-xs text-[#141414]/40 mt-0.5">{filteredStocks.length} de {allStocks.length} ativos</p>
            </div>
            <Activity className="w-4 h-4 text-[#141414]/40" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#F5F5F4]/50 border-b border-[#141414]/5">
                  <TableHead label="Ticker"  sortKey="ticker"       onSort={handleSort} />
                  <TableHead label="Empresa" sortKey="empresa"      onSort={handleSort} />
                  <TableHead label="Preço"   sortKey="preco"        onSort={handleSort} />
                  <TableHead label="Setor"   sortKey="setor"        onSort={handleSort} />
                  <TableHead label="Var. Dia"    sortKey="varDia"       onSort={handleSort} />
                  <TableHead label="Var. Semana" sortKey="varSemana"    onSort={handleSort} />
                  <TableHead label="P/L"     sortKey="pl"           onSort={handleSort} />
                  <TableHead label="P/VP"    sortKey="pvp"          onSort={handleSort} />
                  <TableHead label="Upside"  sortKey="upsideGraham" onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                <AnimatePresence mode="popLayout">
                  {filteredStocks.map((stock) => (
                    <motion.tr
                      layout
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      key={stock.ticker}
                      onClick={() => setSelectedTicker(stock.ticker)}
                      className={cn(
                        "border-b border-[#141414]/5 hover:bg-[#F5F5F4]/30 transition-colors cursor-pointer",
                        selectedTicker === stock.ticker && "bg-blue-50/50"
                      )}
                    >
                      <td className="px-6 py-4 font-mono font-bold text-sm">{stock.ticker}</td>
                      <td className="px-6 py-4 text-sm text-[#141414]/70 truncate max-w-[200px]">{stock.empresa}</td>
                      <td className="px-6 py-4 font-mono text-sm">R$ {stock.preco.toFixed(2)}</td>
                      <td className="px-6 py-4 text-xs uppercase tracking-wider text-[#141414]/50">{stock.setor}</td>
                      <td className={cn("px-6 py-4 font-mono text-sm", varClass(stock.varDia))}>
                        {fmtPct(stock.varDia)}
                      </td>
                      <td className={cn("px-6 py-4 font-mono text-sm", varClass(stock.varSemana))}>
                        {fmtPct(stock.varSemana)}
                      </td>
                      <td className="px-6 py-4 font-mono text-sm">{stock.pl?.toFixed(2) ?? '-'}</td>
                      <td className="px-6 py-4 font-mono text-sm">{stock.pvp?.toFixed(2) ?? '-'}</td>
                      <td className={cn("px-6 py-4 font-mono text-sm", varClass(stock.upsideGraham))}>
                        {fmtPct(stock.upsideGraham)}
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
        </div>

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
// Sub-components
// ---------------------------------------------------------------------------
function StatCard({
  label, value, subValue, icon,
}: {
  label: string; value: string | number; subValue?: string; icon: React.ReactNode;
}) {
  return (
    <div className="bg-white p-6 rounded-2xl border border-[#141414]/5 shadow-sm flex flex-col justify-between group hover:border-[#141414]/20 transition-all">
      <div className="flex items-center justify-between mb-4">
        <span className="text-[10px] uppercase font-bold tracking-widest text-[#141414]/40">{label}</span>
        <div className="p-2 bg-[#F5F5F4] rounded-lg group-hover:bg-[#141414] group-hover:text-white transition-colors">
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
