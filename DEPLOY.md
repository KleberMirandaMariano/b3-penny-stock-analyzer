# Deploy: Vercel (frontend) + Render (backend)

## Visão geral da arquitetura

```
Browser → Vercel (React/Vite SPA)
              ↓ VITE_API_URL
        Render (Express API)
              ↓ python subprocess
        yfinance + COTAHIST B3
```

---

## Deploy no Render (backend)

### Pré-requisito
O repositório deve estar no GitHub e o arquivo `render.yaml` na raiz.

### Passo a passo

1. Acesse [https://render.com](https://render.com) e crie conta (ou faça login).
2. **New → Web Service → Connect GitHub** → autorize o Render e selecione o repositório `b3-penny-stock-analyzer`.
3. O Render detecta automaticamente o `render.yaml`. Confirme as configurações:
   - **Name:** `b3-penny-stock-analyzer-api`
   - **Runtime:** Node
   - **Build Command:** `npm install && pip install -r requirements.txt`
   - **Start Command:** `npm run server`
4. Em **Environment Variables**, adicione:
   | Variável | Valor |
   |---|---|
   | `NODE_ENV` | `production` |
   | `ALLOWED_ORIGIN` | *(preencher após deploy do frontend — ver abaixo)* |
5. Clique em **Create Web Service** / **Deploy**.
6. Aguarde o build (~2–3 min). Copie a URL gerada, por exemplo:
   ```
   https://b3-penny-stock-analyzer-api.onrender.com
   ```

> **Atenção — plano gratuito:** O Render desliga instâncias gratuitas após 15 min de inatividade. A primeira requisição após inatividade demora ~30 s para "acordar" o serviço. Para evitar isso, considere usar um plano pago ou um serviço de ping periódico (ex: UptimeRobot).

---

## Deploy na Vercel (frontend)

### Pré-requisito
O arquivo `vercel.json` deve estar na raiz do repositório.

### Passo a passo

1. Acesse [https://vercel.com](https://vercel.com) e crie conta com GitHub.
2. **New Project → Import** → selecione `b3-penny-stock-analyzer`.
3. Configure o projeto:
   - **Framework Preset:** Vite
   - **Build Command:** `npm run build` *(já definido no `vercel.json`)*
   - **Output Directory:** `dist` *(já definido no `vercel.json`)*
4. Em **Environment Variables**, adicione:
   | Variável | Valor |
   |---|---|
   | `VITE_API_URL` | URL do Render do passo anterior (ex: `https://b3-penny-stock-analyzer-api.onrender.com`) |
5. Clique em **Deploy**.
6. Copie a URL gerada, por exemplo:
   ```
   https://b3-penny-stock-analyzer.vercel.app
   ```

---

## Conectar frontend ↔ backend (CORS)

Após ter a URL do Vercel, volte ao Render e atualize `ALLOWED_ORIGIN`:

1. No painel do Render → seu serviço → **Environment**.
2. Edite `ALLOWED_ORIGIN` com a URL do Vercel:
   ```
   https://b3-penny-stock-analyzer.vercel.app
   ```
3. O Render faz redeploy automático em ~1 min.

---

## Atualizações futuras

### Atualizar apenas o frontend
```bash
git push origin main
```
A Vercel faz redeploy automático ao detectar push na branch configurada (padrão: `main`).

### Atualizar apenas o backend
```bash
git push origin main
```
O Render também faz redeploy automático. É possível desabilitar o auto-deploy e usar deploys manuais pelo painel do Render se preferir controle granular.

### Forçar redeploy sem alteração de código
- **Vercel:** No painel do projeto → **Deployments** → clique em "..." no último deploy → **Redeploy**.
- **Render:** No painel do serviço → **Manual Deploy → Deploy latest commit**.

### Atualizar dados manualmente (sem aguardar o cron)
Após o deploy, chame o endpoint de atualização:
```bash
curl -X POST https://b3-penny-stock-analyzer-api.onrender.com/api/update \
  -H "Content-Type: application/json" \
  -d '{"maxPreco": 10.0}'
```

---

## Variáveis de ambiente — referência completa

| Variável | Onde configurar | Descrição |
|---|---|---|
| `VITE_API_URL` | Vercel | URL base do backend Render |
| `NODE_ENV` | Render | `production` |
| `ALLOWED_ORIGIN` | Render | URL do frontend Vercel (CORS) |
| `PORT` | Render (automático) | Injetado pelo Render — não configurar manualmente |
