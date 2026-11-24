"""RAG contra um ChromaDB real e descartavel, com uma parte da base (a base inteira leva cerca de 1 min)."""

import json
import re
import shutil
import socket
import threading
import time
import uuid

import pytest

from app import main
from app.consumidor import esperar
from app.rag import base, busca, ingestao
from app.rag.embeddings import Embeddings
from app.rag.vetores import Vetores
from app.triador import Triador

INTERNO = {"X-User-Role": "servico"}
CAPITULOS = ("2.2 ", "2.13 ")  # cefaleia e dor toracica
PASTA_REAL = base.PASTA


@pytest.fixture(scope="module")
def emb():
    e, feitos, gerar = Embeddings(), {}, Embeddings.gerar

    def com_memoria(textos):
        novos = [t for t in textos if t not in feitos]
        feitos.update(zip(novos, gerar(e, novos)))
        return [feitos[t] for t in textos]
    e.gerar = com_memoria  # varios testes ingerem a mesma parte da base
    return e


@pytest.fixture(scope="module")
def vetores():
    v = Vetores(leitura=30)

    def no_ar():
        try:
            return v.nomes() is not None
        except Exception:  # noqa: BLE001 - ainda subindo
            return False
    assert esperar(no_ar, 30)
    return v


@pytest.fixture
def parte(tmp_path, monkeypatch, vetores):
    """Base reduzida e ChromaDB vazio."""
    for nome in base.CADERNOS:
        linhas = [x for x in (PASTA_REAL / nome).read_text(encoding="utf-8").splitlines() if json.loads(x)["secao"].startswith(CAPITULOS)]
        (tmp_path / nome).write_text("\n".join(linhas) + "\n", encoding="utf-8")
    shutil.copy(PASTA_REAL / base.PROTOCOLO, tmp_path)
    monkeypatch.setattr(base, "PASTA", tmp_path)
    for n in vetores.nomes():
        vetores.apagar(n)
    return tmp_path


@pytest.fixture
def buscador(emb):
    return busca.Buscador(emb=emb)


# --- Base e divisao (base inteira)
def test_base_completa_e_bem_formada():
    blocos = base.blocos()
    cad = [b for b in blocos if b["pagina"]]
    assert len(cad) > 500 and sum(len(b["texto"].split()) for b in cad) > 90000
    assert {b["documento"] for b in blocos} == {"Caderno de Atenção Básica nº 28, vol. I", "Caderno de Atenção Básica nº 28, vol. II", "Protocolo interno SaúdeConecta"}
    assert len({b["secao"].split(" ")[0] for b in cad if b["secao"].startswith("2.") and b["documento"].endswith("II")}) == 28  # as 28 queixas
    texto = " ".join(b["texto"] for b in cad)
    assert "Ministério da Saúde | Secretaria" not in texto and "ACOLHIMENTO À DEMANDA ESPONTÂNEA –" not in texto  # cabecalhos
    assert not re.search(r"MMiinn", texto)  # letras duplicadas do PDF


def test_trechos_cabem_no_modelo_e_nada_se_perde(emb):
    ts = base.trechos(emb.contar)
    assert len({t["id"] for t in ts}) == len(ts)
    assert [t["id"] for t in base.trechos(emb.contar)] == [t["id"] for t in ts]
    # Com mais de 512 tokens o modelo cortaria o fim do trecho sem avisar.
    assert max(len(emb.tok.encode(base.texto_para_vetor(t)).ids) for t in ts) <= 512
    for secao in {b["secao"] for b in base.blocos()}:
        palavras = {p for b in base.blocos() if b["secao"] == secao for p in b["texto"].split()} if secao.startswith("2.13") else set()
        assert palavras <= {p for t in ts if t["secao"] == secao for p in t["texto"].split()}


def test_trechos_vizinhos_se_sobrepoem_e_levam_a_pagina_do_inicio(emb):
    ts = [t for t in base.trechos(emb.contar) if t["secao"].startswith("2.2 Cefaleia") and t["pagina"]]
    pares = [(a, b) for a, b in zip(ts, ts[1:]) if a["secao"] == b["secao"]]
    assert pares and all(" ".join(a["texto"].split()[-5:]) in b["texto"] for a, b in pares)
    for t in ts:
        bloco = next(b for b in base.blocos() if b["secao"] == t["secao"] and b["pagina"] == t["pagina"])
        assert t["texto"].split()[0] in bloco["texto"].split()


