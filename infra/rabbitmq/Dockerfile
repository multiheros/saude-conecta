# RabbitMQ com exchange, filas, DLQs e bindings ja declarados: nenhum evento se
# perde por ser publicado antes de o consumidor subir pela primeira vez.
FROM rabbitmq:3.13-management-alpine
COPY definitions.json /etc/rabbitmq/definitions.modelo.json
COPY iniciar.sh /usr/local/bin/iniciar.sh
RUN echo 'load_definitions = /etc/rabbitmq/definitions.json' > /etc/rabbitmq/conf.d/20-definitions.conf
ENTRYPOINT ["iniciar.sh"]
