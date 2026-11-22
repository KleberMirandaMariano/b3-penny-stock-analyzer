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

// Modelo usado para a análise IA via OpenRouter.
// OPENROUTER_MODEL (opcional) fixa um modelo, que é sempre tentado primeiro.
const AI_MODEL_ENV = process.env.OPENROUTER_MODEL?.trim() || null;

// Preferência entre os modelos gratuitos, quando estiverem disponíveis.
// A OpenRouter muda o catálogo :free com frequência, então esta lista é só a ordem
// de preferência: a lista real vem de GET /api/v1/models (ver getModelCandidates).
const PREFERRED_FREE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'google/gemma-4-26b-a4b-it:free',
  'openai/gpt-oss-120b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
];
const MAX_MODEL_ATTEMPTS = 6;
const MIN_CONTEXT = 32_000;
const MODELS_CACHE_MS = 60 * 60 * 1000; // 1h

let freeModelsCache: { ids: string[]; at: number } | null = null;

/** Lista os modelos gratuitos de texto disponíveis agora na OpenRouter (com cache de 1h). */
async function fetchFreeModels(): Promise<string[]> {
  if (freeModelsCache && Date.now() - freeModelsCache.at < MODELS_CACHE_MS) {
    return freeModelsCache.ids;
  }
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    const ids: string[] = (body.data ?? [])
      .filter((m: any) => {
        const id = String(m.id ?? '');
        const free = id.endsWith(':free') ||
          (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
        const out: string[] = m.architecture?.output_modalities ?? ['text'];
        const inp: string[] = m.architecture?.input_modalities ?? ['text'];
        return free && out.includes('text') && inp.includes('text') &&
          Number(m.context_length ?? 0) >= MIN_CONTEXT;
      })
      .map((m: any) => String(m.id));
    freeModelsCache = { ids, at: Date.now() };
    console.log(`[models] ${ids.length} modelos gratuitos disponíveis na OpenRouter`);
    return ids;
  } catch (err: any) {
    console.warn('[models] Falha ao listar modelos da OpenRouter:', err.message);
    return freeModelsCache?.ids ?? [];
  }
}

/** Ordem de tentativa: modelo fixado > preferidos disponíveis > demais gratuitos. */
async function getModelCandidates(): Promise<string[]> {
  const available = await fetchFreeModels();
  const preferred = available.length > 0
    ? PREFERRED_FREE_MODELS.filter((m) => available.includes(m))
    : PREFERRED_FREE_MODELS; // catálogo indisponível: tenta a lista fixa
  const ordered = [
    ...(AI_MODEL_ENV ? [AI_MODEL_ENV] : []),
    ...preferred,
    ...available,
  ];
  return Array.from(new Set(ordered)).slice(0, MAX_MODEL_ATTEMPTS + (AI_MODEL_ENV ? 1 : 0));
}

/** Remove um modelo do cache quando a OpenRouter diz que ele não está mais disponível. */
function forgetModel(id: string) {
  if (freeModelsCache) freeModelsCache.ids = freeModelsCache.ids.filter((m) => m !== id);
}

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
    sensitivity?: { rho: number; nEff: number; probOver50: number }[];
  } | null;
}

// ---------------------------------------------------------------------------
// Análise estruturada (JSON) devolvida pela IA
// ---------------------------------------------------------------------------
type Veredito = 'COMPRAR' | 'VENDER' | 'EVITAR' | 'AGUARDAR';
type Confianca = 'BAIXA' | 'MEDIA' | 'ALTA';

interface AnaliseEstruturada {
  veredito: Veredito;
  confianca: Confianca;
  manchete: string;
  resumo: string;
  melhorStrike: string | null;
  motivoStrike: string | null;
  aFavor: string[];
  contra: string[];
  monitorar: string[];
}

