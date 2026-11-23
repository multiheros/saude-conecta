import os
import socket

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(title="SaudeConecta - Triagem IA", version="1.0.0")


def check_db() -> str:
    host = os.getenv("DB_HOST")
    if not host:
        return "n/a"
    try:
        with socket.create_connection((host, int(os.getenv("DB_PORT", "27017"))), timeout=1.5):
            return "up"
    except OSError:
        return "down"


# Vivo: o processo responde. Nao depende do banco.
@app.get("/live")
def live():
    return {"service": "triagem", "status": "ok", "instance": socket.gethostname()}


# Pronto: pode receber trafego (banco acessivel).
@app.get("/ready")
def ready():
    db = check_db()
    return JSONResponse(
        status_code=503 if db == "down" else 200,
        content={
            "service": "triagem",
            "status": "degraded" if db == "down" else "ok",
            "db": db,
            "instance": socket.gethostname(),
        },
    )


class TriagemIn(BaseModel):
    pacienteId: int
    sintomas: str


@app.post("/api/v1/triagens", status_code=201)
def criar_triagem(body: TriagemIn):
    # Classificacao simulada; o pipeline LLM + RAG entra na Parte 4.
    urgente = any(p in body.sintomas.lower() for p in ("dor no peito", "falta de ar"))
    return {
        "id": 1,
        "pacienteId": body.pacienteId,
        "classificacao": "LARANJA" if urgente else "VERDE",
        "justificativa": "Classificacao simulada (placeholder da Parte 3)",
    }
