"""Recuperacao: os trechos da base mais proximos da queixa.

Fora do caminho critico: se o ChromaDB cair, travar ou estiver vazio, devolve lista vazia e a triagem segue.
Para ver no terminal:  python -m app.rag.busca "dor no peito que vai para o braco"
"""

import logging
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as Estourou

import httpx

from . import ingestao
from .embeddings import Embeddings
from .vetores import Vetores

log = logging.getLogger("triagem.rag")
TOP_K = 5
CORTE = 0.54  # abaixo disso o trecho e descartado; como foi escolhido: docs/arquitetura/rag-triagem.md
PRAZO = 1.5  # segundos para o ChromaDB, incluindo a resolucao de nome (que o timeout do httpx nao cobre)
PAUSA = 5.0  # depois de uma falha, segundos sem tentar de novo


class Buscador:
    def __init__(self, vetores: Vetores | None = None, emb: Embeddings | None = None):
        self.vetores = vetores or Vetores()
        self.emb = emb or Embeddings()
        self._nome = ingestao.nome_colecao()
        self._id = None
        self._pausado_ate = 0.0
        self._trava = threading.Lock()
        self._pool = ThreadPoolExecutor(4, thread_name_prefix="chroma")

    def _colecao(self) -> str | None:
        with self._trava:
            if self._id is None:
                c = self.vetores.colecao(self._nome)
                if ingestao.completa(c):
                    self._id = c["id"]
            return self._id

    def buscar(self, texto: str, k: int = TOP_K, corte: float = CORTE) -> list[dict]:
        if time.monotonic() < self._pausado_ate:
            return []
        vetor = self.emb.gerar([texto])[0]
        try:
            achados = self._pool.submit(self._consultar, vetor, k).result(timeout=PRAZO)
        except (httpx.HTTPError, KeyError, ValueError, Estourou) as e:
            log.warning("base de conhecimento indisponivel: %r", e)
            self._id = None  # a colecao pode ter sido refeita
            self._pausado_ate = time.monotonic() + PAUSA
            return []
        if achados is None:
            log.warning("base de conhecimento ainda nao ingerida")
            self._pausado_ate = time.monotonic() + PAUSA
            return []
        return [a for a in achados if a["similaridade"] >= corte]

    def _consultar(self, vetor, k):
        id_ = self._colecao()
        return None if id_ is None else self.vetores.buscar(id_, vetor, k)

    def estado(self) -> str:
        """Resultado do ultimo acesso; nao consulta o ChromaDB, para nao atrasar o /ready."""
        return "up" if self._id and time.monotonic() >= self._pausado_ate else "down"


def fontes(achados: list[dict]) -> list[dict]:
    """Citacoes sem repeticao, na ordem de relevancia."""
    vistas, saida = set(), []
    for a in achados:
        f = {k: a[k] for k in ("documento", "secao", "pagina")}
        if tuple(f.values()) not in vistas:
            vistas.add(tuple(f.values()))
            saida.append(f)
    return saida


if __name__ == "__main__":
    for a in Buscador().buscar(" ".join(sys.argv[1:])):
        onde = f"{a['documento']}, p. {a['pagina']}" if a["pagina"] else a["documento"]
        print(f"{a['similaridade']:.3f}  {onde} | {a['secao']}\n       {a['texto'][:160]}...")
