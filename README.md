# B3 Penny Stock Analyzer

Dashboard para análise de penny stocks da B3 (ações abaixo de R$10), com dados fundamentalistas e opções (CALL/PUT) em tempo real.

## Funcionalidades

- **Top 20 ações** ordenadas por variação diária
- **Dados fundamentalistas**: P/L, P/VP, Dividend Yield, Upside Graham
- **Opções CALL e PUT** carregadas sob demanda ao clicar na ação
- **Dados oficiais B3** via COTAHIST (download automático do arquivo diário)
- **Enriquecimento via yfinance**: setor, variações, indicadores
- **Atualização automática** a cada 30 min durante o pregão (10h-18h20)
- **Gráficos**: distribuição por setor, maiores altas/baixas, médias móveis

## Arquitetura

```
Frontend (React + Vite)  →  Backend (Express)  →  Python (dados)
      :3000                     :3001               COTAHIST + yfinance
```

| Camada | Tecnologia | Função |
|--------|-----------|--------|
| Frontend | React, TypeScript, Tailwind, Recharts | UI e visualizações |
| Backend | Express, TypeScript | API REST, proxy de dados |
| Dados | Python, yfinance, COTAHIST B3 | Coleta e processamento |

## Pré-requisitos

- **Node.js** >= 18
- **Python** >= 3.10
- **pip**: `yfinance`, `requests`

## Instalação

```bash
# Dependências Node
npm install

# Dependências Python
pip install yfinance requests
```

## Uso

```bash
# Iniciar backend (porta 3001)
npm run server

# Iniciar frontend (porta 3000) - em outro terminal
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
| `/api/status` | GET | Status da última atualização |

## Pipeline de Dados

1. **COTAHIST** - Baixa o arquivo diário da B3 (Python puro, sem dependência do R)
2. **yfinance** - Enriquece com dados fundamentalistas (P/L, P/VP, setor, etc.)
3. **Processamento** - Calcula Graham Upside, vincula opções por ticker
4. **Persistência** - Salva em `public/stocks.json` e `data/cotahist.json`

## Atualização Manual dos Dados

```bash
python scripts/update_stocks.py --max-preco 10.0
```

## Licença

MIT
