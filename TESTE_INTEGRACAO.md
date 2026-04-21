# Teste de Integração Ollama

## Status da Integração

### ✅ Código do Servidor (Verificado)

O endpoint `/api/options/analyze` (server/index.ts:210-272) está **corretamente implementado**:

**Validações:**
- ✅ Valida parâmetros obrigatórios (opt, stockPrice, stockTicker)
- ✅ Calcula moneyness dinamicamente (ITM/ATM/OTM)
- ✅ Monta contexto com 9 dados principais
- ✅ Usa API `/api/chat` do Ollama (correto para chat)
- ✅ Timeout de 60s configurado (adequado)
- ✅ Tratamento de erro com mensagem descritiva
- ✅ Suporta env vars OLLAMA_URL e OLLAMA_MODEL

**Payload de contexto montado (linhas 224-234):**
```
Ativo subjacente: PETR4 (preço atual: R$ 25.50)
Opção: PETR4C25 — CALL (Direito de Compra)
Strike: R$ 25.00 | Prêmio: R$ 1.50
Status: ITM (no dinheiro)
Dias até vencimento: 45
Volatilidade Implícita: 35.0%
Delta: 0.6500 | Gamma: 0.0800 | Theta/dia: -0.0500 | Vega/1%: 0.1200
Bid: R$ 1.48 | Ask: R$ 1.52
Volume: 15000 | Open Interest: 50000
```

**Prompt engenharia (linhas 236-244):**
- Instruções claras em português
- Pede 3 análises específicas (risco/retorno, gregas, ponto de atenção)
- Limita a 4 parágrafos
- Proíbe buy/sell recommendations
- Linguagem técnica mas acessível

---

## Requisitos para Teste Completo

### Opção 1: Ollama Local (Windows)

**Instalação:**
```bash
# Download: https://ollama.ai/download
# Descompacte e execute ollama.exe

# Em outro terminal, download do modelo:
ollama pull llama2
ollama pull llama3  # (opcional, mais rápido)

# Verifique:
curl http://localhost:11434/api/tags
```

**Variáveis de Ambiente:**
```env
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama2
```

**Tempo esperado:**
- Primeira requisição: 30-90s (carregamento do modelo na RAM)
- Requisições subsequentes: 10-30s (modelo já em cache)

---

### Opção 2: Ollama em VPS Hostinger (Produção)

**Setup (documentado em INTEGRACAO_IA.md):**
```bash
# No VPS Ubuntu 20.04+
curl -fsSL https://ollama.ai/install.sh | sh
ollama serve &
ollama pull llama2

# Nginx reverse proxy com Let's Encrypt (HTTPS)
# Habilitar persistência do modelo
```

**Variáveis de Ambiente:**
```env
OLLAMA_URL=https://seu-vps.com:11434
OLLAMA_MODEL=llama2
```

---

## Scripts de Teste

### 1. Teste de Conectividade Ollama

```bash
npx tsx test-ollama-integration.ts
```

**Testes executados:**
1. Conectividade básica: `GET /api/tags`
2. Modelo disponível: valida se llama2 está no servidor
3. Geração simples: testa `/api/generate`
4. Chat endpoint: testa `/api/chat` (usado pela API)
5. Timeout handling: simula requisição lenta
6. Prompt em português: testa análise com contexto real

**Saída esperada (com Ollama rodando):**
```
✓ Check Ollama server is running (234ms)
✓ Check model is available (145ms)
✓ Test simple generation (8234ms)
✓ Test chat endpoint (used by API) (12456ms)
✓ Test Portuguese prompt (15789ms)

Total: 6 | Passed: 6 | Failed: 0
✓ All tests passed!
```

---

### 2. Teste do Servidor Express

```bash
npm run server
```

**Em outro terminal, teste o endpoint:**

