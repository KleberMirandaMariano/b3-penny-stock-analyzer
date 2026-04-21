# 📋 Relatório de Verificação da Integração Ollama

**Data:** 2026-04-20  
**Status:** ⚠️ INCOMPLETO (Ollama não está instalado/rodando)  
**Escopo:** Verificação de código + teste de conectividade

---

## 1️⃣ ANÁLISE DE CÓDIGO (✅ COMPLETO)

### Implementação do Backend

#### ✅ Endpoint `/api/options/analyze` (server/index.ts:210-272)

**Estrutura:**
```
POST /api/options/analyze
├── Validação de parâmetros ✅
├── Cálculo de moneyness ✅
├── Montagem de contexto (9 campos) ✅
├── Prompt engineering ✅
├── Chamada Ollama `/api/chat` ✅
└── Tratamento de erros ✅
```

**Validações:**
| Item | Status | Detalhes |
|------|--------|----------|
| Parâmetros obrigatórios | ✅ | opt, stockPrice, stockTicker validados |
| Moneyness dinâmico | ✅ | Calcula ITM/ATM/OTM por tipo (CALL/PUT) |
| Contexto montado | ✅ | 9 dados: ativo, opção, strike, status, dias, IV, gregas, bid/ask, volume |
| Endpoint Ollama | ✅ | Usa `/api/chat` (correto para chat) |
| Timeout | ✅ | 60 segundos (adequado) |
| Tratamento erro | ✅ | Mensagem descritiva sobre falha |
| Env vars | ✅ | OLLAMA_URL e OLLAMA_MODEL suportadas |

---

### Integração Frontend

#### ✅ Função `analyzeOption()` (src/services/stockService.ts:166-182)

**Estrutura:**
```
analyzeOption(payload) → Promise
├── POST /api/options/analyze ✅
├── Timeout: 30s ⚠️ (vide problema 1)
├── Response: { analise: string } ✅
└── Error: { error: string } ✅
```

**Validações:**
| Item | Status | Detalhes |
|------|--------|----------|
| Payload correto | ✅ | Envia 7 campos esperados pelo backend |
| Método HTTP | ✅ | POST com Content-Type: application/json |
| Timeout | ⚠️ | 30s (frontend) vs 60s (backend) - mismatch |
| Tratamento resposta | ✅ | Parse correto de { analise } |
| Tratamento erro | ✅ | Captura e loga erros |

---

### UI Modal (src/App.tsx:1085-1150)

#### ✅ Seção IA no Modal de Detalhes

**Características:**
```
OptionDetailModal
├── Trigger: "Analisar com IA" button ✅
├── Loading state: spinner + "Analisando..." ✅
├── Success: renderiza texto da análise ✅
├── Error: "Erro ao conectar ao Ollama" ✅
└── Styling: Tailwind + animação Motion ✅
```

**Validações:**
| Item | Status | Detalhes |
|------|--------|----------|
| Botão de trigger | ✅ | Visível quando opção selecionada |
| Estado de loading | ✅ | Spinner + desabilita botão |
| Render análise | ✅ | Exibe texto com quebras de linha |
| Feedback visual | ✅ | Animação suave (Motion) |
| Tratamento erro | ✅ | Exibe mensagem de erro em red |

---

## 2️⃣ TESTE DE CONECTIVIDADE (⏳ PENDENTE)

### Resultado: Ollama Não Está Rodando

```bash
$ npx tsx test-ollama-integration.ts

=== OLLAMA CONNECTIVITY TESTS ===

✗ 1. Check Ollama server is running: fetch failed
✗ 2. Check model is available: fetch failed
✗ 3. Test simple generation: fetch failed
✗ 4. Test chat endpoint (used by API): fetch failed
✓ 5. Test timeout handling (simulated): OK (6ms)

=== PROMPT ENGINEERING TESTS ===

✗ 6. Test Portuguese prompt: fetch failed

SUMMARY: 1/6 tests passed
```

**Motivo:** Ollama não está instalado ou não está rodando em http://localhost:11434

---

## 3️⃣ PROBLEMAS IDENTIFICADOS

### ⚠️ Problema 1: Timeout Mismatch (CRÍTICO em Produção)

**Severidade:** 🔴 ALTO  
**Tipo:** Timing vulnerability