function parseAnaliseJson(raw: string): AnaliseEstruturada | null {
  const semCerca = raw.replace(/```(?:json)?/gi, '');
  const ini = semCerca.indexOf('{');
  const fim = semCerca.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  let obj: any;
  try { obj = JSON.parse(semCerca.slice(ini, fim + 1)); } catch { return null; }

  const norm = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
  const veredito = norm(obj.veredito) as Veredito;
  if (!['COMPRAR', 'VENDER', 'EVITAR', 'AGUARDAR'].includes(veredito)) return null;
  const c = norm(obj.confianca);
  const confianca: Confianca = c === 'ALTA' ? 'ALTA' : c === 'BAIXA' ? 'BAIXA' : 'MEDIA';
  const txt = (v: unknown, max: number) => {
    const t = typeof v === 'string' ? v.trim() : '';
    return t && t.toLowerCase() !== 'null' ? t.slice(0, max) : null;
  };
  const lista = (v: unknown) =>
    (Array.isArray(v) ? v : []).map((x) => txt(x, 120)).filter((x): x is string => !!x).slice(0, 3);

  return {
    veredito,
    confianca,
    manchete: txt(obj.manchete, 140) ?? '',
    resumo: txt(obj.resumo, 400) ?? '',
    melhorStrike: txt(obj.melhorStrike, 30),
    motivoStrike: txt(obj.motivoStrike, 200),
    aFavor: lista(obj.aFavor),
    contra: lista(obj.contra),
    monitorar: lista(obj.monitorar),
  };
}

/** Versão em texto simples (compatibilidade com clientes antigos). */
function analiseParaTexto(a: AnaliseEstruturada): string {
  const bloco = (titulo: string, itens: string[]) => itens.length ? `${titulo}\n${itens.map((i) => `• ${i}`).join('\n')}` : null;
  return [
    `${a.veredito} (confiança ${a.confianca.toLowerCase()}) — ${a.manchete}`,
    a.resumo,
    a.melhorStrike ? `Melhor strike: ${a.melhorStrike}${a.motivoStrike ? ` — ${a.motivoStrike}` : ''}` : null,
    bloco('A favor', a.aFavor),
    bloco('Contra', a.contra),
    bloco('Monitorar', a.monitorar),
  ].filter(Boolean).join('\n\n');
}

async function analisarOpcao(payload: AnalyzePayload): Promise<{ analise: string; estruturada?: AnaliseEstruturada; modelo?: string }> {
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
    'CADEIA (mesmo tipo e vencimento; ★ = opção em foco):',
    'Opção | Strike | Último | Ask | BS Teórico | P(Exercício)',
    ...chain.map((r) =>
      `${r.ticker}${r.focus ? ' ★' : ''} | ${fmt(r.strike)} | ${fmt(r.ultimo)} | ${fmt(r.ask)} | ${fmt(r.bsTeorico)} | ${pct(r.pExercicio)}`
    ),
  ].join('\n');

  const focus = chain.find((r) => r.focus) ?? chain[0];

  // Bloco Bayesian: usa histórico real quando fornecido
  const temBayesReal = bayesian != null && (bayesian.wins > 0 || bayesian.losses > 0);
  const sens = bayesian?.sensitivity ?? [];
  const bayesBlock = temBayesReal
    ? [
        'BAYESIAN (histórico real da estratégia):',
        `Histórico: ${bayesian!.wins}W / ${bayesian!.losses}L`,
        `Prior Beta(${bayesian!.priorAlpha}, ${bayesian!.priorBeta}) → Posterior Beta(${bayesian!.posteriorAlpha}, ${bayesian!.posteriorBeta})`,
        `Win rate MAP: ${pct(bayesian!.winRateMap)} | P(estratégia > 50% de acerto): ${pct(bayesian!.probOver50)} (assume trades INDEPENDENTES)`,
        sens.length > 0
          ? 'Sensibilidade à correlação entre trades — P(acerto > 50%): ' +
            sens.map((s) => `ρ=${s.rho.toFixed(1)} → ${pct(s.probOver50)} (n_ef ${s.nEff.toFixed(1)})`).join(' | ')
          : null,
        'Obs.: assume trades independentes; com correlação (ρ>0) a confiança real é menor. Win rate ≠ edge.',
      ].filter((l) => l != null).join('\n')
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

  // A IA devolve só o julgamento (veredito + motivos) em JSON curto.
  // Os números (cadeia, BS, P(exercício), Bayes) já vêm calculados e o frontend os exibe direto.
  const userPrompt = `Você é um analista quantitativo de opções da B3. Data de hoje: ${hoje}.
Avalie a opção em foco (★) usando SOMENTE os dados abaixo e responda APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois.

Formato exato:
{
  "veredito": "COMPRAR" | "VENDER" | "EVITAR" | "AGUARDAR",
  "confianca": "BAIXA" | "MEDIA" | "ALTA",
  "manchete": "frase de até 90 caracteres com a leitura principal",
  "resumo": "no máximo 2 frases objetivas",
  "melhorStrike": "ticker da cadeia com melhor risco/retorno, ou null",
  "motivoStrike": "1 frase curta explicando o melhorStrike, ou null",
  "aFavor": ["até 3 itens curtos (máx. 70 caracteres cada)"],
  "contra": ["até 3 itens curtos (máx. 70 caracteres cada)"],
  "monitorar": ["até 3 gatilhos objetivos, ex.: 'COGN3 abaixo de R$ 1,52'"]
}

Regras:
- "VENDER" = lançar/vender a opção; "COMPRAR" = comprar a opção; "EVITAR" = não operar; "AGUARDAR" = esperar um gatilho.
- Não invente números de mercado, posição do operador ou histórico de trades. Use apenas os dados fornecidos.
- Sem Ask/Bid ou com volume baixo, trate liquidez como risco explícito.
- Eventos macro (ex.: COPOM) só com data se você tiver certeza; senão escreva "(verificar data)".
${temBayesReal ? '- Há histórico real da estratégia (bloco BAYESIAN): considere-o e lembre que win rate alto não garante expectância positiva.' : ''}
- Português do Brasil, linguagem direta.

DADOS REAIS:
${context}`;

  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterApiKey) {
    throw new Error('OPENROUTER_API_KEY não configurada');
  }

  const models = await getModelCandidates();
  if (models.length === 0) {
    throw new Error('Nenhum modelo gratuito disponível na OpenRouter no momento. Defina OPENROUTER_MODEL para um modelo pago.');
  }

  const errors: string[] = [];
  let dataPolicyHit = false;
  let textoBruto: { analise: string; modelo: string } | null = null;
  const deadline = Date.now() + 60_000; // orçamento total, alinhado ao timeout do frontend

  // Fila de tentativas: modelos com 429 (congestionados) voltam uma vez para o fim da fila
  const queue = [...models];
  const retried = new Set<string>();
  while (queue.length > 0) {
    const model = queue.shift()!;
    if (retried.has(model)) await new Promise((r) => setTimeout(r, 3_000));
    const remaining = deadline - Date.now();
    if (remaining < 5_000) { errors.push('tempo esgotado'); break; }

    let response: globalThis.Response;
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openrouterApiKey}`,
          'HTTP-Referer': 'https://analisekmm.tech',
          'X-Title': 'B3 Penny Stock Analyzer',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: userPrompt }],
          temperature: 0.3,
          // Modelos de raciocínio (ex.: Nemotron) gastam tokens "pensando" antes de responder:
          // limite folgado + esforço baixo evita resposta vazia por estouro de tokens.
          max_tokens: 4000,
          reasoning: { effort: 'low' },
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(Math.min(45_000, remaining)),
      });
    } catch (err: any) {
      errors.push(`${model}: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
      console.error(`[analyze] ${model} → ${err.message}`);
      continue;
    }

    if (response.ok) {
      const data = await response.json();
      const choice = data.choices?.[0];
      // Alguns provedores devolvem o JSON no campo de raciocínio quando o conteúdo vem vazio
      const text = choice?.message?.content || (parseAnaliseJson(choice?.message?.reasoning ?? '') ? choice.message.reasoning : '');
      if (text) {
        const estruturada = parseAnaliseJson(text);
        if (estruturada) {
          console.log(`[analyze] OK com ${model}`);
          return { analise: analiseParaTexto(estruturada), estruturada, modelo: model };
        }
        // Modelo não respeitou o JSON: guarda o texto como último recurso e tenta o próximo
        textoBruto ??= { analise: text, modelo: model };
        errors.push(`${model}: resposta fora do formato JSON`);
        continue;
      }
      errors.push(`${model}: resposta vazia${choice?.finish_reason ? ` (${choice.finish_reason})` : ''}`);
      continue;
    }

    const errData = await response.text();
    let msg = errData;
    try { msg = JSON.parse(errData)?.error?.message ?? errData; } catch { /* texto puro */ }
    errors.push(`${model} (${response.status}): ${String(msg).slice(0, 160)}`);
    console.error(`[analyze] ${model} → ${response.status}: ${msg}`);

    // 404 "No endpoints found ... data policy" = falta habilitar publicação de dados (modelos :free).
    if (response.status === 404 && /data policy/i.test(errData)) dataPolicyHit = true;
    // Modelo saiu do catálogo gratuito: tira do cache para não tentar de novo.
    if (response.status === 404) forgetModel(model);
    // 401/403 = chave inválida/sem permissão: não adianta tentar outros modelos.
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Chave da OpenRouter recusada (${response.status}): ${String(msg).slice(0, 200)}`);
    }
    if (response.status === 429 && !retried.has(model)) {
      retried.add(model);
      queue.push(model);
    }
    // Demais erros (404, 429, 5xx): tenta o próximo modelo.
  }

  if (textoBruto) return textoBruto;

  if (dataPolicyHit) {
    throw new Error(
      'Nenhum modelo gratuito disponível: habilite "Free model publication" em ' +
      'https://openrouter.ai/settings/privacy (necessário para modelos :free) ' +
      'ou defina OPENROUTER_MODEL para um modelo pago. Detalhes: ' + errors.join(' | '),
    );
  }
  throw new Error(`Nenhum modelo da OpenRouter respondeu (${errors.length} tentativa(s)): ${errors.join(' | ')}`);
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
        attempts: 1,                    // o fallback entre modelos já acontece dentro de analisarOpcao
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
  // ALLOWED_ORIGIN aceita várias origens separadas por vírgula
  ...(process.env.ALLOWED_ORIGIN ?? '').split(',').map((o) => o.trim().replace(/\/$/, '')),
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
// GET /api/me – usuário logado (header injetado pelo traefik-forward-auth)
// ---------------------------------------------------------------------------
app.get('/api/me', (req: Request, res: Response) => {
  const email = req.header('x-forwarded-user') ?? null;
  res.json({ email, logoutUrl: email ? '/_oauth/logout' : null });
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
// GET /api/options/:ticker/quant – Camada quant (financial-analysis-framework)
// VI, delta, preço justo, P(exercício), regime bayesiano e Monte Carlo.
// O script guarda o resultado por ativo/dia em data/quant/.
// ---------------------------------------------------------------------------
const quantInFlight = new Map<string, Promise<any>>();
const QUANT_HARD_LIMIT_MS = 20 * 60_000; // download do histórico da B3 pode levar minutos
const QUANT_RESPONSE_WAIT_MS = 25_000;  // depois disso a página recebe "preparando"

function runQuant(arg: string): Promise<any> {
  const script = path.join(ROOT_DIR, 'scripts', 'options_quant.py');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  return new Promise((resolve) => {
    if (!existsSync(script)) {
      resolve({ disponivel: false, motivo: 'Script options_quant.py não encontrado.' });
      return;
    }
    const proc = spawn(python, [script, arg]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    // Só um limite de segurança: o processo NÃO é morto quando a página desiste
    // de esperar, para que o download do histórico termine e fique em cache.
    const timeout = setTimeout(() => {
      proc.kill();
      resolve({ disponivel: false, motivo: 'Tempo esgotado no cálculo quant.' });
    }, QUANT_HARD_LIMIT_MS);
    proc.on('close', () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(stdout.trim().split('\n').pop() ?? ''));
      } catch {
        console.error('[quant] saída inválida:', stderr.slice(-500));
        resolve({ disponivel: false, motivo: 'Falha ao processar o cálculo quant.' });
      }
    });
  });
}