def test_versao_muda_com_o_conteudo(parte):
    antes = base.versao()
    assert base.versao() == antes
    with open(parte / base.PROTOCOLO, "a", encoding="utf-8") as f:
        f.write("\n## Nova secao\n\nTexto novo.\n")
    assert base.versao() != antes


# --- Ingestao
def test_ingerir_duas_vezes_nao_duplica(parte, vetores, emb):
    a = ingestao.ingerir(vetores, emb)
    b = ingestao.ingerir(vetores, emb)
    assert a["novos"] == a["trechos"] > 30 and b == a | {"novos": 0}
    assert vetores.contar(vetores.colecao(a["colecao"])["id"]) == a["trechos"]


def test_ingestao_interrompida_nao_e_usada_e_recomeca(parte, vetores, emb, buscador, monkeypatch):
    monkeypatch.setattr(ingestao, "LOTE", 10)
    monkeypatch.setattr(busca, "PAUSA", 0)
    gravar, n = vetores.gravar, []

    def falha_no_terceiro(*a):
        n.append(1)
        if len(n) == 3:
            raise RuntimeError("queda")
        gravar(*a)
    monkeypatch.setattr(vetores, "gravar", falha_no_terceiro)
    with pytest.raises(RuntimeError):
        ingestao.ingerir(vetores, emb)
    assert vetores.contar(vetores.colecao(ingestao.nome_colecao())["id"]) == 20
    assert buscador.buscar("dor no peito", corte=0) == []  # parcial: melhor sem fonte que com fonte errada
    monkeypatch.setattr(vetores, "gravar", gravar)
    r = ingestao.ingerir(vetores, emb)
    assert vetores.contar(vetores.colecao(r["colecao"])["id"]) == r["trechos"]
    assert buscador.buscar("dor no peito")


def test_base_com_trecho_faltando_e_refeita(parte, vetores, emb):
    r = ingestao.ingerir(vetores, emb)
    c = vetores.colecao(r["colecao"])
    vetores._pedir("POST", f"/{c['id']}/delete", json={"ids": [base.trechos(emb.contar)[0]["id"]]})
    assert ingestao.ingerir(vetores, emb)["novos"] == r["trechos"]
    assert vetores.contar(c["id"]) == r["trechos"]


def test_versao_nova_substitui_a_antiga(parte, vetores, emb):
    antiga = ingestao.ingerir(vetores, emb)["colecao"]
    (parte / base.PROTOCOLO).write_text("## Secao unica\n\nDor no peito: teste de versao nova.\n", encoding="utf-8")
    nova = ingestao.ingerir(vetores, emb)["colecao"]
    assert nova != antiga and vetores.nomes() == [nova]
    achados = busca.Buscador(emb=emb).buscar("dor no peito", k=20)
    assert any("versao nova" in a["texto"] for a in achados) and not any(a["secao"] == "Escala de cinco níveis e prazos" for a in achados)


# --- Recuperacao
def test_busca_traz_fonte_e_pagina(parte, vetores, emb, buscador):
    ingestao.ingerir(vetores, emb)
    achados = buscador.buscar("sinto um aperto no peito que vai para o braço esquerdo")
    assert len(achados) == busca.TOP_K
    assert [a["similaridade"] for a in achados] == sorted((a["similaridade"] for a in achados), reverse=True)
    assert achados[0]["secao"] == "Dor no peito" and achados[0]["pagina"] is None  # protocolo interno
    cad = next(a for a in achados if a["documento"].endswith("vol. II"))
    assert cad["secao"].startswith("2.13 Dor torácica") and 121 <= cad["pagina"] <= 129
    assert buscador.buscar("minha cabeça dói muito")[0]["secao"].startswith(("2.2 ", "Dor de cabeça"))


@pytest.mark.parametrize("fora", ["como faço um bolo de cenoura", "qual a capital da França", "vaga de emprego de motorista"])
def test_pergunta_fora_do_assunto_nao_traz_trecho(parte, vetores, emb, buscador, fora):
    ingestao.ingerir(vetores, emb)
    assert buscador.buscar(fora) == []


