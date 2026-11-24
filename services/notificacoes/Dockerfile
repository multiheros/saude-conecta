# Contexto de build: raiz do repositorio (usa libs/comum).
# Estagio 1: instala so as dependencias de producao (cache de camadas por package*.json)
FROM node:22-alpine AS deps
WORKDIR /app
COPY services/notificacoes/package.json services/notificacoes/package-lock.json ./
RUN npm ci --omit=dev

# Estagio de teste: nao entra na imagem final (docker-compose.test.yml)
FROM deps AS teste
COPY libs/comum ./libs/comum
COPY services/notificacoes ./services/notificacoes
WORKDIR /app/services/notificacoes
CMD ["node", "--test", "--test-reporter=spec", "test/*.test.js"]

# Estagio final: imagem enxuta, sem npm cache, rodando como usuario nao-root
FROM node:22-alpine
ENV NODE_ENV=production PORT=8004
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY libs/comum ./libs/comum
COPY services/notificacoes/server.js ./services/notificacoes/
COPY services/notificacoes/src ./services/notificacoes/src
USER node
WORKDIR /app/services/notificacoes
EXPOSE 8004
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8004/ready || exit 1
CMD ["node", "server.js"]
