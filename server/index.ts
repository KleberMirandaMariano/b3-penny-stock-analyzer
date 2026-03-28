/**
 * server/index.ts
 * ================
 * API Express para o B3 Penny Stock Analyzer.
 *
 * Endpoints:
 *   GET  /api/stocks          – Retorna public/stocks.json
 *   POST /api/update          – Dispara python3 scripts/update_stocks.py
 *   GET  /api/status          – Metadados sobre os dados (fonte, data, total)
 *
 * Em produção também serve o build do React (dist/).
 * Em desenvolvimento o Vite proxia /api → porta 3001.
 */

import express, { Request, Response, NextFunction } from 'express';
import { exec, spawn, ExecException } from 'child_process';
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
// CORS — origens permitidas
// ---------------------------------------------------------------------------
const allowedOrigins = [
  'http://localhost:3000',
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
  console.log(`   Auto-update: a cada 30 min (horário de pregão)\n`);

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
