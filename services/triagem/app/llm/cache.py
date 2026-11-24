"""Cache por chave das classificacoes do LLM, no MongoDB da Triagem, por 24 h. Guarda o hash, nunca a queixa."""

import hashlib
import json
import logging
from datetime import datetime, timezone

from pymongo import ASCENDING
from pymongo.errors import PyMongoError

log = logging.getLogger("triagem.llm")
UM_DIA = 24 * 3600


def chave(*partes) -> str:
    return hashlib.sha256(json.dumps(partes, ensure_ascii=False).encode()).hexdigest()


class Cache:
    """Nunca falha para quem chama: sem banco, e como se nao houvesse nada guardado."""

    def __init__(self, db):
        self.colecao = db.cache_llm
        self._pronto = False

    def ler(self, k: str) -> dict | None:
        try:
            doc = self.colecao.find_one({"_id": k})
            return doc and doc["valor"]
        except PyMongoError as e:
            log.warning("cache do LLM indisponivel: %s", type(e).__name__)
            return None

    def gravar(self, k: str, valor: dict):
        try:
            if not self._pronto:
                self.colecao.create_index([("em", ASCENDING)], expireAfterSeconds=UM_DIA)
                self._pronto = True
            self.colecao.replace_one({"_id": k}, {"valor": valor, "em": datetime.now(timezone.utc)}, upsert=True)
        except PyMongoError as e:
            log.warning("cache do LLM indisponivel: %s", type(e).__name__)
