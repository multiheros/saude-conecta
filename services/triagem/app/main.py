import json
import logging
import os
import re
import socket
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from pymongo.errors import PyMongoError

from . import regras
from .consumidor import Consumidor
from .repositorio import Repositorio, SagaEncerrada, agora

logging.basicConfig(level=logging.INFO, format="%(message)s")
logging.getLogger("pika").setLevel(logging.CRITICAL)
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)  # o middleware abaixo ja registra
log = logging.getLogger("triagem")

UUID = re.compile(r"^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.I)
repo = Repositorio()


def tratar_evento(evento: dict):
    if evento["eventType"] == "AgendamentoCriado":
        repo.efetivar(evento["payload"]["sagaId"], evento["payload"]["agendamentoId"])


consumidor = Consumidor(os.environ, tratar_evento)


@asynccontextmanager
async def ciclo(_app):
    if os.getenv("RABBITMQ_HOST"):
        consumidor.start()
    yield
    if consumidor.is_alive():
        consumidor.parar()


app = FastAPI(title="SaudeConecta - Triagem IA", version="1.0.0", lifespan=ciclo)


# --- Base HTTP: correlacao, log e erros RFC 7807
@app.middleware("http")
async def correlacao(request: Request, call_next):
    cid = request.headers.get("x-correlation-id") or str(uuid.uuid4())
    request.state.correlation_id = cid
    t0 = time.monotonic()
    resposta = await call_next(request)
    resposta.headers["X-Correlation-Id"] = cid
    if request.url.path not in ("/live", "/ready"):
        log.info(json.dumps({"nivel": "info", "servico": "triagem", "correlationId": cid, "metodo": request.method,
                             "caminho": request.url.path, "status": resposta.status_code, "ms": int((time.monotonic() - t0) * 1000)}))
    return resposta


def problema(request, status, titulo, detalhe=None):
    return JSONResponse(status_code=status, media_type="application/problem+json", content={
        "type": "about:blank", "title": titulo, "status": status, "detail": detalhe,
        "correlationId": getattr(request.state, "correlation_id", None)})


@app.exception_handler(HTTPException)
async def erro_http(request, e):
    return problema(request, e.status_code, str(e.detail))


@app.exception_handler(RequestValidationError)
async def erro_validacao(request, e):
    campos = ", ".join(".".join(str(p) for p in x["loc"][1:]) for x in e.errors())
    local = {x["loc"][0] for x in e.errors()}
    return problema(request, 422 if "body" in local else 400, "Dados invalidos", campos)


@app.exception_handler(PyMongoError)
async def erro_banco(request, _e):
    return problema(request, 503, "Banco indisponivel")


# Identidade injetada pelo gateway; o perfil 'servico' so existe na rede interna.
def exigir_servico(x_user_role: str | None = Header(None)):
    if x_user_role != "servico":
        raise HTTPException(403, "Sem permissao")


def exigir_dono(triagem: dict, perfil, usuario):
    if perfil in ("gestor", "servico") or (perfil == "paciente" and usuario == triagem["pacienteId"]):
        return
    raise HTTPException(403, "Sem permissao")


def uuid_valido(v: str) -> str:
    if not UUID.match(v):
        raise HTTPException(400, "Identificador invalido")
    return v.lower()


# --- Saude
@app.get("/live")  # o processo responde; nao depende do banco
def live():
    return {"service": "triagem", "status": "ok", "instance": socket.gethostname()}


@app.get("/ready")  # banco acessivel
def ready():
    ok = repo.ping()
    return JSONResponse(status_code=200 if ok else 503, content={
        "service": "triagem", "status": "ok" if ok else "degraded", "db": "up" if ok else "down",
        "rabbitmq": "up" if consumidor.conectado else "down", "instance": socket.gethostname()})


# --- Triagens
class TriagemIn(BaseModel):
    pacienteId: uuid.UUID
    sintomas: str = Field(min_length=10, max_length=2000)
    idade: int | None = Field(default=None, ge=0, le=130)


class FeedbackIn(BaseModel):
    classificacaoMedico: str = Field(pattern="^(VERMELHO|LARANJA|AMARELO|VERDE|AZUL)$")


def representar(t: dict) -> dict:
    return {k: t.get(k) for k in ("pacienteId", "classificacao", "justificativa", "especialidadeSugerida", "confianca", "temporaria", "origem", "fontes")} | {
        "id": t["_id"], "criadoEm": t["criadoEm"].isoformat()}


# SAGA passo 1. Idempotente por SAGA. O modelo de linguagem entra aqui na proxima etapa;
# por ora, so as regras (que serao o fallback dele).
@app.post("/api/v1/triagens", status_code=201, dependencies=[Depends(exigir_servico)])
def criar(body: TriagemIn, x_saga_id: str = Header()):
    saga = uuid_valido(x_saga_id)
    existente = repo.da_saga(saga)
    if existente is None:
        existente = {
            "_id": str(uuid.uuid4()), "sagaId": saga, "pacienteId": str(body.pacienteId), "sintomas": body.sintomas, "idade": body.idade,
            **regras.classificar(body.sintomas, body.idade), "confianca": None, "origem": "REGRAS", "fontes": [],
            "temporaria": True, "criadoEm": agora(),
        }
    try:
        return representar(repo.criar(existente))
    except SagaEncerrada:
        raise HTTPException(409, "SAGA ja encerrada") from None


@app.delete("/api/v1/triagens", status_code=204, dependencies=[Depends(exigir_servico)])
def descartar(sagaId: str = Query()):
    repo.descartar(uuid_valido(sagaId))
    return Response(status_code=204)


def buscar_triagem(triagem_id: str, x_user_role: str | None = Header(None), x_user_id: str | None = Header(None)) -> dict:
    t = repo.buscar(triagem_id)
    if t is None:
        raise HTTPException(404, "Triagem nao encontrada")
    exigir_dono(t, x_user_role, x_user_id)
    return t


@app.get("/api/v1/triagens/{triagem_id}")
def consultar(t: dict = Depends(buscar_triagem)):
    return representar(t)


@app.get("/api/v1/triagens/{triagem_id}/orientacoes")
def orientacoes(t: dict = Depends(buscar_triagem)):
    return {"orientacoes": ["Leve cartão SUS e documento com foto", "Chegue 15 minutos antes",
                            "Se os sintomas piorarem, procure atendimento imediato ou ligue 192"], "fontes": t.get("fontes", [])}


@app.post("/api/v1/triagens/{triagem_id}/feedback", status_code=204)
def feedback(triagem_id: str, body: FeedbackIn, x_user_role: str | None = Header(None)):
    if x_user_role != "gestor":
        raise HTTPException(403, "Sem permissao")
    if not repo.registrar_feedback(triagem_id, body.classificacaoMedico):
        raise HTTPException(404, "Triagem nao encontrada")
    return Response(status_code=204)
