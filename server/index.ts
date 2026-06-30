/**
 * server/index.ts
 * ================
 * API Express para o B3 Penny Stock Analyzer.
 *
 * Endpoints:
 *   GET  /api/stocks          – Retorna public/stocks.json
 *   POST /api/update          – Dispara python3 scripts/update_stocks.py
 *   GET  /api/status          – Metadados sobre os dados (fonte, data, total)
 *   POST /api/options/analyze – Análise IA via OpenRouter (com rate limiting + fila)
 *
 * Em produção também serve o build do React (dist/).
 * Em desenvolvimento o Vite proxia /api → porta 3001.
 *
 * ✨ Melhorias:
 *   - PROBLEMA 1: Timeout frontend sincronizado (70s alinhado com backend 60s)
 *   - PROBLEMA 2: Rate limiting (30 req/15min por IP) no /api/options/analyze
 *   - PROBLEMA 3: Fila de análises (Bull Queue + Redis) para processar sequencial
 *   - OpenRouter API integration para análise com modelos de qualidade superior
 */

import express, { Request, Response, NextFunction } from 'express';
import { exec, spawn, ExecException } from 'child_process';
import rateLimit from 'express-rate-limit';
import Queue from 'bull';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STOCKS_FILE = path.join(PUBLIC_DIR, 'stocks.json');
const COTAHIST_FILE = path.join(DATA_DIR, 'cotahist.json');

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

// Configurar Trust Proxy para Render (e outros reverse proxies)
// Isso permite que o rate limiter identifique corretamente o IP do cliente
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// PROBLEMA 2 & 3: Rate Limiting + Bull Queue para análises
// ---------------------------------------------------------------------------

// Rate limiter: máx 30 requisições por IP a cada 15 minutos
const analyzeRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 30,                    // máx 30 requisições por IP
  standardHeaders: true,      // Retorna info em `RateLimit-*` headers
  legacyHeaders: false,       // Desabilita `X-RateLimit-*` headers
  message: 'Limite de análises excedido. Tente novamente em alguns minutos.',
  skip: (req) => {
    // Não aplicar rate limit em ambiente de desenvolvimento
    return process.env.NODE_ENV === 'development';
  },
});

// Modelo usado para a análise IA via OpenRouter
// Padrão: melhor modelo gratuito da OpenRouter (alta capacidade de raciocínio)
const AI_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free';

// Lista de modelos tentados em ordem. Se um id gratuito ficar indisponível
// (404 "No endpoints found"), tenta o próximo. O modelo configurado vem primeiro.
const FALLBACK_MODELS = [
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-2-9b-it:free',
];
const AI_MODELS = Array.from(new Set([AI_MODEL, ...FALLBACK_MODELS]));

// ---------------------------------------------------------------------------
// Análise IA de uma opção (compartilhada entre a fila e o fallback direto)
// ---------------------------------------------------------------------------
// Uma linha da cadeia (strike) já com BS teórico e P(exercício) calculados pelo frontend
interface ChainRow {
  ticker: string;
  strike: number | null;
  ultimo: number | null;   // último preço / prêmio
  bid: number | null;
  ask: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;        // volatilidade implícita (fração, ex.: 0.45)
  delta: number | null;
  bsTeorico: number | null; // preço justo Black-Scholes
  pExercicio: number | null;// probabilidade de exercício (fração, ex.: 0.435)
  focus?: boolean;          // opção selecionada pelo usuário
}

interface AnalyzePayload {
  opt: { ticker: string; tipo: 'CALL' | 'PUT'; strike: number | null; preco: number | null };
  stockPrice: number;
  stockTicker: string;
  greeks?: { delta: number; gamma: number; theta: number; vega: number } | null;
  iv?: number | null;
  daysToExpiry?: number | null;
  liveData?: { bid: number | null; ask: number | null; volume: number | null; openInterest: number | null } | null;
  vencimento?: string | null;
  chain?: ChainRow[] | null;
  bayesian?: {
    wins: number;
    losses: number;
    priorAlpha: number;
    priorBeta: number;
    posteriorAlpha: number;
    posteriorBeta: number;
    winRateMap: number;
    probOver50: number;
  } | null;
}

