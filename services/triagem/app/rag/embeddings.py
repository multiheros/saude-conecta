"""Embeddings locais (gte-multilingual-base, ONNX int8, 768 dimensoes). O modelo vem na imagem: sem rede e sem custo."""

import os
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

PASTA = Path(os.getenv("MODELO_DIR", "/modelo"))
LIMITE = 512  # tokens; os trechos ficam bem abaixo (base.MAX_TOKENS)
LOTE = 8


class Embeddings:
    def __init__(self, threads: int = int(os.getenv("EMBEDDING_THREADS", "2"))):
        self.tok = Tokenizer.from_file(str(PASTA / "tokenizer.json"))
        self.tok.no_truncation()
        self.tok.no_padding()
        op = ort.SessionOptions()
        op.intra_op_num_threads = threads
        op.enable_cpu_mem_arena = False  # devolve a memoria entre as chamadas
        self.sessao = ort.InferenceSession(str(PASTA / "model.onnx"), op, providers=["CPUExecutionProvider"])
        self.entradas = {e.name for e in self.sessao.get_inputs()}
        self.pad = self.tok.token_to_id("<pad>")

    def contar(self, palavra: str) -> int:
        return len(self.tok.encode(" " + palavra, add_special_tokens=False).ids)

    def gerar(self, textos: list[str]) -> list[list[float]]:
        saida = []
        for i in range(0, len(textos), LOTE):
            ids = [self._ids(t) for t in textos[i:i + LOTE]]
            largura = max(map(len, ids))
            entrada = np.array([x + [self.pad] * (largura - len(x)) for x in ids], dtype=np.int64)
            mascara = np.array([[1] * len(x) + [0] * (largura - len(x)) for x in ids], dtype=np.int64)
            dados = {"input_ids": entrada, "attention_mask": mascara, "token_type_ids": np.zeros_like(entrada)}
            v = self.sessao.run(None, {k: d for k, d in dados.items() if k in self.entradas})[0][:, 0]  # vetor do <s> (CLS)
            saida += (v / np.linalg.norm(v, axis=1, keepdims=True)).tolist()
        return saida

    def _ids(self, texto: str) -> list[int]:
        ids = self.tok.encode(texto).ids
        return ids if len(ids) <= LIMITE else ids[:LIMITE - 1] + ids[-1:]
