# Análise Completa do Código - B3 Penny Stock Analyzer

## 📋 Resumo Executivo

**B3 Penny Stock Analyzer** é um dashboard web de análise de **penny stocks** da bolsa brasileira (B3) com:
- **Frontend** moderno em React 19 + TypeScript + Tailwind v4
- **Backend** REST em Express.js com auto-atualização periódica
- **Pipeline Python** para coleta de dados da B3 e enriquecimento via yfinance
- **Análise de opções** com Black-Scholes Greeks e IA via Ollama

**Stack Tecnológico:**
```
Frontend (Vite)    →    Backend (Express)    →    Python (Dados)
React 19           Node.js 18+              yfinance, COTAHIST B3
TypeScript          TypeScript (tsx)        Ollama (IA)
Tailwind v4         Recharts, Motion
```

---

## 🏗️ Arquitetura

### Estrutura de Diretórios

```
project/
├── src/                       # Frontend React
│   ├── App.tsx               # Componente principal (1442 linhas)
│   ├── services/
│   │   └── stockService.ts   # Chamadas HTTP à API
│   ├── utils.ts              # Tipos e helpers
│   └── main.tsx
├── server/
│   └── index.ts              # API Express (360 linhas)
├── scripts/
│   ├── update_stocks.py      # Pipeline principal de dados
│   ├── fetch_option_live.py  # Busca bid/ask em tempo real
│   ├── fetch_b3_data.R       # Script R opcional (rb3)
│   ├── base_tickers.json     # Lista de tickers monitorados
│   └── seed_from_csv.py      # Seed inicial
├── public/
│   └── stocks.json           # Saída dos dados (gerado)
├── data/
│   └── cotahist.json         # Cache do COTAHIST B3
└── vite.config.ts            # Configuração do bundler
```

---

## 🎨 Frontend (`src/App.tsx` - 1442 linhas)

### Padrão e Organização

- **Componente Funcional Monolítico**: 99% da UI está em `App.tsx`
- **Hooks Utilizados**: `useState`, `useEffect`, `useMemo`, `useCallback`
- **Gerenciamento de Estado**: Local com React hooks (sem Redux/Zustand)

### Estrutura de Estado

```typescript
// Estados principais
const [response, setResponse] = useState<StocksResponse | null>(null)
const [loading, setLoading] = useState(true)
const [selectedTicker, setSelectedTicker] = useState<string | null>(null)
const [expandedTickers, setExpandedTickers] = useState<Set<string>>(new Set())
const [optionsCache, setOptionsCache] = useState<Record<string, OptionData[]>>({})
const [sortConfig, setSortConfig] = useState<{ key, direction }>({ key: 'var1a', direction: 'desc' })
```

### Features Principais

#### 1. **Dashboard Stats Grid**
- Cards com: Total de ativos, Preço médio, Maior alta, Maior baixa
- Componente reutilizável `<StatCard />`

#### 2. **Visualizações com Recharts**
- **Bar Chart**: Comparativo de preços dos tickers fixos (clicável)
- **Pie Chart**: Distribuição por setor
- Tooltips customizados

#### 3. **Tabela Interativa com Sorting**
- **20 tickers fixos** exibidos por padrão (RAIZ4, QUAL3, CVCB3, etc.)
- Ordenação clicável em colunas: ticker, preço, variações, P/L, P/VP, Upside Graham
- Linha selecionada destacada em azul
- Expand/collapse com ícone chevron rotativo

#### 4. **Lazy-Loading de Opções**
- Ao expandir linha: busca opções via `/api/options/:ticker`
- Cache em memória (`optionsCache`)
- Loading spinner enquanto carrega

#### 5. **Modal Deslizante de Opção**
- Triggered ao clicar em uma opção na tabela expandida
- **Right-slide animation** via Motion (spring physics)
- Exibe: strike, prêmio, bid/ask, vencimento, gregas, status (ITM/ATM/OTM)

#### 6. **Black-Scholes Greeks**
```typescript
// Implementação inline no frontend (linhas 761–806)
function normCDF(x: number): number        // Cumulative Distribution Function
function bsPrice(tipo, S, K, T, r, sigma) // Preço teórico
function calcIV(tipo, S, K, T, r, price)  // IV por binary search (100 iterações)
function calcGreeks(tipo, S, K, T, r, sigma) // Delta, Gamma, Theta, Vega
```
- **Taxa SELIC hardcoded**: 13.75%
- IV calculado por binary search de 0.001 a 10.0
- Gregas atualizadas quando há dados de IV