function quantJob(key: string): Promise<any> {
  let job = quantInFlight.get(key);
  if (!job) {
    job = runQuant(key).finally(() => quantInFlight.delete(key));
    quantInFlight.set(key, job);
  }
  return job;
}

app.get('/api/options/:ticker/quant', async (req: Request, res: Response) => {
  const ticker = req.params.ticker.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!ticker) {
    res.status(400).json({ disponivel: false, motivo: 'Ticker inválido.' });
    return;
  }
  // Pedidos simultâneos do mesmo ativo compartilham um único cálculo
  const job = quantJob(ticker);
  const waiting = new Promise((resolve) =>
    setTimeout(() => resolve({
      disponivel: false,
      preparando: true,
      motivo: 'Preparando o histórico da B3 (só no primeiro acesso). A página tenta de novo sozinha.',
    }), QUANT_RESPONSE_WAIT_MS)
  );
  res.json(await Promise.race([job, waiting]));
});

// Pré-aquecimento: baixa/atualiza o histórico da B3 logo após o servidor subir,
// para que o primeiro clique numa opção não precise esperar o download.
setTimeout(() => {
  quantJob('--prewarm').then((r) => console.log('[quant] histórico:', JSON.stringify(r)));
}, 20_000);

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
    let job: Queue.Job<any> | null = null;
    try {
      // Com o Redis fora do ar, add() fica pendente para sempre: limita a 5s e cai no modo direto
      job = await Promise.race([
        analysisQueue.add(
          { payload: req.body },
          {
            priority: 5, // Jobs com análise menos urgentes
            timeout: 65_000, // 65s timeout no worker
          }
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Fila indisponível (Redis sem resposta)')), 5_000)
        ),
      ]);

      console.log(`[queue] Job ${job!.id} adicionado à fila`);

      // Aguarda resultado com timeout
      const result = await Promise.race([
        job!.finished(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Job timeout')), 65_000)
        ),
      ]);

      res.json(result);
      return;
    } catch (err: any) {
      console.error('[queue] Erro:', err.message);
      // Se o job chegou a rodar e falhou, repassa o erro (não repete as chamadas à IA).
      // Só cai no modo direto quando a própria fila falhou (Redis fora do ar).
      if (job) {
        res.status(err.message === 'Job timeout' ? 504 : 502).json({
          error: `Análise IA indisponível: ${err.message}`,
        });
        return;
      }
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
      error: `Análise IA indisponível: ${errorMsg}`,
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
  console.log(`   IA: OpenRouter (${AI_MODEL_ENV ?? 'modelos gratuitos detectados automaticamente'})\n`);

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
