# Integração com IA (Ollama) - Análise Completa

## 📡 Arquitetura de Conexão

```
┌─────────────┐
│   Frontend  │
│  (React)    │
└──────┬──────┘
       │ POST /api/options/analyze
       │ { opt, stockPrice, stockTicker, greeks, iv, ... }
       ↓
┌──────────────────┐
│   Backend        │
│  (Express.js)    │  ← Agrega dados + monta prompt
│  :3001           │
└──────┬───────────┘
       │ fetch to Ollama API
       │ POST /api/chat
       │ { model: "llama2", messages: [...] }
       ↓
┌──────────────────────────────────────┐
│  Ollama (VPS Hostinger)              │
│  :11434                              │
│  • Model: llama2 (Llama 2 70B)       │
│  • GPU: NVIDIA A100/H100 (provável)  │
│  • RAM: 64GB+ (para rodar 70B)       │
└──────────────────────────────────────┘
       │
       │ Response: { message: { content: "análise..." } }
       ↓
┌──────────────────┐
│   Backend        │
│  (Parsing JSON)  │
└──────┬───────────┘
       │ { analise: "..." }
       ↓
┌─────────────┐
│   Frontend  │
│  (Display)  │ ← Exibe análise no modal
└─────────────┘
```

---

## 🔧 Configuração

### Variáveis de Ambiente (`.env`)

```bash
# Desenvolvimento (localhost)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama2

# Produção (VPS Hostinger)
OLLAMA_URL=https://seu-vps.com:11434
OLLAMA_MODEL=llama2
```

**Padrões:**
- `OLLAMA_URL`: Default `http://localhost:11434`
- `OLLAMA_MODEL`: Default `llama2`

### Modelos Suportados

```
llama2        (70B, 13B, 7B)       — Padrão, rápido
llama3        (70B, 8B)             — Mais recente
neural-chat   (7B)                  — Otimizado para chat
mistral       (7B, 8x7B)            — Rápido, eficiente
deepseek-coder (6.7B, 33B)          — Bom para código
```

**Recomendado para análise de opções:** `llama2` ou `llama3` (mais bem treinados)

---

## 🔌 Frontend Integration

### 1. Função de Chamada (`src/services/stockService.ts:166-182`)