#### 7. **Análise IA (Ollama)**
- Botão "Analisar" na seção de Análise IA do modal
- Envia contexto completo da opção (gregas, preço, moneyness, vencimento)
- Prompt estruturado em português
- Timeout de 60s

#### 8. **Busca e Pesquisa**
- Input search integrado no header
- Filtra por: ticker, empresa, setor
- Vista reduzida (só tabela) quando há busca ativa
- Carrossel de tickers em `showStocksList`

#### 9. **Atualização Manual**
```typescript
// Fluxo:
// 1. Click "Pesquisar" → POST /api/update
// 2. Poll GET /api/status a cada 3s (máx 90s)
// 3. Quando updateInProgress=false → loadData()
```
- Busca pode ser de um ticker específico ou geral
- Status message com spinner
- Recarrega e mostra resultado

### Padrões de Código

**✅ Bem feito:**
- Formatação clara de números: `preco.toFixed(2)`, `fmtPct()`
- Classes dinâmicas com `cn()`: `cn("text-emerald-600", varClass(val))`
- Render condicional limpo: `{condition ? <A /> : <B />}`
- Lazy loading com `useMemo` para filtro + sort
- Separação de sub-components: `<StatCard />`, `<TableHead />`, `<OptionDetailModal />`

**⚠️ Pontos a considerar:**
- **Tamanho do arquivo**: 1442 linhas em 1 arquivo (monolítico)
- **Duplicação**: `StocksTable` é similar ao código da tabela principal (670–708 vs 501–582)
- **Manutenção**: 600+ linhas de Modal é difícil de testar isolado
- **Sem testes unitários** na estrutura

---

## 🖥️ Backend (`server/index.ts` - 360 linhas)

### Responsabilidades

```
GET  /api/stocks              → Retorna stocks.json
POST /api/update              → Dispara Python script
GET  /api/status              → Metadados da atualização
GET  /api/options/:ticker     → COTAHIST (opções futuras)
GET  /api/options/:ticker/live → yfinance (bid/ask ~15min delay)
POST /api/options/analyze     → Ollama (IA)
```

### Implementações Destaques

#### 1. **CORS Whitelist**
```typescript
const allowedOrigins = [
  'http://localhost:3000',
  process.env.ALLOWED_ORIGIN ?? '',
].filter(Boolean)
```
- Dinâmico via `ALLOWED_ORIGIN` em produção
- Varia o header `Access-Control-Allow-Origin` por origem

#### 2. **Atualização Assíncrona**
```typescript
let updateInProgress = false
app.post('/api/update', (req, res) => {
  if (updateInProgress) return res.status(409).json({...})
  updateInProgress = true
  res.json({ success: true })  // Responde imediatamente
  runUpdateScript(args, callback)  // Roda em background
})
```
- **Non-blocking**: responde logo, executa em background
- **Evita race conditions** com flag `updateInProgress`
- Timeout de **10 minutos** para execução máxima

#### 3. **Auto-Update Periódico**
```typescript
setInterval(() => {
  if (updateInProgress || !isTradinghours()) return
  updateInProgress = true
  runUpdateScript([], callback)
}, 30 * 60 * 1000)  // 30 min

function isTradinghours(): boolean {
  // Pregão B3: 10:00–18:20 BRT (UTC-3) → 13:00–21:20 UTC
  const utcH = now.getUTCHours()
  const total = utcH * 60 + utcM
  return total >= 13 * 60 && total <= 21 * 60 + 20
}
```
- Só atualiza em horário de pregão
- Checa fusos corretamente (BRT = UTC-3)

#### 4. **Opções via COTAHIST**
```typescript
app.get('/api/options/:ticker', (req, res) => {
  const cotahist = JSON.parse(readFileSync(COTAHIST_FILE, 'utf-8'))
  const matched = allOpts.filter(o => o.ticker_objeto === ticker && o.vencimento >= today)
  // Seleciona próximos 8 vencimentos por tipo
  // Retorna sorted por vencimento + strike
})
```
- Filtra por ticker + data futura
- Limita a 8 vencimentos por CALL/PUT
- Ordenação: data → strike

