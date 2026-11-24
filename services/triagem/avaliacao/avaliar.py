"""Avaliacao do RAG: cada pergunta em 3 condicoes e 3 execucoes, com o modelo real.

  sem       o mesmo prompt, sem nenhum trecho recuperado
  caderno   so trechos do Caderno de Atencao Basica (top-5)
  completo  o que esta em producao: Caderno + protocolo interno (top-5)

Mede a saida do modelo, sem cache, sem as regras de seguranca e com prazo folgado (a resiliencia e medida a parte).
Guarda cada chamada em resultados.jsonl e retoma de onde parou, porque a cota gratuita e curta.
Uso: scripts/avaliar_rag.sh
"""

import json
import os
import statistics
import sys
import time
from collections import Counter
from pathlib import Path

from langchain_google_genai import ChatGoogleGenerativeAI

from app import triador as t
from app.llm import modelo as fabrica
from app.rag import base
from app.rag.busca import Buscador
from app.regras import NIVEIS

AQUI = Path(os.getenv("AVALIACAO_DIR", Path(__file__).parent))
SAIDA = AQUI / "resultados.jsonl"
EXECUCOES, RITMO = 3, 4.5  # segundos entre chamadas: 15 por minuto
CONDICOES = ("sem", "caderno", "completo")


def recuperar(b: Buscador, queixa: str, condicao: str) -> list[dict]:
    if condicao == "sem":
        return []
    b._pausado_ate = 0.0
    achados = b.buscar(queixa, k=40)
    if condicao == "caderno":
        achados = [a for a in achados if a["pagina"]]
    return achados[:5]


def coletar():
    perguntas = json.loads((AQUI / "perguntas.json").read_text())
    feitos = {(r["id"], r["condicao"], r["execucao"]) for r in ler()} if SAIDA.exists() else set()
    b = Buscador()
    assert b.buscar("dor no peito"), "base de conhecimento fora do ar"
    m: ChatGoogleGenerativeAI = fabrica.criar()
    m = m.model_copy(update={"timeout": 30.0})
    secoes = {x["secao"]: x["texto"] for x in base.blocos() if x["pagina"] is None}
    prompt = t.CLASSIFICAR.partial(escala=secoes["Escala de cinco níveis e prazos"], especialidades=secoes["Especialidade indicada"])
    cadeia = m.with_structured_output(t.Classificacao, include_raw=True)
    total = len(perguntas) * len(CONDICOES) * EXECUCOES
    falhas_seguidas = 0
    with SAIDA.open("a") as f:
        for execucao in range(1, EXECUCOES + 1):
            for p in perguntas:
                for condicao in CONDICOES:
                    if (p["id"], condicao, execucao) in feitos:
                        continue
                    trechos = recuperar(b, t.sem_dados_pessoais(p["queixa"]), condicao)
                    mensagens = prompt.invoke({"contexto": t.numerar(trechos), "faixa": t.faixa_etaria(p["idade"]), "queixa": p["queixa"]})
                    for tentativa in range(8):
                        t0 = time.monotonic()
                        try:
                            r = cadeia.invoke(mensagens)
                            s = r["parsed"]
                            if s is None:
                                raise ValueError(str(r["parsing_error"])[:120])
                            break
                        except Exception as e:  # noqa: BLE001
                            texto = str(e)
                            if "PerDay" in texto:
                                print("cota diaria esgotada; rode de novo amanha", flush=True)
                                return
                            print(f"  {p['id']}/{condicao}/{execucao}: {texto[:110]}", flush=True)
                            time.sleep(62 if "429" in texto else 8 * (tentativa + 1))
                    else:
                        falhas_seguidas += 1
                        if falhas_seguidas >= 3:
                            print("provedor fora; rode de novo mais tarde", flush=True)
                            return
                        continue
                    falhas_seguidas = 0
                    uso = r["raw"].usage_metadata
                    f.write(json.dumps({
                        "id": p["id"], "condicao": condicao, "execucao": execucao, "ms": round((time.monotonic() - t0) * 1000),
                        "nivel": s.classificacao, "especialidade": s.especialidade, "justificativa": s.justificativa, "confianca": s.confianca,
                        "trechos": s.trechos, "recuperados": [{k: x[k] for k in ("documento", "secao", "pagina", "similaridade")} for x in trechos],
                        "entrada": uso["input_tokens"], "saida": uso["output_tokens"], "modelo": m.model, "base": base.versao(), "prompt": t.VERSAO_PROMPT,
                    }, ensure_ascii=False) + "\n")
                    f.flush()
                    feitos.add((p["id"], condicao, execucao))
                    print(f"{len(feitos)}/{total} {p['id']}/{condicao}/{execucao} {s.classificacao}", flush=True)
                    time.sleep(RITMO)


