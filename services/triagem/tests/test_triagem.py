"""Integracao contra MongoDB e RabbitMQ reais e descartaveis."""

import json
import threading
import uuid

import pytest

from app import regras
from app.consumidor import esperar
from app.main import repo

from conftest import conectar

INTERNO = {"X-User-Role": "servico"}


def pedir(c, saga, sintomas="tosse e coriza ha dois dias", paciente=None, **extra):
    return c.post("/api/v1/triagens", headers=INTERNO | {"X-Saga-Id": saga}, json={"pacienteId": paciente or str(uuid.uuid4()), "sintomas": sintomas} | extra)


@pytest.mark.parametrize("sintomas,idade,nivel", [
    ("não consigo respirar direito", 40, "VERMELHO"),
    ("meu pai está com a boca torta e fala enrolada", 70, "VERMELHO"),
    ("penso em me matar", 30, "VERMELHO"),
    ("dor no peito desde ontem", 55, "LARANJA"),
    ("bebê com febre desde cedo", 0, "LARANJA"),
    ("grávida e sangrando um pouco", 28, "LARANJA"),
    ("febre alta e dor no corpo", 33, "AMARELO"),
    ("dor de garganta há dois dias", 25, "VERDE"),
    ("preciso renovar minha receita da pressão", 60, "AZUL"),
    ("tosse leve, sem falta de ar", 30, "VERDE"),
    ("dor de garganta, não tenho febre alta nem falta de ar", 30, "VERDE"),
    ("sem febre mas falta de ar", 30, "LARANJA"),
    ("sem febre e com dor no peito", 30, "LARANJA"),
    ("sem febre, dor no peito", 30, "LARANJA"),
    ("não tenho tosse porém falta de ar", 30, "LARANJA"),
    ("sinto uma coisa esquisita no corpo", 30, "AMARELO"),
])
def test_regras(sintomas, idade, nivel):
    assert regras.classificar(sintomas, idade)["classificacao"] == nivel


@pytest.mark.parametrize("sintomas,idade,esp", [("tosse", 5, "Pediatria"), ("estou grávida e com enjoo", 30, "Ginecologia"), ("dor lombar", 50, "Clínica Geral")])
def test_especialidade(sintomas, idade, esp):
    assert regras.classificar(sintomas, idade)["especialidadeSugerida"] == esp


def test_idempotente_por_saga(cliente):
    s = str(uuid.uuid4())
    a, b = pedir(cliente, s), pedir(cliente, s)
    assert (a.status_code, b.status_code) == (201, 201)
    assert a.json()["id"] == b.json()["id"]
    assert a.json()["temporaria"] is True and a.json()["origem"] == "REGRAS"
    assert repo.db.triagens.count_documents({}) == 1


def test_pedidos_simultaneos_nao_duplicam(cliente):
    s, ids = str(uuid.uuid4()), []
    ts = [threading.Thread(target=lambda: ids.append(pedir(cliente, s).json()["id"])) for _ in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(set(ids)) == 1 and repo.db.triagens.count_documents({}) == 1


def test_compensacao_so_da_propria_saga_e_repetivel(cliente):
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    pedir(cliente, a)
    pedir(cliente, b)
    for _ in range(2):
        assert cliente.delete(f"/api/v1/triagens?sagaId={a}", headers=INTERNO).status_code == 204
    assert [t["sagaId"] for t in repo.db.triagens.find()] == [b]


def test_pedido_atrasado_e_recusado(cliente):
    s = str(uuid.uuid4())
    cliente.delete(f"/api/v1/triagens?sagaId={s}", headers=INTERNO)
    assert pedir(cliente, s).status_code == 409
    assert repo.db.triagens.count_documents({}) == 0


def test_permissoes_e_validacao(cliente):
    s, eu = str(uuid.uuid4()), str(uuid.uuid4())
    corpo = {"pacienteId": eu, "sintomas": "dor de garganta"}
    for papel in (None, "paciente", "gestor"):
        h = {"X-Saga-Id": s} | ({"X-User-Role": papel} if papel else {})
        assert cliente.post("/api/v1/triagens", headers=h, json=corpo).status_code == 403
        assert cliente.delete(f"/api/v1/triagens?sagaId={s}", headers=h).status_code == 403
    assert cliente.post("/api/v1/triagens", headers=INTERNO, json=corpo).status_code == 400
    assert cliente.delete("/api/v1/triagens", headers=INTERNO).status_code == 400
    assert pedir(cliente, "nao-e-uuid").status_code == 400
    for ruim in ({"sintomas": "oi"}, {"pacienteId": "x"}, {"idade": -1}):
        r = cliente.post("/api/v1/triagens", headers=INTERNO | {"X-Saga-Id": s}, json=corpo | ruim)
        assert r.status_code == 422 and r.headers["content-type"] == "application/problem+json"
    t = pedir(cliente, s, paciente=eu).json()["id"]
    ver = lambda papel, quem: cliente.get(f"/api/v1/triagens/{t}", headers={"X-User-Role": papel, "X-User-Id": quem}).status_code
    assert (ver("paciente", eu), ver("paciente", str(uuid.uuid4())), ver("gestor", "")) == (200, 403, 200)
    assert cliente.get(f"/api/v1/triagens/{t}").status_code == 403
    assert cliente.get("/api/v1/triagens/inexistente", headers=INTERNO).status_code == 404
    fb = lambda papel: cliente.post(f"/api/v1/triagens/{t}/feedback", headers={"X-User-Role": papel}, json={"classificacaoMedico": "VERDE"}).status_code
    assert (fb("paciente"), fb("gestor")) == (403, 204)


def test_agendamento_criado_efetiva_e_mensagem_ruim_vai_para_dlq(cliente):
    s = str(uuid.uuid4())
    t = pedir(cliente, s).json()["id"]
    cx = conectar()
    canal = cx.channel()
    canal.queue_purge("triagem.agendamento.dlq")
    publicar = lambda b: canal.basic_publish("saudeconecta.events", "agendamento.agendamento.criado", b)
    publicar(b"nao e json")
    publicar(json.dumps({"eventType": "AgendamentoCriado", "payload": {"sagaId": s, "agendamentoId": str(uuid.uuid4())}}).encode())
    assert esperar(lambda: repo.buscar(t)["temporaria"] is False)
    assert esperar(lambda: canal.queue_declare("triagem.agendamento.dlq", passive=True).method.message_count == 1)
    cx.close()
    # Depois de efetivada, uma compensacao fora de hora nao apaga a triagem do agendamento.
    cliente.delete(f"/api/v1/triagens?sagaId={s}", headers=INTERNO)
    assert repo.buscar(t) is not None
