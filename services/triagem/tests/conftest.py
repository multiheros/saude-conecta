import os

import pika
import pytest
from fastapi.testclient import TestClient

from app.consumidor import esperar
from app.main import app, repo


def conectar():
    return pika.BlockingConnection(pika.ConnectionParameters(os.environ["RABBITMQ_HOST"], credentials=pika.PlainCredentials(os.environ["RABBITMQ_USER"], os.environ["RABBITMQ_PASSWORD"])))


# Um so cliente para todos os testes: a thread do consumidor so pode ser iniciada uma vez.
@pytest.fixture(scope="session")
def cliente():
    assert esperar(repo.ping, 20)
    # O broker de teste e compartilhado: descarta eventos deixados por outros servicos.
    cx = conectar()
    cx.channel().queue_purge("triagem.agendamento")
    cx.close()
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def limpar():
    repo.db.triagens.delete_many({})
    repo.db.encerradas.delete_many({})