def test_fontes_sem_repeticao():
    a = {"documento": "d", "secao": "s", "pagina": 1, "texto": "x", "similaridade": 0.9}
    assert busca.fontes([a, a | {"texto": "y"}, a | {"pagina": 2}]) == [{"documento": "d", "secao": "s", "pagina": 1}, {"documento": "d", "secao": "s", "pagina": 2}]


# --- ChromaDB como dependencia falivel
class Mudo:
    """Aceita a conexao e nunca responde."""

    def __init__(self):
        self.s = socket.create_server(("127.0.0.1", 0))
        self.abertas = []
        threading.Thread(target=self._aceitar, daemon=True).start()

    def _aceitar(self):
        try:
            while True:
                self.abertas.append(self.s.accept()[0])
        except OSError:
            pass

    def env(self):
        return {"CHROMA_HOST": "127.0.0.1", "CHROMA_PORT": str(self.s.getsockname()[1])}


@pytest.mark.parametrize("caso", ["fora", "travado", "nome lento"])
def test_chroma_indisponivel_nao_segura_a_triagem(caso, emb, monkeypatch):
    mudo = Mudo()
    env = mudo.env()
    if caso == "fora":
        mudo.s.close()
    if caso == "nome lento":  # o timeout do httpx nao cobre a resolucao de nome
        env["CHROMA_HOST"] = "nome-lento"
        real = socket.getaddrinfo
        monkeypatch.setattr(socket, "getaddrinfo", lambda h, *a, **k: (time.sleep(4), real("127.0.0.1", *a, **k))[1] if h == "nome-lento" else real(h, *a, **k))
    b = busca.Buscador(vetores=Vetores(env), emb=emb)
    t0 = time.monotonic()
    assert b.buscar("dor no peito") == []
    assert time.monotonic() - t0 < busca.PRAZO + 1
    t0 = time.monotonic()
    assert b.buscar("dor no peito") == []  # em pausa: nem tenta
    assert time.monotonic() - t0 < 0.1
    assert b.estado() == "down"


def test_recupera_depois_da_pausa_e_se_a_colecao_for_refeita(parte, vetores, emb, buscador, monkeypatch):
    monkeypatch.setattr(busca, "PAUSA", 0.3)
    nome = ingestao.ingerir(vetores, emb)["colecao"]
    assert buscador.buscar("dor no peito") and buscador.estado() == "up"
    vetores.apagar(nome)
    assert buscador.buscar("dor no peito") == [] and buscador.estado() == "down"
    ingestao.ingerir(vetores, emb)  # mesma versao, outro id interno
    time.sleep(0.4)
    assert buscador.buscar("dor no peito") and buscador.estado() == "up"


# --- Na API
def test_triagem_cita_fontes_e_segue_sem_a_base(cliente, parte, vetores, emb, monkeypatch):
    ingestao.ingerir(vetores, emb)
    b = busca.Buscador(emb=emb)
    monkeypatch.setattr(main, "buscador", b)
    monkeypatch.setattr(main, "triador", Triador(b))
    monkeypatch.setattr(busca, "PAUSA", 0)
    c = cliente
    def pedir():
        r = c.post("/api/v1/triagens", headers=INTERNO | {"X-Saga-Id": str(uuid.uuid4())}, json={"pacienteId": str(uuid.uuid4()), "sintomas": "dor no peito desde ontem"})
        assert r.status_code == 201
        return r.json()
    t = pedir()
    assert t["classificacao"] == "LARANJA" and t["origem"] == "REGRAS"
    assert any(f["documento"].endswith("vol. II") and f["pagina"] for f in t["fontes"])
    assert c.get(f"/api/v1/triagens/{t['id']}", headers=INTERNO).json()["fontes"] == t["fontes"]
    assert c.get(f"/api/v1/triagens/{t['id']}/orientacoes", headers=INTERNO).json()["fontes"] == t["fontes"]
    assert c.get("/ready").json()["base"] == "up"

    for n in vetores.nomes():
        vetores.apagar(n)
    t = pedir()
    assert t["classificacao"] == "LARANJA" and t["fontes"] == []
    r = c.get("/ready")
    assert r.status_code == 200 and r.json()["base"] == "down"  # a base nao derruba o servico