async function analisarOpcao(payload: AnalyzePayload): Promise<{ analise: string }> {
  const { opt, stockPrice, stockTicker, greeks, iv, daysToExpiry, liveData, vencimento, bayesian } = payload;

  const moneyness = opt.tipo === 'CALL'
    ? (stockPrice > (opt.strike ?? 0) ? 'ITM' : stockPrice < (opt.strike ?? 0) ? 'OTM' : 'ATM')
    : (stockPrice < (opt.strike ?? 0) ? 'ITM' : stockPrice > (opt.strike ?? 0) ? 'OTM' : 'ATM');

  const fmt = (v: number | null | undefined, dec = 2) => (v == null ? '—' : `R$ ${Number(v).toFixed(dec)}`);
  const pct = (v: number | null | undefined) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

  // Monta a tabela da cadeia (vários strikes). Se nenhuma cadeia veio, usa a própria opção como única linha.
  const chain: ChainRow[] = (payload.chain && payload.chain.length > 0)
    ? payload.chain
    : [{
        ticker: opt.ticker,
        strike: opt.strike,
        ultimo: opt.preco,
        bid: liveData?.bid ?? null,
        ask: liveData?.ask ?? null,
        volume: liveData?.volume ?? null,
        openInterest: liveData?.openInterest ?? null,
        iv: iv ?? null,
        delta: greeks?.delta ?? null,
        bsTeorico: null,
        pExercicio: greeks?.delta != null ? Math.abs(greeks.delta) : null,
        focus: true,
      }];

  const chainTable = [
    'CADEIA (vários strikes — use TODOS na tabela RECOMENDAÇÃO, uma linha por strike; não recalcule, use estes valores):',
    'Opção | Strike | Último | Ask | BS Teórico | P(Exercício)',
    ...chain.map((r) =>
      `${r.ticker}${r.focus ? ' ★' : ''} | ${fmt(r.strike)} | ${fmt(r.ultimo)} | ${fmt(r.ask)} | ${fmt(r.bsTeorico)} | ${pct(r.pExercicio)}`
    ),
  ].join('\n');

  const focus = chain.find((r) => r.focus) ?? chain[0];

  // Bloco Bayesian: usa histórico real quando fornecido
  const temBayesReal = bayesian != null && (bayesian.wins > 0 || bayesian.losses > 0);
  const bayesBlock = temBayesReal
    ? [
        'BAYESIAN (DADOS REAIS — NÃO marcar como estimativa, NÃO recalcular):',
        `Histórico: ${bayesian!.wins}W / ${bayesian!.losses}L`,
        `Prior Beta(${bayesian!.priorAlpha}, ${bayesian!.priorBeta}) → Posterior Beta(${bayesian!.posteriorAlpha}, ${bayesian!.posteriorBeta})`,
        `Win rate MAP: ${pct(bayesian!.winRateMap)} | P(estratégia > 50% de acerto): ${pct(bayesian!.probOver50)}`,
      ].join('\n')
    : null;

  const context = [
    `Ativo subjacente: ${stockTicker} (preço atual: R$ ${Number(stockPrice).toFixed(2)})`,
    `Tipo: ${opt.tipo} (${opt.tipo === 'CALL' ? 'Direito de Compra' : 'Direito de Venda'})`,
    vencimento ? `Vencimento: ${vencimento}` : null,
    daysToExpiry != null ? `Dias até vencimento: ${daysToExpiry}` : null,
    `Opção em foco (★): ${focus.ticker} — Strike ${fmt(focus.strike)} | Status ${moneyness}`,
    focus.ask != null ? `Ask em foco: ${fmt(focus.ask)} | Bid: ${fmt(focus.bid)} | BS teórico: ${fmt(focus.bsTeorico)}` : null,
    focus.iv != null ? `IV em foco: ${pct(focus.iv)}` : null,
    greeks ? `Gregas em foco — Delta: ${Number(greeks.delta).toFixed(4)} | Gamma: ${Number(greeks.gamma).toFixed(4)} | Theta/dia: ${Number(greeks.theta).toFixed(4)} | Vega/1%: ${Number(greeks.vega).toFixed(4)}` : null,
    focus.volume != null ? `Volume em foco: ${focus.volume} | Open Interest: ${focus.openInterest ?? '—'}` : null,
    '',
    chainTable,
    bayesBlock ? `\n${bayesBlock}` : null,
  ].filter((l) => l != null).join('\n');

  const hoje = new Date().toISOString().slice(0, 10);

  const bayesRule = temBayesReal
    ? '- A seção "BAYESIAN UPDATE" tem DADOS REAIS (bloco "BAYESIAN (DADOS REAIS...)"): use exatamente os valores fornecidos (histórico, prior/posterior Beta, win rate MAP, P(>50%)). NÃO marque como estimativa, NÃO recalcule. Apenas a seção "IMPACTO NA POSIÇÃO" usa valores ilustrativos marcados com "(est.)".'
    : '- As seções "IMPACTO NA POSIÇÃO" e "BAYESIAN UPDATE" exigem dados que NÃO foram fornecidos (posição do operador, histórico de trades). Preencha-as com valores ILUSTRATIVOS plausíveis, mas marque cada número estimado com "(est.)" e abra a seção com a linha: "⚠️ Valores ilustrativos — informe sua posição/histórico reais para cálculo exato."';

  const bayesSection = temBayesReal
    ? `📈 BAYESIAN UPDATE
Histórico, Prior → Posterior (Beta), win rate MAP e P(estratégia > 50% de acerto) — use EXATAMENTE os valores do bloco "BAYESIAN (DADOS REAIS...)". Comente em 1 frase a confiança na estratégia.`
    : `📈 BAYESIAN UPDATE (est.)
⚠️ Valores ilustrativos.
Prior/Posterior (Beta), win rate MAP e nível de confiança — marcando "(est.)".`;

  const userPrompt = `Você é um analista quantitativo de opções da B3. Produza uma análise OPERACIONAL e ACIONÁVEL desta opção, seguindo EXATAMENTE o formato estruturado abaixo (mesmas seções, emojis e ordem). Data de hoje: ${hoje}.

REGRAS DE DADOS (muito importante):
- Os "dados reais" abaixo (strikes, prêmio/último, bid/ask, volume, open interest, IV, gregas, BS teórico, P(exercício), preço do ativo, dias até vencimento) são fatos já calculados — use-os exatamente como vieram. NÃO recalcule BS teórico nem P(exercício); apenas formate os valores fornecidos (BS teórico em R$, P(exercício) em %).
- A tabela da seção RECOMENDAÇÃO deve conter TODAS as opções da CADEIA fornecida, uma linha por strike, ordenadas por strike. Marque com ★ a opção em foco (a selecionada pelo usuário).
${bayesRule}
- Para o "ALERTA", cite eventos macro relevantes (ex.: reunião do COPOM) apenas se a data for de seu conhecimento; caso contrário descreva o tipo de risco de evento sem inventar a data exata, marcando "(verificar data)".

FORMATO DE SAÍDA (preencha com os dados fornecidos):

DADOS REAIS CONFIRMADOS — [série/vencimento]
[TICKER ATIVO]: R$[preço] | Vencimento: [data]

🎯 RECOMENDAÇÃO
Tabela com colunas: Opção | Strike | Último | Ask | BS Teórico | P(Exercício)
(uma linha para CADA strike da cadeia fornecida; ★ na opção em foco). Após a tabela, em 1-2 frases, aponte qual strike oferece o melhor risco/retorno e por quê.

📋 ORDEM
Bloco para a opção em foco (★): tipo de ordem sugerida (venda/compra a limite conforme o perfil), Strike, Vencimento, Preço/ação (use o Ask real), Total estimado (× lote), e um "Destaque" comparando o Ask real com o BS teórico (acima/abaixo do valor justo).

📊 IMPACTO NA POSIÇÃO (est.)
⚠️ Valores ilustrativos — informe sua posição/histórico reais para cálculo exato.
Tabela: Métrica | Antes | Depois — com prêmios acumulados, custo efetivo/ação, break-even e P&L MtM (todos marcados "(est.)").

🚨 ALERTA
Riscos de evento (macro/COPOM/liquidez/vencimento) e o que monitorar antes do vencimento.

${bayesSection}

Resumo executivo: 2-3 frases objetivas com a leitura final.

Use linguagem técnica e direta, em português. Não invente dados de mercado: só os campos de posição/histórico podem ser estimados, e sempre marcados.

DADOS REAIS:
${context}`;

  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterApiKey) {
    throw new Error('OPENROUTER_API_KEY não configurada');
  }

  let lastErr = '';
  let dataPolicyHit = false;

  for (const model of AI_MODELS) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openrouterApiKey}`,
        'HTTP-Referer': 'https://b3-penny-stock-analyzer.vercel.app',
        'X-Title': 'B3 Penny Stock Analyzer',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.5,
        max_tokens: 2200,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (response.ok) {
      const data = await response.json();
      const text = data.choices?.[0]?.message?.content ?? '';
      if (text) return { analise: text };
      lastErr = `Modelo ${model} retornou resposta vazia.`;
      continue;
    }

    const errData = await response.text();
    lastErr = `Modelo ${model} → ${response.status}: ${errData}`;
    console.error(`[analyze] ${lastErr}`);

    // 404 "No endpoints found ... data policy" = falta habilitar publicação de dados (modelos :free).
    if (response.status === 404 && /data policy|No endpoints/i.test(errData)) {
      dataPolicyHit = true;
    }
    // 401/403 = chave inválida/sem permissão: não adianta tentar outros modelos.
    if (response.status === 401 || response.status === 403) break;
    // Demais erros (404 de modelo, 429, etc.): tenta o próximo modelo da lista.
  }

  if (dataPolicyHit) {
    throw new Error(
      'Nenhum modelo gratuito disponível: habilite "Free model publication" em ' +
      'https://openrouter.ai/settings/privacy (necessário para modelos :free) ' +
      'ou defina OPENROUTER_MODEL para um modelo pago. Detalhe: ' + lastErr,
    );
  }
  throw new Error(`Falha na OpenRouter após tentar ${AI_MODELS.length} modelo(s). ${lastErr}`);
}

// Bull Queue para fila de análises
// Processa 1 análise por vez para evitar sobrecarregar a API de IA
let analysisQueue: Queue.Queue<any> | null = null;

async function initializeAnalysisQueue() {
  try {
    // Tenta conectar ao Redis
    // NOTA: Render free tier NÃO fornece Redis. Use bull-board para Render pro+.
    // Para agora, este é apenas um fallback opcional. Se falhar, usa análise direta.
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = Number(process.env.REDIS_PORT || 6379);

    analysisQueue = new Queue('option-analysis', {
      redis: {
        host: redisHost,
        port: redisPort,
        maxRetriesPerRequest: null, // Evita "Reached the max retries per request limit"
      },
      defaultJobOptions: {
        attempts: 2,                    // 2 tentativas
        backoff: {
          type: 'exponential',
          delay: 2000,                  // começa com 2s
        },
        removeOnComplete: true,         // remove job após sucesso
        removeOnFail: false,            // mantém falhas para debug
      },
    });

    // Processa análises: 1 por vez (concurrency: 1)
    analysisQueue.process(1, async (job) => {
      return analisarOpcao(job.data.payload);
    });

    console.log('✅ Bull Queue inicializado (conectado ao Redis)');
  } catch (err: any) {
    console.warn('⚠️  Redis não disponível. Usando modo fallback (sem fila):', err.message);
    analysisQueue = null;
  }
}

// Inicializa queue na startup
initializeAnalysisQueue();

// ---------------------------------------------------------------------------
// CORS — origens permitidas
// ---------------------------------------------------------------------------
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173', // Vite dev server
  process.env.ALLOWED_ORIGIN ?? '',
].filter(Boolean);

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------
app.use(express.json());

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin ?? '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readStocks(): object | null {
  if (!existsSync(STOCKS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STOCKS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

let updateInProgress = false;

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

function runUpdateScript(
  extraArgs: string[] = [],
  callback: (err: ExecException | null, stdout: string, stderr: string) => void
) {
  const scriptPath = path.join(ROOT_DIR, 'scripts', 'update_stocks.py');
  const args = extraArgs.join(' ');
  exec(
    `${PYTHON} "${scriptPath}" ${args}`.trim(),
    { cwd: ROOT_DIR, timeout: 10 * 60 * 1000 }, // 10 min máx
    callback
  );
}

// ---------------------------------------------------------------------------
// GET /api/stocks
// ---------------------------------------------------------------------------
app.get('/api/stocks', (req: Request, res: Response) => {
  const data = readStocks();
  if (!data) {
    res.status(404).json({
      error: 'Dados não disponíveis. Chame POST /api/update para gerar.',
    });
    return;
  }
  res.json(data);
});

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------
app.get('/api/status', (req: Request, res: Response) => {
  const data = readStocks() as any;
  if (!data) {
    res.json({ disponivel: false, updateInProgress });
    return;
  }
  res.json({
    disponivel: true,
    atualizadoEm: data.atualizadoEm ?? null,
    dataReferencia: data.dataReferencia ?? null,
    fonte: data.fonte ?? null,
    totalAcoes: data.totalAcoes ?? 0,
    updateInProgress,
  });
});

// ---------------------------------------------------------------------------
// GET /api/options/:ticker
// ---------------------------------------------------------------------------
app.get('/api/options/:ticker', (req: Request, res: Response) => {
  const ticker = req.params.ticker.toUpperCase();
  const prefix = ticker.slice(0, 4);

  if (!existsSync(COTAHIST_FILE)) {
    res.json({ opcoes: [] });
    return;
  }

  try {
    const cotahist = JSON.parse(readFileSync(COTAHIST_FILE, 'utf-8'));
    const allOpts: any[] = cotahist.opcoes ?? [];
    const today = new Date().toISOString().slice(0, 10);

    // Filtra opções futuras para este ticker
    const matched = allOpts.filter((o: any) => {
      const obj = String(o.ticker_objeto ?? '').toUpperCase();
      return obj === ticker && o.vencimento >= today;
    });

    // Seleciona próximos 8 vencimentos por tipo (CALL e PUT separados)
    const result: any[] = [];
    for (const tipo of ['CALL', 'PUT']) {
      const tipoOpts = matched.filter((o: any) => o.tipo === tipo);
      if (tipoOpts.length === 0) continue;
      const vencimentos = [...new Set(tipoOpts.map((o: any) => o.vencimento))].sort();
      for (const v of vencimentos.slice(0, 8)) {
        result.push(...tipoOpts.filter((o: any) => o.vencimento === v));
      }
    }

    // Ordena por vencimento e depois por strike
    result.sort((a: any, b: any) => {
      if (a.vencimento !== b.vencimento) {
        return a.vencimento.localeCompare(b.vencimento);
      }
      return (a.strike ?? 0) - (b.strike ?? 0);
    });

    res.json({ opcoes: result });
  } catch {
    res.json({ opcoes: [] });
  }
});

// ---------------------------------------------------------------------------
// GET /api/options/:ticker/live  – Bid/Ask em tempo real via yfinance (~15min)
// ---------------------------------------------------------------------------
app.get('/api/options/:ticker/live', (req: Request, res: Response) => {
  const ticker = req.params.ticker.toUpperCase();
  const script = path.join(ROOT_DIR, 'scripts', 'fetch_option_live.py');

  if (!existsSync(script)) {
    res.status(404).json({ error: 'Script de dados ao vivo não encontrado.', opcoes: [] });
    return;
  }

  const python = process.platform === 'win32' ? 'python' : 'python3';
  const proc = spawn(python, [script, ticker]);

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

  const timeout = setTimeout(() => {
    proc.kill();
    if (!res.headersSent) {
      res.status(504).json({ error: 'Timeout ao buscar dados ao vivo.', opcoes: [] });
    }
  }, 30_000);

  proc.on('close', () => {
    clearTimeout(timeout);
    if (res.headersSent) return;
    try {
      const data = JSON.parse(stdout);
      res.json(data);
    } catch {
      res.status(500).json({ error: 'Falha ao processar resposta do Python.', detalhe: stderr.slice(0, 500), opcoes: [] });
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/options/analyze – Análise IA via OpenRouter (com Rate Limit + Fila)
// ✨ PROBLEMA 2: Rate limiting (30 req/15min)
// ✨ PROBLEMA 3: Fila Bull Queue (1 por vez)
// ---------------------------------------------------------------------------
app.post('/api/options/analyze', analyzeRateLimiter, async (req: Request, res: Response) => {
  const { opt, stockPrice, stockTicker } = req.body;
  if (!opt || !stockPrice || !stockTicker) {
    res.status(400).json({ error: 'Parâmetros insuficientes.' });
    return;
  }

  // Se Bull Queue está disponível, processa via fila
  if (analysisQueue) {
    try {
      const job = await analysisQueue.add(
        { payload: req.body },
        {
          priority: 5, // Jobs com análise menos urgentes
          timeout: 65_000, // 65s timeout no worker
        }
      );

      console.log(`[queue] Job ${job.id} adicionado à fila`);

      // Aguarda resultado com timeout
      const result = await Promise.race([
        job.finished(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Job timeout')), 65_000)
        ),
      ]);

      res.json(result);
      return;
    } catch (err: any) {
      console.error('[queue] Erro:', err.message);
      // Fallback: processa diretamente sem fila
    }
  }

  // Fallback: processa diretamente (sem Redis disponível)
  try {
    const result = await analisarOpcao(req.body);
    res.json(result);
  } catch (err: any) {
    console.error('[analyze] Erro:', err.message);
    const errorMsg = err.message ?? 'desconhecido';
    res.status(500).json({
      error: `Erro ao conectar ao OpenRouter: ${errorMsg}. Verifique se a API key está configurada.`,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/update
// ---------------------------------------------------------------------------
app.post('/api/update', (req: Request, res: Response) => {
  if (updateInProgress) {
    res.status(409).json({ error: 'Atualização já em andamento. Aguarde.' });
    return;
  }

  const maxPreco: string = req.body?.maxPreco ? String(req.body.maxPreco) : '10.0';
  const ticker: string | undefined = req.body?.ticker ? String(req.body.ticker) : undefined;
  updateInProgress = true;
  res.json({ success: true, mensagem: 'Atualização iniciada. Consulte GET /api/status.' });

  const args: string[] = [`--max-preco ${maxPreco}`];
  if (ticker) {
    args.push(`--ticker ${ticker}`);
  }

  runUpdateScript(args, (err, stdout, stderr) => {
    updateInProgress = false;
    if (err) {
      console.error('[update] Erro:', stderr || err.message);
    } else {
      console.log('[update] Concluído.');
      if (stdout) console.log(stdout.trim());
    }
  });
});

// ---------------------------------------------------------------------------
// Serve o build do React em produção
// ---------------------------------------------------------------------------
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// ---------------------------------------------------------------------------
// Auto-atualização periódica (a cada 30 min em horário de pregão)
// ---------------------------------------------------------------------------
const UPDATE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutos

function isTradinghours(): boolean {
  const now = new Date();
  // Pregão B3: 10:00–18:20 BRT (UTC-3) → 13:00–21:20 UTC
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const total = utcH * 60 + utcM;
  return total >= 13 * 60 && total <= 21 * 60 + 20;
}

setInterval(() => {
  if (updateInProgress || !isTradinghours()) return;
  console.log('[auto-update] Iniciando atualização programada...');
  updateInProgress = true;
  runUpdateScript([], (err, _stdout, stderr) => {
    updateInProgress = false;
    if (err) console.error('[auto-update] Falha:', stderr || err.message);
    else console.log('[auto-update] Concluído.');
  });
}, UPDATE_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n🚀 API rodando em http://localhost:${PORT}`);
  console.log(`   GET  http://localhost:${PORT}/api/stocks`);
  console.log(`   POST http://localhost:${PORT}/api/update`);
  console.log(`   GET  http://localhost:${PORT}/api/status`);
  console.log(`   POST http://localhost:${PORT}/api/options/analyze (com rate limiting + fila)`);
  console.log(`   Auto-update: a cada 30 min (horário de pregão)`);
  console.log(`   IA: OpenRouter (${AI_MODEL})\n`);

  // Se não há dados (ex: reinício do servidor no Render), dispara update automático
  if (!existsSync(STOCKS_FILE)) {
    console.log('[startup] stocks.json ausente — iniciando atualização automática...');
    updateInProgress = true;
    runUpdateScript([], (err, _stdout, stderr) => {
      updateInProgress = false;
      if (err) console.error('[startup] Falha:', stderr || err.message);
      else console.log('[startup] Dados gerados com sucesso.');
    });
  }
});