def ler():
    return [json.loads(x) for x in SAIDA.read_text().splitlines() if x.strip()]


def relatorio():
    perguntas = {p["id"]: p for p in json.loads((AQUI / "perguntas.json").read_text())}
    rs = ler()
    print(f"{len(rs)} respostas; modelo {rs[0]['modelo']}, base {rs[0]['base']}, prompt {rs[0]['prompt']}\n")
    print("| Medida | Sem recuperação | Só Caderno | Completo |\n|---|---|---|---|")

    def linha(nome, f):
        print(f"| {nome} | " + " | ".join(f([r for r in rs if r["condicao"] == c]) for c in CONDICOES) + " |")
    n = lambda l: len(l)  # noqa: E731
    certo = lambda r: r["nivel"] in perguntas[r["id"]]["nivel"]  # noqa: E731
    pior = lambda r: min(NIVEIS.index(x) for x in perguntas[r["id"]]["nivel"])  # noqa: E731
    menos = lambda r: NIVEIS.index(r["nivel"]) > max(NIVEIS.index(x) for x in perguntas[r["id"]]["nivel"])  # noqa: E731
    linha("Nível esperado", lambda l: f"{sum(map(certo, l))}/{n(l)}")
    linha("Menos urgente que o esperado (perigoso)", lambda l: f"{sum(map(menos, l))}/{n(l)}")
    linha("Mais urgente que o esperado", lambda l: f"{sum(NIVEIS.index(r['nivel']) < pior(r) for r in l)}/{n(l)}")
    linha("Mesmo nível nas 3 execuções", lambda l: f"{sum(len({r['nivel'] for r in l if r['id'] == i}) == 1 for i in perguntas)}/{len(perguntas)}")
    linha("Confiança média", lambda l: f"{statistics.mean(r['confianca'] for r in l):.2f}")
    linha("Tokens de entrada (média)", lambda l: f"{statistics.mean(r['entrada'] for r in l):.0f}")
    linha("Tokens de saída (média)", lambda l: f"{statistics.mean(r['saida'] for r in l):.0f}")
    linha("Tempo do modelo, mediana", lambda l: f"{statistics.median(r['ms'] for r in l):.0f} ms")
    print("\n| # | Esperado | Capítulo no top-5 | Página no top-5 | Sem | Só Caderno | Completo |\n|---|---|---|---|---|---|---|")
    cap = pag = 0
    for i, p in perguntas.items():
        rec = next((r["recuperados"] for r in rs if r["id"] == i and r["condicao"] == "caderno"), [])
        c = any(x["secao"].startswith(p["capitulo"] + " ") for x in rec)
        g = any(x["secao"].startswith(p["capitulo"] + " ") and x["pagina"] in p["paginas"] for x in rec)
        cap, pag = cap + c, pag + g
        cel = ["".join(f"{k} " if v == 3 else f"{k}×{v} " for k, v in Counter(r["nivel"] for r in rs if r["id"] == i and r["condicao"] == x).items()).strip() for x in CONDICOES]
        print(f"| {i} | {' ou '.join(p['nivel'])} | {'sim' if c else 'não'} | {'sim' if g else 'não'} | " + " | ".join(cel) + " |")
    print(f"\nRecuperação (só Caderno): capítulo certo em {cap}/{len(perguntas)}, página certa em {pag}/{len(perguntas)}")


if __name__ == "__main__":
    coletar() if len(sys.argv) < 2 else relatorio()
