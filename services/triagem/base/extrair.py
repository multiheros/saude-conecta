"""Extrai o texto do Caderno de Atencao Basica n. 28 (PDF) para JSONL, um bloco por secao e pagina.

Roda uma vez; o resultado fica versionado ao lado, e a ingestao parte dele. Para refazer (da raiz do repositorio):
  baixe os dois volumes para ./pdf como cab28-v1.pdf e cab28-v2.pdf (enderecos em base/README.md) e rode
  docker run --rm -v "$PWD/services/triagem/base:/base" -v "$PWD/pdf:/pdf:ro" python:3.12-slim \
    sh -c "pip install -q pdfplumber==0.11.11 && python /base/extrair.py /pdf"
"""

import json
import re
import sys
from pathlib import Path

# Paginas do PDF aproveitadas. Ficam de fora: capa, sumario, listas, referencias, anexos e a
# tabela girada das paginas 258 a 260 do volume II, que nao sai legivel.
VOLUMES = [
    ("cab28-v1", "Caderno de Atenção Básica nº 28, vol. I", range(20, 50)),
    ("cab28-v2", "Caderno de Atenção Básica nº 28, vol. II", range(16, 258)),
]
TOPO, MARGEM_ESQ, MARGEM_DIR = 75, 65, 550  # fora disso: cabecalho e numero da pagina


def fonte(linha):
    c = linha["chars"][len(linha["chars"]) // 2]
    return c["fontname"].split("+")[-1], round(c["size"])


def linhas(pagina):
    corpo = pagina.dedupe_chars(tolerance=1).filter(
        lambda o: o["object_type"] != "char" or (o["upright"] and o["top"] > TOPO and MARGEM_ESQ < o["x0"] < MARGEM_DIR))
    return corpo.extract_text_lines(return_chars=True)


def juntar(partes):
    """Une as linhas e desfaz a separacao silabica do fim de linha."""
    texto = ""
    for p in partes:
        if re.search(r"[a-zà-ú]-$", texto) and re.match(r"[a-zà-ú]", p):
            texto = texto[:-1] + p
        else:
            texto = f"{texto} {p}" if texto else p
    return re.sub(r"\s+", " ", texto).strip()


def titulo(texto):
    """Titulos em caixa alta viram minusculas, que o modelo de embeddings entende melhor; siglas ficam."""
    if not texto.isupper():
        return texto
    numero, _, resto = texto.partition(" ")
    palavras = [p if p in ("(RCP)", "RCP") else p.lower() for p in resto.split()]
    return f"{numero} {' '.join(palavras)[:1].upper()}{' '.join(palavras)[1:]}"


def extrair(caminho, documento, paginas):
    import pdfplumber

    blocos, capitulo, secao, partes = [], "", "", []

    def fechar(pagina):
        if texto := juntar(partes):
            blocos.append({"documento": documento, "secao": " > ".join(titulo(x) for x in (capitulo, secao) if x), "pagina": pagina, "texto": texto})
        partes.clear()

    with pdfplumber.open(caminho) as pdf:
        for n in paginas:
            impressa, titulo_aberto = n - 1, None  # a capa nao e numerada
            for linha in linhas(pdf.pages[n - 1]):
                nome, tamanho = fonte(linha)
                texto = linha["text"].strip()
                # Titulos: capitulo em corpo 12, secao em 9 ou 10. As aberturas de capitulo do volume I
                # usam corpo 22 ou maior e nao trazem texto.
                nivel = None
                if "Frutiger75-Black" in nome and tamanho >= 9:
                    nivel = "capitulo" if tamanho >= 12 else "secao"
                if nivel:
                    if nivel == titulo_aberto:  # titulo em duas linhas
                        if nivel == "capitulo":
                            capitulo = f"{capitulo} {texto}"
                        else:
                            secao = f"{secao} {texto}"
                    else:
                        fechar(impressa)
                        if nivel == "capitulo":
                            capitulo, secao = texto, ""
                        else:
                            secao = texto
                    titulo_aberto = nivel
                    continue
                titulo_aberto = None
                if tamanho < 20 and texto not in ("(continua...)", "(continuação)", "(conclusão)"):
                    partes.append(texto)
            fechar(impressa)
    return blocos


if __name__ == "__main__":
    origem = Path(sys.argv[1])
    for nome, documento, paginas in VOLUMES:
        blocos = extrair(origem / f"{nome}.pdf", documento, paginas)
        saida = Path(__file__).parent / f"{nome}.jsonl"
        saida.write_text("".join(json.dumps(b, ensure_ascii=False) + "\n" for b in blocos), encoding="utf-8")
        print(nome, len(blocos), "blocos,", sum(len(b["texto"].split()) for b in blocos), "palavras")