#### 5. **Dados Ao Vivo (yfinance)**
```typescript
app.get('/api/options/:ticker/live', (req, res) => {
  const proc = spawn(python, [script, ticker])
  const timeout = setTimeout(() => { proc.kill() }, 30_000)
  // Coleta bid, ask, volume, open interest, IV implícita
})
```
- Subprocess com timeout de 30s
- Mata processo se demorar
- Captura stdout/stderr

#### 6. **Análise IA (Ollama)**
```typescript
app.post('/api/options/analyze', async (req, res) => {
  const context = [...].join('\n')  // Monta contexto da opção
  const response = await fetch(`${ollamaUrl}/api/chat`, {
    body: JSON.stringify({
      model: ollamaModel,  // 'llama2' por padrão
      messages: [{ role: 'user', content: userPrompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  })
})
```
- Conecta a VPS Hostinger rodando Ollama
- Timeout de 60s (o modelo leva tempo)
- Resposta em JSON

#### 7. **Serving Build (Produção)**
```typescript
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))  // Serve ./dist/
  app.get('*', (_, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'))  // SPA fallback
  })
}
```
- Fallback HTML para rotas não existentes (SPA)

#### 8. **Auto-Update no Startup**
```typescript
if (!existsSync(STOCKS_FILE)) {
  console.log('[startup] stocks.json ausente — iniciando...')
  updateInProgress = true
  runUpdateScript([], callback)
}
```
- Se servidor inicia sem dados → gera automaticamente
- Importante para cold-start no Render

### Padrões de Código

**✅ Bem feito:**
- Middleware CORS bem pensado (dinâmico)
- Helpers reutilizáveis (`readStocks()`, `runUpdateScript()`)
- Logging estruturado com prefixos `[update]`, `[auto-update]`, `[startup]`
- Tratamento de timeouts em subprocessos

**⚠️ Pontos a considerar:**
- **Sem versionamento de API**: sem `/v1/` na rota
- **Sem validação de input**: `ticker` não é validado (injection risk baixo, mas existe)
- **Sem rate limiting**: qualquer um pode chamar `/api/update` múltiplas vezes
- **Sem cache HTTP**: todo GET refaz leitura de arquivo

---

## 🐍 Pipeline Python (`scripts/update_stocks.py`)

### Fluxo Geral

```
1. [Opcional] Script R (rb3) → COTAHIST completo
2. [Fallback] Baixa ZIP COTAHIST B3 direto
3. Parse COTAHIST → tickers + opções futuras
4. Enriquecimento yfinance (fundamentos)
5. Cálculo indicadores: Graham Upside, variações
6. Salva → public/stocks.json
```

### Funcionalidades

- **Paralelismo**: ThreadPoolExecutor com N workers (default 8)
- **Retry Logic**: tenta R, fallback para Python
- **Caching**: cotahist.json evita re-download desnecessário
- **CLI Args**: `--max-preco`, `--workers`, `--ticker`
- **Logging**: info sobre progresso de coleta

---

## 🎯 Serviço HTTP (`src/services/stockService.ts` - 215 linhas)

### Responsabilidades

```typescript
// Principais funções
getStocks()          → API + CSV fallback
getOptions(ticker)   → Opções futuras
getOptionsLive()     → Bid/ask yfinance
analyzeOption()      → POST IA
triggerUpdate()      → POST /api/update
getUpdateStatus()    → Polling status
```

### Padrões

**Fallback inteligente:**
```typescript
export async function getStocks(): Promise<StocksResponse> {
  try {
    const res = await fetch(`${API_BASE}/api/stocks`, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(...)
    const data = await res.json()
    // Valida mínimo de 10 stocks
    if (parsed.stocks.length < 10) throw new Error('Dados insuficientes')
    return parsed
  } catch {
    // Fallback: CSV estático embutido
    const stocks = parseStaticCsv()
    return { ..., fonte: 'CSV estático (API indisponível)', isLive: false }
  }
}
```
- Se API cair → usa CSV hardcoded (permite offline)
- Timeout de 60s para cold-start do Render