```bash
curl -X POST http://localhost:3001/api/options/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "opt": {
      "ticker": "PETR4C25",
      "tipo": "CALL",
      "strike": 25.0,
      "preco": 1.50
    },
    "stockPrice": 25.50,
    "stockTicker": "PETR4",
    "greeks": {
      "delta": 0.65,
      "gamma": 0.08,
      "theta": -0.05,
      "vega": 0.12
    },
    "iv": 0.35,
    "daysToExpiry": 45,
    "liveData": {
      "bid": 1.48,
      "ask": 1.52,
      "volume": 15000,
      "openInterest": 50000
    }
  }'
```

**Resposta esperada:**
```json
{
  "analise": "Você é um analista de opções da B3. Analise brevemente esta opção...\n\n[Análise gerada pelo Ollama]\n\nEsta opção CALL de PETR4 está ITM com delta positivo forte..."
}
```

**Se Ollama não estiver rodando:**
```json
{
  "error": "Erro ao conectar ao Ollama em http://localhost:11434: connect ECONNREFUSED 127.0.0.1:11434. Verifique se a VPS está ativa."
}
```

---

## Problemas Conhecidos e Soluções

### Problema 1: Timeout no Frontend (30s) vs Backend (60s)

**Status:** ⚠️ IDENTIFICADO (não testado em produção)

**Causa:** Frontend aguarda 30s, backend aguarda 60s. Se Ollama levar >30s, frontend aborta enquanto backend continua processando.

**Solução:** Aumentar timeout frontend em `src/services/stockService.ts:179`:
```typescript
// ANTES
signal: AbortSignal.timeout(30_000),

// DEPOIS
signal: AbortSignal.timeout(70_000),  // 70s para dar folga
```

---

### Problema 2: Rate Limiting Ausente

**Status:** ⚠️ IDENTIFICADO (não protegido em produção)

**Risco:** Múltiplas requisições rápidas podem sobrecarregar Ollama.

**Solução recomendada:** Adicionar express-rate-limit:
```typescript
import rateLimit from 'express-rate-limit';

const analyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 30, // máx 30 requisições por IP
  message: 'Limite de requisições excedido. Tente novamente em alguns minutos.'
});

app.post('/api/options/analyze', analyzeLimiter, async (req, res) => {
  // ... código existente
});
```

---

### Problema 3: Sem Fila de Requisições

**Status:** ⚠️ DESIGN (não implementado)

**Risco:** Múltiplas análises simultâneas consomem RAM ilimitadamente.

**Solução recomendada:** Usar Bull queue (Redis) para fila async.

---

## Checklist de Verificação

### Desenvolvimento Local

- [ ] `.env` criado com `OLLAMA_URL=http://localhost:11434`
- [ ] `ollama pull llama2` executado
- [ ] `npm run server` sem erros
- [ ] `curl` teste retorna `{ "analise": "..." }`
- [ ] Tempo total < 60s (com Ollama aquecido)

### Produção (VPS)

- [ ] VPS Hostinger com Ubuntu 20.04+
- [ ] Ollama instalado e rodando como serviço
- [ ] Nginx reverse proxy configurado (HTTPS)
- [ ] `.env` aponta para `https://seu-vps.com:11434`
- [ ] Certificado SSL via Let's Encrypt
- [ ] Firewall permite porta 11434 (ou apenas via Nginx)
- [ ] Rate limiting ativado em produção
- [ ] Monitoramento de erro do Ollama

---

## Próximos Passos

1. **Instalar Ollama localmente** (Windows/Mac/Linux)
2. **Executar `npx tsx test-ollama-integration.ts`** para validar conectividade
3. **Iniciar servidor**: `npm run server`
4. **Testar endpoint via curl** com payload real
5. **Aumentar timeout frontend** para 70s se usar produção
6. **Considerar rate limiting** antes de deploy

---

## Arquivos Relacionados

- `server/index.ts` — Implementação do endpoint (linhas 210-272)
- `src/services/stockService.ts` — Cliente do endpoint (linhas 166-182)
- `src/App.tsx` — Integração UI (linhas 1085-1150 - seção IA)
- `test-ollama-integration.ts` — Script de teste (novo)
- `.env` — Configuração local (novo)
