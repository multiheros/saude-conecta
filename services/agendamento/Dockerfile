# Contexto de build: raiz do repositorio (usa libs/comum).
# Estagio 1: instala so as dependencias de producao (cache de camadas por package*.json)
FROM node:22-alpine AS deps
WORKDIR /app
COPY services/agendamento/package.json services/agendamento/package-lock.json ./
RUN npm ci --omit=dev

# Estagio de teste: nao entra na imagem final (docker-compose.test.yml)
FROM deps AS teste
COPY libs/comum ./libs/comum
COPY services/agendamento ./services/agendamento
WORKDIR /app/services/agendamento
CMD ["node", "--test", "--test-concurrency=1", "--test-reporter=spec", "test/*.test.js"]

# Estagio final: imagem enxuta, sem npm cache, rodando como usuario nao-root
FROM node:22-alpine
ENV NODE_ENV=production PORT=8002
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY libs/comum ./libs/comum
COPY services/agendamento/server.js ./services/agendamento/
COPY services/agendamento/src ./services/agendamento/src
COPY services/agendamento/migrations ./services/agendamento/migrations
USER node
WORKDIR /app/services/agendamento
EXPOSE 8002
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8002/ready || exit 1
CMD ["node", "server.js"]
