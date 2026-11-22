# syntax=docker/dockerfile:1
# Site completo (frontend React + API Express + scripts Python) no VPS via Docker/Traefik.
# O acesso é protegido por login Google (traefik-forward-auth) no docker-compose.vps.yml.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates curl tzdata git \
 && rm -rf /var/lib/apt/lists/*

# Python isolado em venv; "python3" passa a apontar para o venv
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Camada quant da página de opções: financial-analysis-framework (pacote faf,
# repositório privado). O token entra como BuildKit secret e NÃO fica na imagem.
# FAF_REF = commit do framework (o workflow passa o SHA atual, o que refaz esta
# camada quando o framework muda). Sem o secret, a imagem sai sem o faf e o
# site mostra a tabela de opções sem as colunas quant.
ARG FAF_REF=main
RUN --mount=type=secret,id=faf_token \
    if [ -s /run/secrets/faf_token ]; then \
      pip install --no-cache-dir "financial-analysis-framework @ git+https://x-access-token:$(cat /run/secrets/faf_token)@github.com/KleberMirandaMariano/financial-analysis-framework.git@${FAF_REF}" \
      && python3 -c "import faf; print('faf instalado:', '${FAF_REF}')"; \
    else \
      echo "Secret faf_token ausente: imagem sem a camada quant (financial-analysis-framework)"; \
    fi

COPY package.json package-lock.json ./
# tsx (devDependency) é necessário para rodar server/index.ts
RUN npm ci --include=dev && npm cache clean --force

COPY . .
# Frontend servido pelo próprio Express (mesma origem): /api relativo, sem VITE_API_URL
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build && mkdir -p data public

ENV NODE_ENV=production \
    PORT=3001 \
    TZ=America/Sao_Paulo

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:3001/api/status || exit 1

CMD ["npx", "tsx", "server/index.ts"]
