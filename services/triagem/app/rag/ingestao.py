"""Ingestao da base no ChromaDB:  python -m app.rag.ingestao

Cada versao da base (conteudo, modelo e divisao) tem a sua colecao. Repetir com a mesma versao nao faz nada; uma
ingestao interrompida recomeca do zero sem duplicar, porque o id do trecho vem do conteudo. A colecao so e usada
depois de marcada como completa.
"""

import os
import sys
import time

import httpx

from . import base
from .embeddings import Embeddings
from .vetores import Vetores

LOTE = 64


def nome_colecao() -> str:
    return f"base-{base.versao()}"


def completa(colecao: dict | None) -> bool:
    return bool(colecao and (colecao.get("metadata") or {}).get("completa"))


def ingerir(vetores: Vetores, emb: Embeddings | None = None, avisar=print) -> dict:
    nome = nome_colecao()
    existente = vetores.colecao(nome)
    if completa(existente) and vetores.contar(existente["id"]) == existente["metadata"]["trechos"]:
        avisar(f"base {nome} ja esta completa ({existente['metadata']['trechos']} trechos)")
        return {"colecao": nome, "trechos": existente["metadata"]["trechos"], "novos": 0}
    emb = emb or Embeddings(threads=int(os.getenv("EMBEDDING_THREADS", "0")))  # 0: todos os nucleos
    trechos = base.trechos(emb.contar)
    id_ = vetores.criar(nome)["id"]
    t0 = time.monotonic()
    for i in range(0, len(trechos), LOTE):
        lote = trechos[i:i + LOTE]
        vetores.gravar(id_, lote, emb.gerar([base.texto_para_vetor(t) for t in lote]))
    total = vetores.contar(id_)
    if total != len(trechos):
        raise RuntimeError(f"gravados {total} de {len(trechos)} trechos")
    vetores.marcar(id_, {"completa": True, "trechos": total, "modelo": base.MODELO})
    for velha in vetores.nomes():
        if velha.startswith("base-") and velha != nome:
            vetores.apagar(velha)
    avisar(f"base {nome}: {total} trechos em {time.monotonic() - t0:.0f} s")
    return {"colecao": nome, "trechos": total, "novos": total}


def main(tentativas=60):
    vetores = Vetores(leitura=30)
    for n in range(tentativas):
        try:
            return ingerir(vetores)
        except httpx.TransportError as e:  # o ChromaDB ainda nao subiu, ou caiu no meio
            if n == tentativas - 1:
                raise
            print("chromadb indisponivel, nova tentativa:", e or type(e).__name__, flush=True)
            time.sleep(2)


if __name__ == "__main__":
    main()
    sys.exit(0)
