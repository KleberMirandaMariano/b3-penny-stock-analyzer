/**
 * server/index.ts
 * ================
 * API Express para o B3 Penny Stock Analyzer.
 *
 * Endpoints:
 *   GET  /api/stocks          – Retorna public/stocks.json
 *   POST /api/update          – Dispara python3 scripts/update_stocks.py
 *   GET  /api/status          – Metadados sobre os dados (fonte, data, total)
 *   POST /api/options/analyze – Análise IA via Ollama (com rate limiting + fila)
 *
 * Em produção também serve o build do React (dist/).
 * Em desenvolvimento o Vite proxia /api → porta 3001.
 *
 * ✨ Melhorias:
 *   - PROBLEMA 1: Timeout frontend sincronizado (70s alinhado com backend 60s)
 *   - PROBLEMA 2: Rate limiting (30 req/15min por IP) no /api/options/analyze
 *   - PROBLEMA 3: Fila de análises (Bull Queue + Redis) para processar sequencial
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

// Bull Queue para fila de análises
// Processa 1 análise por vez para evitar sobrecarga do Ollama
let analysisQueue: Queue.Queue<any> | null = null;

async function initializeAnalysisQueue() {
  try {
    // Tenta conectar ao Redis
    analysisQueue = new Queue('option-analysis', {
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
        maxRetriesPerRequest: null,  // Evita "Reached the max retries per request limit (which is 20)"
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
      const { payload, ollamaUrl, ollamaModel } = job.data;

      const { opt, stockPrice, stockTicker, greeks, iv, daysToExpiry, liveData } = payload;

      const moneyness = opt.tipo === 'CALL'
        ? (stockPrice > (opt.strike ?? 0) ? 'ITM' : stockPrice < (opt.strike ?? 0) ? 'OTM' : 'ATM')
        : (stockPrice < (opt.strike ?? 0) ? 'ITM' : stockPrice > (opt.strike ?? 0) ? 'OTM' : 'ATM');

      const context = [
        `Ativo subjacente: ${stockTicker} (preço atual: R$ ${Number(stockPrice).toFixed(2)})`,
        `Opção: ${opt.ticker} — ${opt.tipo} (${opt.tipo === 'CALL' ? 'Direito de Compra' : 'Direito de Venda'})`,
        `Strike: R$ ${Number(opt.strike).toFixed(2)} | Prêmio: R$ ${Number(opt.preco).toFixed(2)}`,
        `Status: ${moneyness} (${moneyness === 'ITM' ? 'no dinheiro' : moneyness === 'ATM' ? 'na batida' : 'fora do dinheiro'})`,
        daysToExpiry != null ? `Dias até vencimento: ${daysToExpiry}` : null,
        iv != null ? `Volatilidade Implícita: ${(Number(iv) * 100).toFixed(1)}%` : null,
        greeks ? `Delta: ${Number(greeks.delta).toFixed(4)} | Gamma: ${Number(greeks.gamma).toFixed(4)} | Theta/dia: ${Number(greeks.theta).toFixed(4)} | Vega/1%: ${Number(greeks.vega).toFixed(4)}` : null,
        liveData?.bid != null ? `Bid: R$ ${Number(liveData.bid).toFixed(2)} | Ask: R$ ${Number(liveData.ask).toFixed(2)}` : null,
        liveData?.volume != null ? `Volume: ${liveData.volume} | Open Interest: ${liveData.openInterest ?? '—'}` : null,
      ].filter(Boolean).join('\n');

      const userPrompt = `Você é um analista de opções da B3. Analise brevemente esta opção com base nos dados abaixo e forneça:
1. Uma avaliação objetiva do perfil risco/retorno
2. O que as gregas indicam sobre o comportamento da opção
3. Um ponto de atenção relevante para o operador

Seja conciso (máximo 4 parágrafos curtos). Use linguagem técnica mas acessível. Não faça recomendação de compra/venda.

Dados:
${context}`;

      const response = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          messages: [{ role: 'user', content: userPrompt }],
          stream: false,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        throw new Error(`Ollama retornou ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const text = data.message?.content ?? '';
      return { analise: text };
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
// POST /api/options/analyze – Análise IA via Ollama (com Rate Limit + Fila)
// ✨ PROBLEMA 2: Rate limiting (30 req/15min)
// ✨ PROBLEMA 3: Fila Bull Queue (1 por vez)
// ---------------------------------------------------------------------------
app.post('/api/options/analyze', analyzeRateLimiter, async (req: Request, res: Response) => {
  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const ollamaModel = process.env.OLLAMA_MODEL ?? 'llama2';

  const { opt, stockPrice, stockTicker, greeks, iv, daysToExpiry, liveData } = req.body;
  if (!opt || !stockPrice || !stockTicker) {
    res.status(400).json({ error: 'Parâmetros insuficientes.' });
    return;
  }

  // Se Bull Queue está disponível, processa via fila
  if (analysisQueue) {
    try {
      const job = await analysisQueue.add(
        { payload: req.body, ollamaUrl, ollamaModel },
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
  const moneyness = opt.tipo === 'CALL'
    ? (stockPrice > (opt.strike ?? 0) ? 'ITM' : stockPrice < (opt.strike ?? 0) ? 'OTM' : 'ATM')
    : (stockPrice < (opt.strike ?? 0) ? 'ITM' : stockPrice > (opt.strike ?? 0) ? 'OTM' : 'ATM');

  const context = [
    `Ativo subjacente: ${stockTicker} (preço atual: R$ ${Number(stockPrice).toFixed(2)})`,
    `Opção: ${opt.ticker} — ${opt.tipo} (${opt.tipo === 'CALL' ? 'Direito de Compra' : 'Direito de Venda'})`,
    `Strike: R$ ${Number(opt.strike).toFixed(2)} | Prêmio: R$ ${Number(opt.preco).toFixed(2)}`,
    `Status: ${moneyness} (${moneyness === 'ITM' ? 'no dinheiro' : moneyness === 'ATM' ? 'na batida' : 'fora do dinheiro'})`,
    daysToExpiry != null ? `Dias até vencimento: ${daysToExpiry}` : null,
    iv != null ? `Volatilidade Implícita: ${(Number(iv) * 100).toFixed(1)}%` : null,
    greeks ? `Delta: ${Number(greeks.delta).toFixed(4)} | Gamma: ${Number(greeks.gamma).toFixed(4)} | Theta/dia: ${Number(greeks.theta).toFixed(4)} | Vega/1%: ${Number(greeks.vega).toFixed(4)}` : null,
    liveData?.bid != null ? `Bid: R$ ${Number(liveData.bid).toFixed(2)} | Ask: R$ ${Number(liveData.ask).toFixed(2)}` : null,
    liveData?.volume != null ? `Volume: ${liveData.volume} | Open Interest: ${liveData.openInterest ?? '—'}` : null,
  ].filter(Boolean).join('\n');

  const userPrompt = `Você é um analista de opções da B3. Analise brevemente esta opção com base nos dados abaixo e forneça:
1. Uma avaliação objetiva do perfil risco/retorno
2. O que as gregas indicam sobre o comportamento da opção
3. Um ponto de atenção relevante para o operador

Seja conciso (máximo 4 parágrafos curtos). Use linguagem técnica mas acessível. Não faça recomendação de compra/venda.

Dados:
${context}`;

  try {
    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [{ role: 'user', content: userPrompt }],
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`Ollama retornou ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const text = data.message?.content ?? '';
    res.json({ analise: text });
  } catch (err: any) {
    console.error('[analyze] Erro:', err.message);
    const errorMsg = err.message ?? 'desconhecido';
    res.status(500).json({
      error: `Erro ao conectar ao Ollama em ${ollamaUrl}: ${errorMsg}. Verifique se a VPS está ativa.`,
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
  console.log(`   Ollama: ${process.env.OLLAMA_URL || 'http://localhost:11434'}\n`);

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