**Timeouts bem definidos:**
```typescript
fetch(..., { signal: AbortSignal.timeout(60_000) })  // getStocks()
fetch(..., { signal: AbortSignal.timeout(8_000) })   // getOptions()
fetch(..., { signal: AbortSignal.timeout(35_000) })  // getOptionsLive()
fetch(..., { signal: AbortSignal.timeout(30_000) })  // analyzeOption()
```

---

## 🔢 Type System (`src/utils.ts` - 54 linhas)

### Tipos Centrais

```typescript
interface StockData {
  ticker: string
  empresa: string
  preco: number
  setor: string
  dy: number | null              // Dividend Yield
  pl: number | null              // P/L ratio
  pvp: number | null             // P/VP ratio
  var1a: number | null           // Variação 1 ano
  var5a: number | null           // Variação 5 anos
  upsideGraham: number | null    // Graham Upside
  varDia, varSemana: number | null
  volume: number | null
  ultimaAtualizacao: string
  opcoes?: OptionData[]
}

interface OptionData {
  ticker: string
  tipo: 'CALL' | 'PUT'
  strike: number | null
  preco: number | null
  vencimento: string
  bid?, ask?, volume?, openInterest?, impliedVolatility?: number | null
}
```

### Parsing Helpers

```typescript
parseCurrency(val: string): number
  // "R$ 1.234,56" → 1234.56

parsePercentage(val: string): number | null
  // "+12,34%" → 12.34 | "−5,67%" → -5.67

parseNumber(val: string): number | null
  // "1.000.000" → 1000000
```

---

## 🎯 Características Avançadas

### 1. **Black-Scholes Greeks Inline**
- Implementado **no frontend** em TypeScript puro
- 100 iterações de binary search para IV
- Delta, Gamma, Theta, Vega calculados
- Taxa SELIC hardcoded em 13.75%

### 2. **Moneyness Classification**
```typescript
function getMoneyness(strike, currentPrice, tipo): 'ITM' | 'ATM' | 'OTM'
  // ITM: no dinheiro | ATM: na batida (±2%) | OTM: fora do dinheiro
```

### 3. **Bid/Ask Spread Tracking**
- Spread absoluto: `ask - bid`
- Spread percentual: `spread / bid * 100`
- Exibido com formatação brasileira (R$)

### 4. **IA Contextualizada**
- Prompt estruturado em português
- Inclui: grekas, IV, moneyness, dias até vencimento, spread, volume
- Modelo: llama2 ou customizado via `OLLAMA_MODEL`

### 5. **Variações Temporais**
- Dia (24h)
- Semana (7d)
- Ano (1a)
- 5 anos (5a)

---

## 🛡️ Segurança & Boas Práticas

### ✅ Bem Implementado

1. **CORS Whitelist**: origens permitidas via variável de ambiente
2. **Timeout Protection**: todos os fetch têm timeout
3. **File Existence Check**: `existsSync()` antes de ler
4. **Error Handling**: try-catch em fetch, fallback JSON.parse
5. **Rate Limit (implícito)**: atualização via flag `updateInProgress`
6. **Type Safety**: TypeScript em frontend e backend
7. **Module Scope**: variáveis locais (não globals)

### ⚠️ Pontos de Melhoria

1. **Validação de Input**:
   - `ticker` em GET não é sanitizado
   - `maxPreco`, `ticker` em POST não têm schema validation
   - Risco: **Command Injection** se Python script for vulnerável

2. **Sem Rate Limiting HTTP**: qualquer cliente pode:
   - Fazer 1000 GET /api/stocks/segundo
   - Disparar POST /api/update múltiplas vezes (mitigado por `updateInProgress`)

3. **Sem Autenticação**: qualquer um dispara updates

4. **CSV Estático Embutido**: talvez sensível se contém dados privados

5. **Logging Mínimo**: não registra quem/quando para auditar

---

## 📊 Qualidade de Código

### Complexidade Ciclomática

| Arquivo | Linhas | Componentes | Nota |
|---------|--------|-------------|------|
| `App.tsx` | 1442 | 7 sub-components | **Alto**: 1 arquivo monolítico |
| `server/index.ts` | 360 | 6 rotas | Médio: bem estruturado |
| `stockService.ts` | 215 | 7 funções | Médio-Baixo: puro |
| `utils.ts` | 54 | tipos + 3 helpers | Baixo |

### Maintainability