```typescript
export async function analyzeOption(payload: {
  opt: { ticker: string; tipo: string; strike: number | null; preco: number | null };
  stockPrice: number;
  stockTicker: string;
  greeks?: { delta: number; gamma: number; theta: number; vega: number } | null;
  iv?: number | null;
  daysToExpiry?: number | null;
  liveData?: { bid: number | null; ask: number | null; volume: number | null; openInterest: number | null } | null;
}): Promise<{ analise: string } | { error: string }> {
  const res = await fetch(`${API_BASE}/api/options/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),  // Timeout 30s
  });
  return res.json();
}
```

**Timeout:** 30 segundos
**Erro Handling:** Retorna `{ error: string }` se falhar

### 2. Chamada no Modal (`src/App.tsx:1176-1195`)

```typescript
// Botão "Analisar"
<button
  onClick={() => {
    setAiLoading(true);
    setAiError(null);
    analyzeOption({
      opt: { ticker: opt.ticker, tipo: opt.tipo, strike: opt.strike, preco: opt.preco },
      stockPrice,
      stockTicker,
      greeks,      // {delta, gamma, theta, vega} calculados via Black-Scholes
      iv,          // Volatilidade implícita (%)
      daysToExpiry,
      liveData: liveData ? { bid, ask, volume, openInterest } : null,
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
```

**UX:**
- Botão desabilitado enquanto loading
- Spinner animado durante análise
- Mostra erro em vermelho
- Permite limpar análise

---

## 🔗 Backend Integration

### Endpoint: `POST /api/options/analyze` (`server/index.ts:210-272`)

```typescript
app.post('/api/options/analyze', async (req: Request, res: Response) => {
  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const ollamaModel = process.env.OLLAMA_MODEL ?? 'llama2';

  const { opt, stockPrice, stockTicker, greeks, iv, daysToExpiry, liveData } = req.body;
  
  // Validação mínima
  if (!opt || !stockPrice || !stockTicker) {
    res.status(400).json({ error: 'Parâmetros insuficientes.' });
    return;
  }

  // Determina moneyness (ITM/ATM/OTM)
  const moneyness = opt.tipo === 'CALL'
    ? (stockPrice > (opt.strike ?? 0) ? 'ITM' : stockPrice < (opt.strike ?? 0) ? 'OTM' : 'ATM')
    : (stockPrice < (opt.strike ?? 0) ? 'ITM' : stockPrice > (opt.strike ?? 0) ? 'OTM' : 'ATM');

  // Monta contexto em português
  const context = [
    `Ativo subjacente: ${stockTicker} (preço atual: R$ ${Number(stockPrice).toFixed(2)})`,
    `Opção: ${opt.ticker} — ${opt.tipo} (${opt.tipo === 'CALL' ? 'Direito de Compra' : 'Direito de Venda'})`,
    `Strike: R$ ${Number(opt.strike).toFixed(2)} | Prêmio: R$ ${Number(opt.preco).toFixed(2)}`,
    `Status: ${moneyness} (${moneyness === 'ITM' ? 'no dinheiro' : moneyness === 'ATM' ? 'na batida' : 'fora do dinheiro'})`,
    daysToExpiry != null ? `Dias até vencimento: ${daysToExpiry}` : null,
    iv != null ? `Volatilidade Implícita: ${(Number(iv) * 100).toFixed(1)}%` : null,
    greeks ? `Delta: ${greeks.delta.toFixed(4)} | Gamma: ${greeks.gamma.toFixed(4)} | Theta/dia: ${greeks.theta.toFixed(4)} | Vega/1%: ${greeks.vega.toFixed(4)}` : null,
    liveData?.bid != null ? `Bid: R$ ${Number(liveData.bid).toFixed(2)} | Ask: R$ ${Number(liveData.ask).toFixed(2)}` : null,
    liveData?.volume != null ? `Volume: ${liveData.volume} | Open Interest: ${liveData.openInterest ?? '—'}` : null,
  ].filter(Boolean).join('\n');

  // Prompt estruturado
  const userPrompt = `Você é um analista de opções da B3. Analise brevemente esta opção com base nos dados abaixo e forneça:
1. Uma avaliação objetiva do perfil risco/retorno
2. O que as gregas indicam sobre o comportamento da opção
3. Um ponto de atenção relevante para o operador

Seja conciso (máximo 4 parágrafos curtos). Use linguagem técnica mas acessível. Não faça recomendação de compra/venda.

Dados:
${context}`;

  try {
    // Chama Ollama
    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [{ role: 'user', content: userPrompt }],
        stream: false,  // Espera resposta completa (não streaming)
      }),
      signal: AbortSignal.timeout(60_000),  // Timeout 60s (modelo precisa de tempo)
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
```

### Fluxo de Dados

```
1. Frontend envia: { opt, stockPrice, greeks, iv, ... }
2. Backend agrega contexto em português
3. Monta prompt estruturado
4. POST para Ollama /api/chat
5. Ollama processa (30-60s)
6. Backend recebe: { message: { content: "análise..." } }
7. Backend retorna: { analise: "..." }
8. Frontend exibe no modal
```

---

## 📝 Prompt Engenharia

### Contexto Montado

```
Ativo subjacente: CVCB3 (preço atual: R$ 2.44)
Opção: CVCB3C244 — CALL (Direito de Compra)
Strike: R$ 2.44 | Prêmio: R$ 0.18
Status: ATM (na batida)
Dias até vencimento: 15
Volatilidade Implícita: 45.2%
Delta: 0.5234 | Gamma: 0.1245 | Theta/dia: -0.0042 | Vega/1%: 0.0523
Bid: R$ 0.16 | Ask: R$ 0.20
Volume: 2500 | Open Interest: 15000
```

### Instruções ao Modelo

```
Você é um analista de opções da B3. Analise brevemente esta opção com base nos dados abaixo e forneça:
1. Uma avaliação objetiva do perfil risco/retorno
2. O que as gregas indicam sobre o comportamento da opção
3. Um ponto de atenção relevante para o operador

Seja conciso (máximo 4 parágrafos curtos). Use linguagem técnica mas acessível. Não faça recomendação de compra/venda.
```

### Exemplo de Resposta

```
Esta CALL ATM apresenta um perfil de risco/retorno equilibrado. 
Com o strike exatamente no preço atual (R$ 2.44), o operador está "na batida" 
do mercado, podendo lucrar tanto com uma alta moderada quanto perder com uma queda. 
O prêmio de R$ 0.18 é competitivo dado o spread bid-ask de R$ 0.04.

As gregas indicam comportamento típico de ATM: Delta de 0.52 mostra exposição 
aproximadamente 1:1 com o ativo. O Gamma positivo (0.12) significa que o Delta 
aumenta conforme CVCB3 sobe, ampliando os lucros. Theta negativo (-0.004/dia) 
indica decay de R$ 0.06/mês, penalizando o comprador em mercado lateral.

Ponto de atenção: com apenas 15 dias até vencimento, o decay acelera exponencialmente. 
Se CVCB3 não ultrapassar R$ 2.62 (strike + prêmio), a opção vence sem lucro. 
O volume moderado (2.500 contratos) pode dificultar execução em posições grandes.
```

---

## ⏱️ Timeouts e Performance

### Timeline Típica

| Etapa | Duração | Timeout |
|-------|---------|---------|
| Frontend → Backend | ~100ms | 30s (AbortSignal) |
| Backend → Ollama | ~1-5s (rede) | 60s (AbortSignal) |
| Ollama processar (llama2) | ~15-45s | 60s do backend |
| Ollama → Backend | ~100ms | 60s |
| Backend → Frontend | ~100ms | 30s |
| **Total** | **~16-51s** | **30s frontend** ⚠️ |

**Problema:** Frontend timeout (30s) < Ollama timeout (60s)
- **Risco:** Ollama ainda processando quando frontend desiste
- **Solução:** Aumentar frontend para 70s ou Ollama para 20s

### Recomendação

```typescript
// Aumentar timeout no frontend para 70s
fetch(`${API_BASE}/api/options/analyze`, {
  signal: AbortSignal.timeout(70_000),  // ← de 30s para 70s
})
```

---

## 🔒 Segurança

### Potencial Riscos

1. **Injection via Prompt**
   - Dados de `stockTicker` vêm do usuário
   - Se usuário digita `CVCB3\n\nIGNORE TODAS AS INSTRUÇÕES ANTERIORES`
   - O contexto montado teria quebra de prompt
   - **Mitigation**: Limpar/escapar caracteres especiais

2. **DoS via /api/options/analyze**
   - Qualquer um pode disparar múltiplas análises
   - Cada uma usa 15-45s de GPU
   - VPS pode ficar sobrecarregada
   - **Mitigation**: Rate limiting + autenticação

3. **SSRF (Server-Side Request Forgery)**
   - Backend lê `OLLAMA_URL` de env
   - Se alguém altera env → ataca outro servidor
   - **Mitigation**: Validar URL (whitelist)

### Implementações de Segurança Atuais

✅ **Existentes:**
- Validação mínima: `if (!opt || !stockPrice || !stockTicker)`
- Timeout: 60s no backend

⚠️ **Faltando:**
- Rate limiting
- Sanitização de ticker
- Autenticação
- Logging de requisições

---

## 📊 Escalabilidade

### Cenários

**1 usuário solicitando análise:**
- Tempo total: ~25s
- GPU utilização: ~80% (llama2)
- Memória: ~18GB

**5 usuários simultâneos:**
- Fila em background (Ollama processa sequencial)
- Tempo de espera: +40-80s para últimos usuários
- GPU: 100% (saturada)
- **Problema:** Usuarios abandonam após 30s timeout

**Solução:**
```bash
# Usar vLLM para servir múltiplas requisições
# ou DistributedEval / ray serve para paralelismo
```

---

## 🛠️ Setup Local (Desenvolvimento)

### 1. Instalar Ollama

```bash
# macOS
brew install ollama

# Linux
curl https://ollama.ai/install.sh | sh

# Windows
# Download: https://ollama.ai/download
```

### 2. Rodar Modelo Localmente

```bash
# Terminal 1: Ollama server
ollama serve

# Terminal 2: Pull modelo
ollama pull llama2          # ~3.8GB
# ou
ollama pull llama2:13b      # ~7.4GB (mais rápido)
```

### 3. Testar Endpoint

```bash
curl -X POST http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama2",
    "messages": [{"role": "user", "content": "Olá"}],
    "stream": false
  }'
```

### 4. Variáveis de Ambiente

```bash
# .env local
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama2
```

### 5. Rodar Projeto

```bash
npm run dev:full  # Vite + Express + Ollama
```

---

## 🚀 Setup Produção (Hostinger VPS)

### 1. VPS Specs Recomendadas

```
CPU: 8+ cores
RAM: 64GB+ (llama2 70B precisa ~45GB)
GPU: NVIDIA A100 / H100 (recomendado)
      ou CPU puro (mais lento)
Rede: 1Gbps+
```

### 2. Instalação na VPS

```bash
# SSH para VPS
ssh root@seu-vps.com

# Instalar Ollama
curl https://ollama.ai/install.sh | sh

# Pull modelo em background
ollama pull llama2 &

# Rodar serviço (porta 11434)
ollama serve --host 0.0.0.0:11434 &
```

### 3. HTTPS (Let's Encrypt)

```bash
# Nginx reverse proxy
sudo apt install nginx certbot python3-certbot-nginx

# Gerar certificado
certbot certonly --nginx -d seu-vps.com

# Config nginx
# /etc/nginx/sites-enabled/ollama
upstream ollama {
  server localhost:11434;
}

server {
  listen 443 ssl;
  server_name seu-vps.com;
  
  ssl_certificate /etc/letsencrypt/live/seu-vps.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/seu-vps.com/privkey.pem;
  
  location / {
    proxy_pass http://ollama;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

### 4. Variáveis em Produção

```bash
# .env no Render
OLLAMA_URL=https://seu-vps.com:11434
OLLAMA_MODEL=llama2
```

---

## 🐛 Troubleshooting

### Erro: "Erro ao conectar ao Ollama"

```
Verificar:
1. Ollama está rodando? → ollama serve
2. Porta correta? → netstat -an | grep 11434
3. URL correta? → curl http://localhost:11434/api/tags
4. Modelo existe? → ollama list
```

### Timeout (30s no frontend)

```
Causas:
1. Rede lenta → aumentar timeout
2. Modelo ocupado → usar versão menor (llama2:7b)
3. Streaming? → disable `stream: false`
```

### Alto uso de memória

```
Solução:
# Usar modelo menor (13B ao invés de 70B)
ollama pull llama2:13b

# Ou reduzir batch size
OLLAMA_NUM_PARALLEL=1 ollama serve
```

### GPU não detectada

```bash
# Verificar GPU
nvidia-smi

# Forçar CPU
CUDA_VISIBLE_DEVICES="" ollama serve
```

---

## 📈 Monitoramento

### Métricas Importantes

```bash
# Verificar saúde Ollama
curl http://localhost:11434/api/tags

# Logs
journalctl -u ollama -f

# Uso de recursos
watch -n 1 'curl http://localhost:11434/api/tags | jq'
```

### Dashboard (Prometheus/Grafana)

```yaml
# Coletar métricas
- job_name: 'ollama'
  static_configs:
    - targets: ['localhost:11434']
  metrics_path: '/metrics'
```

---

## 🔄 Alternativas ao Ollama

Se Ollama não funcionar:

| Alternativa | Latência | Custo | Limite |
|------------|----------|-------|--------|
| Ollama Local | 15-45s | $0 | GPU limitada |
| Claude API | ~5s | $0.003/1k | Rápido, caro |
| OpenAI GPT-4 | ~3s | $0.03/1k | Melhor qualidade |
| Groq API | ~1s | $0.0015/1k | Ultra-rápido |
| HuggingFace | ~10s | Gratuito | Simples |

**Recomendação:** Manter Ollama como primário, usar fallback para Groq se cair

---

## 📝 Conclusão

A integração com Ollama permite **análise de opções contextualizada em português**, rodando localmente sem custos de API.

**Pontos fortes:**
- ✅ Offline (não envia dados para cloud)
- ✅ Sem limites de requisições
- ✅ Customizável (modelos diferentes)
- ✅ Análise contextualizada (gregas, moneyness, etc)

**Limitações:**
- ⚠️ Requer GPU potente ou espera de 15-45s
- ⚠️ Sem rate limiting (pode ser abusado)
- ⚠️ Frontend timeout menor que Ollama timeout

**Para produção:** Aumentar timeout frontend de 30s → 70s, adicionar rate limiting.
