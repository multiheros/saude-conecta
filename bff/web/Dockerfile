# Contexto de build: raiz do repositorio (usa libs/comum).
# Estagio 1: instala so as dependencias de producao (cache de camadas por package*.json)
FROM node:22-alpine AS deps
WORKDIR /app
COPY bff/web/package.json bff/web/package-lock.json ./
RUN npm ci --omit=dev

# Estagio de teste: nao entra na imagem final (docker-compose.test.yml)
FROM deps AS teste
COPY libs/comum ./libs/comum
COPY bff/web ./bff/web
WORKDIR /app/bff/web
CMD ["node", "--test", "--test-reporter=spec", "test/*.test.js"]

# Estagio final: imagem enxuta, sem npm cache, rodando como usuario nao-root
FROM node:22-alpine
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY libs/comum ./libs/comum
COPY bff/web/server.js ./bff/web/
COPY bff/web/src ./bff/web/src
USER node
WORKDIR /app/bff/web
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3001/ready || exit 1
CMD ["node", "server.js"]
