FROM kong:3.9.1
# Sem banco e sem API de administracao: a configuracao e so o arquivo declarativo.
ENV KONG_DATABASE=off \
    KONG_DECLARATIVE_CONFIG=/tmp/kong.yml \
    KONG_PLUGINS=jwt,acl,correlation-id,request-termination,rate-limiting,limite-antes,identidade \
    KONG_ADMIN_LISTEN=off \
    KONG_PROXY_LISTEN="0.0.0.0:8000 reuseport backlog=16384" \
    KONG_STATUS_LISTEN=0.0.0.0:8100 \
    KONG_PROXY_ACCESS_LOG=/dev/stdout \
    KONG_PROXY_ERROR_LOG=/dev/stderr \
    KONG_ANONYMOUS_REPORTS=off \
    KONG_HEADERS=off \
    KONG_NGINX_WORKER_PROCESSES=2 \
    KONG_NGINX_HTTP_CLIENT_MAX_BODY_SIZE=1m \
    KONG_UPSTREAM_KEEPALIVE_IDLE_TIMEOUT=4
# O Node fecha conexoes ociosas em 5 s; o Kong precisa solta-las antes.
USER root
COPY plugins/limite-antes /usr/local/share/lua/5.1/kong/plugins/limite-antes
COPY plugins/identidade /usr/local/share/lua/5.1/kong/plugins/identidade
COPY kong.yml /etc/kong/kong.modelo.yml
COPY iniciar.sh /iniciar.sh
USER kong
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=5 CMD kong health
ENTRYPOINT ["bash", "/iniciar.sh"]
