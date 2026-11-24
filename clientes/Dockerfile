# Um pacote, duas imagens: docker build --build-arg APP=paciente (ou gestor) clientes
FROM node:22-alpine AS build
ARG APP
WORKDIR /c
COPY package.json package-lock.json ./
RUN npm ci
COPY comum ./comum
COPY ${APP} ./${APP}
RUN npm run build:${APP}

FROM nginxinc/nginx-unprivileged:1.27-alpine
ARG APP
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /c/dist/${APP} /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/vivo || exit 1
