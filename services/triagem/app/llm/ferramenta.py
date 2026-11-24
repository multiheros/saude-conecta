"""Tool `consultar_horarios`: o modelo consulta a agenda real (modelo de leitura do Agendamento)."""

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Literal

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

log = logging.getLogger("triagem.agenda")
MAXIMO = 6


class AgendaIndisponivel(Exception):
    pass


class Agenda:
    def __init__(self, env=os.environ):
        self.http = httpx.Client(base_url=env.get("AGENDAMENTO_URL", "http://agendamento:8002"), timeout=httpx.Timeout(1.5, connect=0.5), trust_env=False)

    def livres(self, ubs_id: str, especialidade: str, prazo_horas: int, correlacao: str = "") -> list[dict]:
        """Primeiros horarios livres. Se nao houver dentro do prazo, os proximos, marcados como fora dele."""
        try:
            r = self.http.get("/api/v1/slots", params={"ubsId": ubs_id, "especialidade": especialidade},
                              headers={"X-User-Role": "servico", "X-Correlation-Id": correlacao})
            r.raise_for_status()
            slots = r.json()
        except (httpx.HTTPError, ValueError) as e:
            log.warning("agenda indisponivel: %r", e)
            raise AgendaIndisponivel from e
        limite = datetime.now(timezone.utc) + timedelta(hours=prazo_horas)
        todos = [{"slotId": s["id"], "inicio": s["inicio"], "especialidade": s["especialidade"],
                  "dentroDoPrazo": datetime.fromisoformat(s["inicio"]) <= limite} for s in slots]
        return ([s for s in todos if s["dentroDoPrazo"]] or todos)[:MAXIMO]


class Argumentos(BaseModel):
    especialidade: Literal["Clínica Geral", "Pediatria", "Ginecologia"] = Field(description="Especialidade indicada na triagem")
    prazo_horas: int = Field(ge=1, le=360, description="Prazo maximo em horas, conforme o nivel de urgencia")


def consultar_horarios(agenda: Agenda, ubs_id: str, prazo_maximo: int, correlacao: str = "") -> StructuredTool:
    """A UBS e o prazo maximo sao fixados aqui: o modelo nao escolhe outra unidade nem afrouxa a urgencia."""
    def executar(especialidade: str, prazo_horas: int) -> list[dict]:
        return agenda.livres(ubs_id, especialidade, min(prazo_horas, prazo_maximo), correlacao)

    return StructuredTool.from_function(
        executar, name="consultar_horarios", args_schema=Argumentos,
        description="Consulta os horarios livres reais na agenda da unidade do paciente.")