- **Frontend**: Precisa quebrar App.tsx em ~5 arquivos menores
- **Backend**: Bem modularizado por responsabilidade
- **Python**: Não analisado, mas documentado

### Test Coverage

- **Sem testes** visíveis na estrutura

---

## 🚀 Performance

### Frontend

- **Initial Load**: ~1442 linhas de React → HMR rápido em dev
- **Recharts**: 2 gráficos responsivos (Bar + Pie)
- **Lazy Loading**: Opções carregadas on-demand via `toggleExpand()`
- **Memoization**: `useMemo()` em filtro/sort/stats

### Backend

- **In-Memory Flag**: `updateInProgress` é uma flag na RAM (não persiste)
  - ⚠️ Problem: Se reinicia server = perde estado
  - Solução: Usar arquivo lock ou Redis
- **File I/O**: Cada GET lê arquivo inteiro do disco
  - ⚠️ 20kb arquivo → OK, mas sem cache

### Python

- **ThreadPoolExecutor**: Paraleliza requisições yfinance (8 workers padrão)
- **Timeout**: Execução total máx 10 min

---

## 📈 Escalabilidade

### Atual (Render free tier + Vercel)

- **Concurrent Users**: ~10-20 (free tier limitado)
- **Update Latency**: 5-60s dependendo do Render
- **Data Size**: ~20kb (stocks.json) + ~50kb (cotahist.json)

### Gargalos

1. **CPU**: yfinance + BS Greeks em frontend
2. **I/O**: Arquivo JSON inteiro carregado em memória
3. **Network**: Render free tier tem CPU compartilhada

### Para crescer

- Database (PostgreSQL) em lugar de JSON
- Redis para cache de stocks
- Workers separados para atualização
- Frontend: code-splitting, lazy load gráficos

---

## 📝 Recomendações

### Curto Prazo (Quick Wins)

1. **Quebrar App.tsx**:
   - Extract `<StocksTable />` → `components/StocksTable.tsx`
   - Extract `<OptionDetailModal />` → `components/OptionDetailModal.tsx`
   - Extract `<Dashboard />` → `components/Dashboard.tsx` para a seção de gráficos

2. **Adicionar Validação**:
   ```typescript
   if (!/^[A-Z0-9]{4}$/.test(ticker)) return res.status(400).json({...})
   ```

3. **Input Sanitization**:
   ```typescript
   const sanitized = ticker.toUpperCase().replace(/[^A-Z0-9]/g, '')
   ```

4. **Testes básicos**:
   - Testes unitários para `parsePercentage()`, `cn()`
   - Tests E2E para fluxo de busca

### Médio Prazo

1. **Persistência de Estado**:
   - Substituir flag `updateInProgress` por arquivo lock
   - Redis para cache de stocks

2. **API Versioning**:
   - `/v1/api/stocks` → permite evolução sem breaking changes

3. **Rate Limiting**:
   ```typescript
   const rateLimit = require('express-rate-limit')
   app.use('/api/', rateLimit({ windowMs: '15m', max: 100 }))
   ```

4. **Testes de Carga**:
   - Verificar comportamento com 100+ usuários simultâneos

### Longo Prazo

1. **Database**:
   - PostgreSQL para histórico de preços
   - Query rápida por ticker + período

2. **Real-time**:
   - WebSocket para atualização live de preços
   - gRPC para backend robusto

3. **Observability**:
   - Logging estruturado (pino/winston)
   - APM (datadog/newrelic)
   - Alertas de falha

4. **Documentação**:
   - Swagger/OpenAPI para APIs
   - Docstrings em Python
   - ADR (Architecture Decision Records)

---

## 🎓 Conclusão

O projeto é bem estruturado para uma **MVP de análise de penny stocks**, com:
- ✅ Frontend moderno e responsivo
- ✅ Backend simples mas funcional
- ✅ Pipeline Python bem documentado
- ✅ Features avançadas (Black-Scholes, IA)
- ✅ Fallback inteligentes (CSV, timeout)

**Próximas etapas críticas:**
1. Quebrar App.tsx em componentes menores
2. Adicionar testes (unitários + E2E)
3. Implementar rate limiting e validação
4. Migrar para database para crescer em dados

---

**Análise gerada em**: 2026-04-20  
**Status**: Produção em Vercel + Render  
**Última atualização**: commit c3620d5 (timeout Ollama ajustado)
