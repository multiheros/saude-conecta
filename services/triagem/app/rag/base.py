"""Base de conhecimento: le os blocos, divide em trechos e calcula a versao."""

import hashlib
import itertools
import json
import os
from pathlib import Path

PASTA = Path(os.getenv("BASE_DIR", Path(__file__).parents[2] / "base"))
CADERNOS = ["cab28-v1.jsonl", "cab28-v2.jsonl"]
PROTOCOLO = "protocolo-interno.md"
MAX_TOKENS, SOBREPOSICAO = 250, 40
# Muda a versao da base quando muda o modo de gerar os vetores.
MODELO = "gte-multilingual-base-int8@2edbf5e"
FORMATO = f"1|{MODELO}|{MAX_TOKENS}|{SOBREPOSICAO}"


def versao() -> str:
    h = hashlib.sha256(FORMATO.encode())
    for nome in [*CADERNOS, PROTOCOLO]:
        h.update((PASTA / nome).read_bytes())
    return h.hexdigest()[:12]


def blocos() -> list[dict]:
    saida = []
    for nome in CADERNOS:
        with open(PASTA / nome, encoding="utf-8") as f:
            saida += [json.loads(linha) for linha in f]
    secao, partes = None, []
    for linha in [*(PASTA / PROTOCOLO).read_text(encoding="utf-8").splitlines(), "## "]:
        if linha.startswith("## "):
            if secao:
                saida.append({"documento": "Protocolo interno SaúdeConecta", "secao": secao, "pagina": None, "texto": " ".join(partes)})
            secao, partes = linha[3:].strip(), []
        elif linha.strip():
            partes.append(linha.strip())
    return saida


def trechos(contar_tokens) -> list[dict]:
    """Trechos de ate MAX_TOKENS dentro de uma secao. A secao pode atravessar paginas: vale a do inicio do trecho."""
    saida = []
    for (documento, secao), grupo in itertools.groupby(blocos(), key=lambda b: (b["documento"], b["secao"])):
        palavras = [(p, b["pagina"]) for b in grupo for p in b["texto"].split()]
        tam = [contar_tokens(p) for p, _ in palavras]
        inicio = 0
        while inicio < len(palavras):
            fim, soma = inicio, 0
            while fim < len(palavras) and (fim == inicio or soma + tam[fim] <= MAX_TOKENS):
                soma += tam[fim]
                fim += 1
            texto = " ".join(p for p, _ in palavras[inicio:fim])
            chave = f"{documento}|{secao}|{len(saida)}|{texto}"
            saida.append({"id": hashlib.sha256(chave.encode()).hexdigest()[:32], "documento": documento, "secao": secao,
                          "pagina": palavras[inicio][1], "texto": texto})
            if fim == len(palavras):
                break
            volta, soma = fim, 0
            while volta > inicio + 1 and soma + tam[volta - 1] <= SOBREPOSICAO:
                volta -= 1
                soma += tam[volta]
            inicio = volta
    return saida


def texto_para_vetor(trecho: dict) -> str:
    return f"{trecho['secao']}. {trecho['texto']}"
