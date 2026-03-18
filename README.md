# B3 Penny Stock Analyzer

Dashboard para análise de penny stocks da B3 (ações abaixo de R$10), com dados fundamentalistas e opções (CALL/PUT) em tempo real.

## Funcionalidades

- **Top 15 por desempenho anual** (var1a) e ranking por variação diária
- **Dados fundamentalistas**: P/L, P/VP, Dividend Yield, Upside Graham
- **Variações**: dia, semana, 1 ano (var1a), 5 anos (var5a)
- **Opções CALL e PUT** carregadas sob demanda ao clicar na ação
- **Dados oficiais B3** via COTAHIST (download automático do arquivo diário)
- **Enriquecimento via yfinance**: setor, variações, indicadores fundamentalistas
- **Atualização automática** a cada 30 min durante o pregão (10h–18h20 BRT)
- **Auto-update no startup** caso `stocks.json` esteja ausente
- **Gráficos**: distribuição por setor, maiores altas/baixas, médias móveis

## Arquitetura

```
Frontend (React + Vite)  →  Backend (Express)  →  Python (dados)
      :3000                     :3001           COTAHIST B3 + yfinance
```

| Camada | Tecnologia | Função |
|--------|-----------|--------|
| Frontend | React 19, TypeScript, Tailwind v4, Recharts, Motion | UI e visualizações |
| Backend | Express, TypeScript (tsx) | API REST, auto-update, proxy de dados |
| Dados | Python, yfinance, COTAHIST B3 | Coleta, parsing e processamento |

### Estrutura de arquivos

```
├── server/
│   └── index.ts            # API Express (porta 3001)
├── src/
│   ├── App.tsx             # Componente principal com dashboard
│   ├── services/
│   │   └── stockService.ts # Chamadas à API
│   └── utils.ts            # Tipos e helpers
├── scripts/
│   ├── update_stocks.py    # Pipeline principal de dados
│   ├── seed_from_csv.py    # Seed inicial a partir de CSV
│   ├── base_tickers.json   # Lista base de tickers monitorados
│   └── fetch_b3_data.R     # Script R opcional (rb3/COTAHIST)
├── public/
│   └── stocks.json         # Saída dos dados (gerado automaticamente)
└── data/
    └── cotahist.json       # Cache do COTAHIST (gerado automaticamente)
```

## Pré-requisitos

- **Node.js** >= 18
- **Python** >= 3.10
- **R + pacote rb3** *(opcional — melhora qualidade dos dados de opções)*

## Instalação

```bash
# Dependências Node
npm install

# Dependências Python
pip install -r requirements.txt
```

## Configuração

Copie `.env.example` para `.env` e ajuste as variáveis:

```bash
cp .env.example .env
```

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `VITE_API_URL` | `http://localhost:3001` | URL do backend (frontend) |
| `PORT` | `3001` | Porta do servidor Express |
| `ALLOWED_ORIGIN` | — | Origem permitida via CORS (produção) |

## Uso

```bash
# Iniciar backend (porta 3001)
npm run server

# Iniciar frontend (porta 3000) — em outro terminal
npm run dev

# Ou ambos juntos
npm run dev:full
```

Acesse **http://localhost:3000**

## API

| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/api/stocks` | GET | Lista todas as ações com indicadores |
| `/api/options/:ticker` | GET | Opções CALL/PUT para uma ação específica |
| `/api/update` | POST | Dispara atualização dos dados |
| `/api/status` | GET | Status e metadados da última atualização |

### POST /api/update — parâmetros (body JSON)

| Campo | Tipo | Padrão | Descrição |
|-------|------|--------|-----------|
| `maxPreco` | number | `10.0` | Preço máximo para filtro de penny stocks |
| `ticker` | string | — | Atualiza somente um ticker específico |

## Pipeline de Dados

1. **COTAHIST (R/rb3)** — tenta o script R para dados completos de ações e opções
2. **COTAHIST (Python)** — fallback automático; baixa e parseia o arquivo diário da B3
3. **yfinance** — enriquece com dados fundamentalistas (P/L, P/VP, setor, variações)
4. **Processamento** — calcula Graham Upside, vincula opções por ticker
5. **Persistência** — salva em `public/stocks.json` e `data/cotahist.json`

## Atualização Manual dos Dados

```bash
# Atualização completa (preço máximo R$10, 8 workers paralelos)
python scripts/update_stocks.py

# Com parâmetros customizados
python scripts/update_stocks.py --max-preco 5.0 --workers 12

# Atualizar um ticker específico
python scripts/update_stocks.py --ticker OIBR3

# Seed inicial a partir de arquivo CSV
npm run seed:stocks
```

## Deploy

O projeto usa arquitetura split: **frontend no Vercel** e **backend no Render**.

### Frontend (Vercel)

Configure a variável de ambiente `VITE_API_URL` com a URL pública do backend no Render.

### Backend (Render)

O arquivo `render.yaml` define o serviço. Configure `ALLOWED_ORIGIN` com a URL do Vercel após o deploy.

```yaml
# render.yaml (resumo)
buildCommand: npm install --include=dev && pip3 install -r requirements.txt
startCommand: npm run server
```

Em produção, o Express serve também o build do React (`dist/`) se presente.

## Licença

MIT
