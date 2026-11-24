"""Consome AgendamentoCriado: a triagem deixa de ser temporaria."""

import json
import logging
import threading
import time

import pika
from pymongo.errors import PyMongoError

log = logging.getLogger("triagem.consumidor")
FILA = "triagem.agendamento"
TENTATIVAS = 3


class Consumidor(threading.Thread):
    def __init__(self, env, tratar):
        super().__init__(daemon=True, name="consumidor")
        self.env, self.tratar = env, tratar
        self.conectado = False
        self._parar = threading.Event()

    def run(self):
        while not self._parar.is_set():
            try:
                self._consumir()
            except Exception as e:  # noqa: BLE001 - qualquer queda leva a reconexao
                log.warning("rabbitmq indisponivel: %s", e or type(e).__name__)
            self.conectado = False
            self._parar.wait(2)

    def _consumir(self):
        conexao = pika.BlockingConnection(pika.ConnectionParameters(
            host=self.env["RABBITMQ_HOST"], port=int(self.env.get("RABBITMQ_PORT", "5672")), heartbeat=30,
            credentials=pika.PlainCredentials(self.env["RABBITMQ_USER"], self.env["RABBITMQ_PASSWORD"]),
            socket_timeout=3, blocked_connection_timeout=10,
        ))
        try:
            canal = conexao.channel()
            canal.basic_qos(prefetch_count=1)
            self.conectado = True
            log.info("consumindo %s", FILA)
            # inactivity_timeout permite perceber o pedido de parada.
            for metodo, _, corpo in canal.consume(FILA, inactivity_timeout=1):
                if self._parar.is_set():
                    break
                if metodo is not None:
                    self._processar(conexao, canal, metodo, corpo)
        finally:
            if conexao.is_open:
                conexao.close()

    def _processar(self, conexao, canal, metodo, corpo):
        tentativa = 1
        while not self._parar.is_set():
            try:
                self.tratar(json.loads(corpo))
                return canal.basic_ack(metodo.delivery_tag)
            except PyMongoError as e:  # banco fora: insiste, sem descartar
                log.warning("banco indisponivel, nova tentativa: %s", e)
                conexao.sleep(1)  # mantem o heartbeat
            except Exception as e:  # noqa: BLE001
                log.error("evento com falha (tentativa %d): %r", tentativa, e)
                if tentativa >= TENTATIVAS:
                    return canal.basic_nack(metodo.delivery_tag, requeue=False)  # DLQ
                tentativa += 1
                conexao.sleep(0.3)

    def parar(self):
        self._parar.set()
        self.join(timeout=5)


def esperar(condicao, prazo=10.0):
    fim = time.monotonic() + prazo
    while time.monotonic() < fim:
        if condicao():
            return True
        time.sleep(0.05)
    return False