**Descrição:**
- Frontend espera 30 segundos (stockService.ts:179)
- Backend espera 60 segundos (server/index.ts:255)
- Se Ollama demorar 30-60s: frontend aborta, backend continua processando

**Impacto:**
```
Timeline (Ollama demora 45s):
0s    ├─ Frontend envia requisição
30s   ├─ Frontend timeout → user vê erro
35s   ├─ Backend chega em Ollama
45s   ├─ Ollama retorna análise
60s   └─ Backend recebe, mas conexão já fechou
```

**Solução:** Aumentar timeout frontend para 70s

**Arquivo:** `src/services/stockService.ts:179`  
**Mudança:**
```typescript
// ANTES
signal: AbortSignal.timeout(30_000),

// DEPOIS  
signal: AbortSignal.timeout(70_000),  // 70s para dar folga
```

---

### ⚠️ Problema 2: Rate Limiting Ausente (SEGURANÇA)

**Severidade:** 🟠 MÉDIO  
**Tipo:** Denial of Service (DoS)

**Descrição:**
- Endpoint `/api/options/analyze` sem rate limit
- Cada análise consome recursos do Ollama
- Atacante pode enviar múltiplas requisições rápidas

**Impacto:**
```
Cenário malicioso:
for i in 1..100:
  POST /api/options/analyze  # Cada uma é 30-60s de processamento
  
Resultado: Ollama sobrecarregado, usuários legítimos bloqueados
```

**Solução:** Implementar rate limiting com express-rate-limit

**Arquivo:** `server/index.ts`  
**Implementação:**
```typescript
import rateLimit from 'express-rate-limit';

const analyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 30,                    // máx 30 requisições por IP
  message: 'Limite de requisições excedido. Tente novamente em alguns minutos.'
});

app.post('/api/options/analyze', analyzeLimiter, async (req, res) => {
  // ... código existente
});
```

---

### ⚠️ Problema 3: Sem Mecanismo de Fila (ESCALABILIDADE)

**Severidade:** 🟠 MÉDIO  
**Tipo:** Resource exhaustion

**Descrição:**
- Múltiplas análises simultâneas processam em paralelo
- Cada análise carrega modelo Ollama na RAM (≈4-8GB)
- Sem limite de requisições concorrentes

**Impacto:**
```
Cenário normal:
- 5 usuários abrindo análises simultaneamente
- 5 × 4GB = 20GB RAM necessária (ou 5 × 30s = pipeline clog)

Cenário com fila:
- Requisições enfileiradas
- Processadas 1 por 1
- Tempo previsível mesmo com picos
```

**Solução:** Bull Queue (Redis) + Job processor

**Implementação sugerida:**
```typescript
import Queue from 'bull';

const analysisQueue = new Queue('option-analysis', {
  redis: { host: 'localhost', port: 6379 }
});

// Producer
app.post('/api/options/analyze', async (req, res) => {
  const job = await analysisQueue.add(req.body, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  });
  res.json({ jobId: job.id, status: 'queued' });
});

// Consumer
analysisQueue.process(async (job) => {
  // ... chamar Ollama
  return { analise: text };
});
```

---

## 4️⃣ VERIFICAÇÃO DE REQUISITOS DO SISTEMA

### Ambiente Esperado

```yaml
Sistema Operacional:
  ✅ Windows 10/11 (onde este teste rodou)
  ✅ macOS 11+
  ✅ Linux (Ubuntu 20.04+)

Node.js:
  ✅ v18+ (built-in fetch)
  ✅ v20+ (recomendado)

Dependências:
  ✅ npm packages instalados (npm install)
  ✅ Ollama binary (NÃO INSTALADO ❌)
  
Ollama:
  ❌ Não instalado
  ❌ Não rodando em localhost:11434
  ❌ Modelo llama2 não baixado
```

---

## 5️⃣ INSTRUÇÕES PARA TESTE COMPLETO

### Opção A: Ollama Local (Windows/Mac)

**Passo 1: Download e Instalação**
```bash
# Download: https://ollama.ai/download
# Windows: ollama-windows.zip
# Mac: ollama-mac.zip
# Descompacte e execute

# Verifique instalação:
ollama --version  # Deve retornar v0.x.x
```

**Passo 2: Download do Modelo**
```bash
ollama pull llama2      # ~4GB, 5-10 minutos
# ou modelo mais leve:
ollama pull neural-chat # ~2.6GB, mais rápido
```

