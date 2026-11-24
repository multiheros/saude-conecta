"""Confirmacao com 12 perguntas novas, depois dos ajustes: o resultado final de producao (modelo + regras) e o das
regras sozinhas (o fallback). Uma execucao. Uso: scripts/avaliar_rag.sh confirmar"""

import json
import os
import time
from pathlib import Path

from app import regras
from app import triador as t
from app.llm import modelo as fabrica
from app.llm import protecao
from app.rag.busca import Buscador

AQUI = Path(os.getenv("AVALIACAO_DIR", Path(__file__).parent))
protecao.TENTATIVA_S, t.TETO_S = 25.0, 60.0  # mede a resposta, nao a resiliencia


def main():
    b, linhas = Buscador(), []
    modelo = fabrica.criar().model_copy(update={"timeout": 25.0})
    for p in json.loads((AQUI / "confirmacao.json").read_text()):
        for _ in range(8):
            b._pausado_ate = 0.0
            r = t.Triador(b, modelo).classificar(p["queixa"], p["idade"])
            if r["origem"] == "LLM":
                break
            time.sleep(20)
        so_regras = regras.classificar(p["queixa"], p["idade"])["classificacao"]
        linhas.append({"id": p["id"], "esperado": p["nivel"], "producao": r["classificacao"], "origem": r["origem"], "regras": so_regras,
                       "justificativa": r["justificativa"], "fontes": r["fontes"]})
        print(p["id"], p["nivel"], r["origem"], r["classificacao"], "| regras:", so_regras, "|", r["justificativa"][:150], flush=True)
        time.sleep(5)
    (AQUI / "confirmacao-resultado.json").write_text(json.dumps(linhas, indent=1, ensure_ascii=False) + "\n")
    N = regras.NIVEIS.index
    for nome, k in (("producao", "producao"), ("so regras", "regras")):
        menos = sum(N(x[k]) > max(map(N, x["esperado"])) for x in linhas)
        print(f"{nome}: esperado {sum(x[k] in x['esperado'] for x in linhas)}/{len(linhas)}, menos urgente {menos}")


main()
