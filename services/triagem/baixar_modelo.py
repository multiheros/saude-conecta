"""Baixa o modelo de embeddings (Apache 2.0) na construcao da imagem, com versao e hash fixos."""

import hashlib
import sys
import urllib.request
from pathlib import Path

URL = "https://huggingface.co/onnx-community/gte-multilingual-base/resolve/2edbf5e672aab465f9ed4c154a8b61791c082c69/"
ARQUIVOS = {
    "onnx/model_int8.onnx": ("model.onnx", "ab2bd164ebd8ca9003dc49a981b611e849b5d326f504c8873ba76e07fa6c0082"),
    "tokenizer.json": ("tokenizer.json", "3a56def25aa40facc030ea8b0b87f3688e4b3c39eb8b45d5702b3a1300fe2a20"),
}

for origem, (nome, esperado) in ARQUIVOS.items():
    destino = Path(sys.argv[1]) / nome
    h = hashlib.sha256()
    with urllib.request.urlopen(URL + origem, timeout=60) as r, open(destino, "wb") as f:
        while bloco := r.read(1 << 20):
            h.update(bloco)
            f.write(bloco)
    if h.hexdigest() != esperado:
        sys.exit(f"{nome}: hash {h.hexdigest()}, esperado {esperado}")
    print(nome, "ok", flush=True)
