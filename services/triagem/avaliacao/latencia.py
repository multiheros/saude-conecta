"""Latencia por etapa e custo, com a configuracao de producao (prazos, nova tentativa, circuito) e o modelo real.

30 queixas sem cache, as mesmas com cache, o fallback com circuito aberto e 8 recomendacoes completas.
Grava latencia.json e mostra as tabelas. Uso: scripts/avaliar_rag.sh latencia
"""

import json
import os
import sys
import time
from pathlib import Path

from app import triador as t
from app import regras
from app.llm import cache as cache_llm
from app.llm import modelo as fabrica
from app.llm.cache import Cache
from app.rag.busca import Buscador
from app.repositorio import Repositorio

AQUI = Path(os.getenv("AVALIACAO_DIR", Path(__file__).parent))
RITMO = 5.0
PRECO_ENTRADA, PRECO_SAIDA = 0.30, 2.50  # US$ por 1 milhao de tokens, gemini-3.5-flash-lite (camada paga), lido em 24/11/2026
SINTOMAS = ["dor no joelho direito", "tosse seca", "azia", "dor de ouvido", "coceira no braço", "dor nas costas", "nariz entupido", "dor de dente", "olho vermelho", "cansaço"]
TEMPOS = ["desde ontem", "há quatro dias", "há duas semanas, indo e voltando"]


class AgendaFixa:
    def livres(self, _ubs, especialidade, _prazo, _c=""):
        return [{"slotId": f"00000000-0000-4000-8000-00000000000{i}", "inicio": f"2026-12-01T1{i}:00:00Z", "especialidade": especialidade, "dentroDoPrazo": True} for i in range(6)]


def cronometrar(obj, nome, lista):
    original = getattr(obj, nome)

    def f(*a, **k):
        t0 = time.monotonic()
        try:
            return original(*a, **k)
        finally:
            lista.append((time.monotonic() - t0) * 1000)
    setattr(obj, nome, f)


def chave_de(tri, q):
    return cache_llm.chave(regras.normalizar(t.sem_dados_pessoais(q)), t.faixa_etaria(40), tri.modelo.model, t.VERSAO_PROMPT, tri._versao_base)


def pct(l, p):
    l = sorted(l)
    v = l[min(len(l) - 1, int(len(l) * p))] if l else None
    return v if v is None else round(v, 1 if v < 10 else None)


def resumo(l):
    return {"n": len(l), "p50": pct(l, 0.5), "p95": pct(l, 0.95), "max": pct(l, 1)}


def medir_cache(b, m, queixas):
    """Cache no MongoDB real, ja preenchido: nao chama o modelo."""
    tri = t.Triador(b, m, Cache(Repositorio().db), AgendaFixa())
    valor = {"classificacao": "VERDE", "justificativa": "x" * 200, "especialidadeSugerida": "Clínica Geral", "confianca": 0.9, "origem": "LLM",
             "fontes": [{"documento": "Caderno", "secao": "2.2", "pagina": 32}] * 5}
    tempos = []
    for q in queixas:
        tri.cache.gravar(chave_de(tri, q), valor)
    for q in queixas:
        t0 = time.monotonic()
        assert tri.classificar(q, 40)["origem"] == "CACHE"
        tempos.append((time.monotonic() - t0) * 1000)
    return tempos


def main():
    b, m = Buscador(), fabrica.criar()
    b.buscar("aquecimento")
    emb, busca, modelo = [], [], []
    cronometrar(b.emb, "gerar", emb)
    cronometrar(b.vetores, "buscar", busca)
    tri = t.Triador(b, m, None, AgendaFixa())
    cronometrar(tri.protecao, "executar", modelo)
    queixas = [f"{s} {q}" for q in TEMPOS for s in SINTOMAS]

    sem, origens = [], {}
    for i, q in enumerate(queixas):
        t0 = time.monotonic()
        r = tri.classificar(q, 40)
        sem.append((time.monotonic() - t0) * 1000)
        origens[q] = r["origem"]
        print(f"{i + 1}/30 {r['origem']} {sem[-1]:.0f} ms", flush=True)
        time.sleep(RITMO if tri.protecao.circuito.estado == "FECHADO" else 31)
    ind = tri.indicadores()
    triagem = {"etapas": {"embedding": resumo(emb), "busca": resumo(busca), "modelo": resumo(modelo)}, "total": resumo(sem),
               "porModelo": resumo([x for x, q in zip(sem, queixas) if origens[q] == "LLM"]), "llm": sum(o == "LLM" for o in origens.values()), "indicadores": ind}
    com = medir_cache(b, m, queixas)
    tri.protecao.circuito.aberto_ate = time.monotonic() + 999
    aberto = []
    for q in queixas:
        t0 = time.monotonic()
        assert tri.classificar(q + " e enjoo", 40)["origem"] == "REGRAS"
        aberto.append((time.monotonic() - t0) * 1000)
    tri.protecao.circuito.sucesso()

    rec, antes = [], tri.indicadores()
    por_modelo = 0
    for i, s in enumerate(SINTOMAS[:8]):
        time.sleep(15 if tri.protecao.circuito.estado == "FECHADO" else 31)
        t0 = time.monotonic()
        r = tri.recomendar(f"{s} que piora à noite", 40, "ubs")
        rec.append((time.monotonic() - t0) * 1000)
        por_modelo += r["origem"] == "LLM" and r["origemHorarios"] == "LLM"
        print(f"recomendacao {i + 1}/8 {r['origem']}/{r['origemHorarios']} {rec[-1]:.0f} ms", flush=True)
    depois = tri.indicadores()
    ok = lambda x: x["chamadas"] - sum(x["falhasPorMotivo"].values())  # noqa: E731
    dif = {k: depois[k] - antes[k] for k in ("tokensEntrada", "tokensSaida", "chamadas")}
    saida = {"modelo": m.model, "precoEntrada": PRECO_ENTRADA, "precoSaida": PRECO_SAIDA, "triagem": triagem, "cache": resumo(com), "circuitoAberto": resumo(aberto),
             "recomendacao": {"total": resumo(rec), "pelo modelo": por_modelo, **dif, "chamadasOk": ok(depois) - ok(antes)},
             "tokensPorTriagem": {"entrada": round(ind["tokensEntrada"] / max(1, ok(ind))), "saida": round(ind["tokensSaida"] / max(1, ok(ind)))}}
    (AQUI / "latencia.json").write_text(json.dumps(saida, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps(saida, indent=1, ensure_ascii=False))


if len(sys.argv) > 1:  # so o cache, aproveitando as outras medidas
    d = json.loads((AQUI / "latencia.json").read_text())
    d["cache"] = resumo(medir_cache(Buscador(), fabrica.criar(), [f"{s} {q}" for q in TEMPOS for s in SINTOMAS]))
    (AQUI / "latencia.json").write_text(json.dumps(d, indent=1, ensure_ascii=False) + "\n")
    print(d["cache"])
else:
    main()