**Passo 3: Verificar Conectividade**
```bash
curl http://localhost:11434/api/tags
# Resposta esperada:
# {"models":[{"name":"llama2:latest",...},...]}
```

**Passo 4: Rodar Testes**
```bash
npx tsx test-ollama-integration.ts
# Deve retornar: ✓ All tests passed!
```

**Passo 5: Iniciar Servidor**
```bash
npm run server
# Em outro terminal:
npm run dev

# Abra http://localhost:5173
# Selecione uma ação → clique "Analisar com IA"
```

---

### Opção B: Ollama em VPS (Produção)

**Pré-requisitos:**
- VPS Linux (Hostinger, DigitalOcean, AWS)
- SSH access
- Ubuntu 20.04+ ou CentOS 7+

**Setup completo:** Ver `INTEGRACAO_IA.md` (seção "Production VPS Setup")

---

## 6️⃣ CHECKLIST DE VALIDAÇÃO

### Desenvolvimento (Local)

```
[ ] .env criado com OLLAMA_URL=http://localhost:11434
[ ] Ollama instalado (ollama --version)
[ ] ollama pull llama2 completado (~4GB)
[ ] npm install executado
[ ] npx tsx test-ollama-integration.ts → 6/6 testes passam
[ ] npm run server → servidor iniciado sem erros
[ ] npm run dev → frontend rodando em :5173
[ ] Abrir stock card → expandir opção → clique "Analisar com IA"
[ ] Análise retorna em < 60s
[ ] Texto de análise em português, sem buy/sell recommendations
```

### Produção (VPS)

```
[ ] VPS Ubuntu 20.04+ ativo
[ ] Ollama instalado e rodando como daemon
[ ] Nginx reverse proxy configurado (HTTPS)
[ ] Let's Encrypt SSL válido
[ ] .env OLLAMA_URL=https://seu-vps.com:11434
[ ] Rate limiting (express-rate-limit) ativado
[ ] Firewall: porta 11434 bloqueada (exceto Nginx)
[ ] Monitoramento de erro (Sentry, DataDog)
[ ] Timeout frontend aumentado para 70s
[ ] Load test: 10 requisições simultâneas < 5% erro
```

---

## 7️⃣ PRÓXIMAS ETAPAS RECOMENDADAS

### Curto Prazo (Agora)

1. ✅ **[CONCLUÍDO]** Análise de código
2. ✅ **[CONCLUÍDO]** Identificação de problemas
3. **[TODO]** Instalar Ollama localmente
4. **[TODO]** Rodar `test-ollama-integration.ts`
5. **[TODO]** Testar endpoint via cURL
6. **[TODO]** Testar UI completa (stock → modal → analisar)

### Médio Prazo (Esta semana)

7. **[TODO]** Aumentar timeout frontend (Problem 1)
8. **[TODO]** Implementar rate limiting (Problem 2)
9. **[TODO]** Deploy em staging (VPS de teste)
10. **[TODO]** Load testing (5-10 usuários)

### Longo Prazo (Este mês)

11. **[TODO]** Implementar Bull Queue (Problem 3)
12. **[TODO]** Monitoramento em produção
13. **[TODO]** Documentação para usuários finais
14. **[TODO]** Otimização de prompts (fine-tuning)

---

## 📎 Arquivos Criados

| Arquivo | Propósito | Status |
|---------|-----------|--------|
| `.env` | Configuração local | ✅ Criado |
| `test-ollama-integration.ts` | Script de teste | ✅ Criado |
| `TESTE_INTEGRACAO.md` | Guia de testes | ✅ Criado |
| `RELATORIO_VERIFICACAO_OLLAMA.md` | Este relatório | ✅ Criado |

---

## 📞 Suporte

**Se tiver dúvidas:**
1. Consulte `INTEGRACAO_IA.md` (arquitectura detalhada)
2. Consulte `TESTE_INTEGRACAO.md` (procedimentos de teste)
3. Verifique logs: `npm run server 2>&1 | tail -50`

**Se Ollama falhar:**
- Verifique: `curl http://localhost:11434/api/tags`
- Logs Ollama: verifique se modelo está em RAM
- Memória: `free -h` (Linux) ou Task Manager (Windows)
- Reinicie: `killall ollama && ollama serve &`

---

**Resumo:** ✅ Código está correto | ⚠️ 3 problemas identificados | ⏳ Teste completo pendente de instalação do Ollama
