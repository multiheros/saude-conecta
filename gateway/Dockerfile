FROM nginx:1.27-alpine
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/saudeconecta.conf
COPY proxy.conf /etc/nginx/proxy.conf
EXPOSE 80
