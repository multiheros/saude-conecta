"""Triagens no MongoDB do proprio servico."""

import os
from datetime import datetime, timezone

from pymongo import ASCENDING, MongoClient
from pymongo.errors import DuplicateKeyError

SETE_DIAS = 7 * 24 * 3600


class SagaEncerrada(Exception):
    pass


def agora():
    t = datetime.now(timezone.utc)
    return t.replace(microsecond=t.microsecond // 1000 * 1000)  # precisao do MongoDB: a repeticao devolve o mesmo valor


class Repositorio:
    def __init__(self, env=os.environ):
        self.cliente = MongoClient(
            host=env["DB_HOST"], port=int(env.get("DB_PORT", "27017")),
            username=env.get("DB_USER"), password=env.get("DB_PASSWORD"),
            serverSelectionTimeoutMS=2000, connectTimeoutMS=2000, socketTimeoutMS=5000, tz_aware=True,
        )
        self.db = self.cliente[env.get("DB_NAME", "triagem")]
        self._indices = False

    def preparar(self):
        """Cria os indices; idempotente. Chamado no primeiro acesso."""
        if self._indices:
            return
        self.db.triagens.create_index([("sagaId", ASCENDING)], unique=True)
        self.db.encerradas.create_index([("em", ASCENDING)], expireAfterSeconds=SETE_DIAS)
        self._indices = True

    def ping(self) -> bool:
        try:
            self.cliente.admin.command("ping")
            return True
        except Exception:
            return False

    def da_saga(self, saga_id: str):
        self.preparar()
        return self.db.triagens.find_one({"sagaId": saga_id})

    def criar(self, doc: dict) -> dict:
        """Grava uma triagem por SAGA; repetir devolve a existente.

        Insere e so depois confere se a SAGA foi encerrada. Como o descarte faz o inverso
        (marca e depois apaga), em qualquer intercalacao a triagem atrasada nao sobrevive.
        """
        self.preparar()
        try:
            self.db.triagens.insert_one(doc)
        except DuplicateKeyError:
            doc = self.db.triagens.find_one({"sagaId": doc["sagaId"]}) or doc
        if self.db.encerradas.find_one({"_id": doc["sagaId"]}):
            self.db.triagens.delete_one({"sagaId": doc["sagaId"], "temporaria": True})
            raise SagaEncerrada
        return doc

    def descartar(self, saga_id: str):
        self.preparar()
        self.db.encerradas.update_one({"_id": saga_id}, {"$setOnInsert": {"em": agora()}}, upsert=True)
        self.db.triagens.delete_many({"sagaId": saga_id, "temporaria": True})

    def efetivar(self, saga_id: str, agendamento_id: str):
        self.preparar()
        self.db.triagens.update_one({"sagaId": saga_id}, {"$set": {"temporaria": False, "agendamentoId": agendamento_id}})

    def buscar(self, triagem_id: str):
        return self.db.triagens.find_one({"_id": triagem_id})

    def registrar_feedback(self, triagem_id: str, classificacao: str) -> bool:
        r = self.db.triagens.update_one({"_id": triagem_id}, {"$set": {"classificacaoMedico": classificacao}})
        return r.matched_count == 1
