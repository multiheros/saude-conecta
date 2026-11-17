# Estagio 1: instala so as dependencias de producao (cache de camadas por package*.json)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Estagio 2: imagem final enxuta, sem npm cache, rodando como usuario nao-root
FROM node:22-alpine
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server.js package.json ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3001/health || exit 1
CMD ["node", "server.js"]
