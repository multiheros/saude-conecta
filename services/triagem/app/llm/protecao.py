"""O LLM como dependencia remota falivel: prazo, nova tentativa com espera, circuit breaker e indicadores."""

import json
import logging
import random
import threading
import time
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as Estourou

log = logging.getLogger("triagem.llm")
TENTATIVA_S = 3.5  # prazo de cada tentativa
TENTATIVAS = 2
ESPERA_S = 0.2  # antes da segunda, com variacao aleatoria para as replicas nao repetirem juntas
MINIMO_S = 0.5  # com menos que isso de prazo total, nem tenta


class LLMIndisponivel(Exception):
    """Sem resposta util do modelo; quem chama usa o fallback."""


class RespostaInvalida(Exception):
    """O modelo respondeu, mas fora do formato pedido."""


class Circuito:
    """Abre com 3 falhas seguidas; depois de 30 s deixa passar uma chamada de teste. Vale por processo."""

    def __init__(self, limite=3, aberto_s=30.0, relogio=time.monotonic):
        self.limite, self.aberto_s, self.relogio = limite, aberto_s, relogio
        self.falhas, self.aberto_ate, self.teste = 0, None, False
        self._trava = threading.Lock()

    @property
    def estado(self) -> str:
        if self.aberto_ate is None:
            return "FECHADO"
        return "MEIO_ABERTO" if self.teste or self.relogio() >= self.aberto_ate else "ABERTO"

    def permitir(self):
        """Levanta LLMIndisponivel se aberto; passado o prazo, so a primeira chamada passa, como teste."""
        with self._trava:
            if self.aberto_ate is None:
                return
            if self.teste or self.relogio() < self.aberto_ate:
                raise LLMIndisponivel("circuito aberto")
            self.teste = True

    def sucesso(self):
        with self._trava:
            self.falhas, self.aberto_ate, self.teste = 0, None, False

    def falha(self):
        with self._trava:
            self.falhas += 1
            if self.teste or self.falhas >= self.limite:
                if self.aberto_ate is None:
                    log.warning(json.dumps({"nivel": "aviso", "msg": "circuito do LLM aberto", "falhas": self.falhas}))
                self.aberto_ate, self.teste = self.relogio() + self.aberto_s, False


def motivo_da_falha(e: BaseException) -> tuple[str, bool]:
    """(motivo, vale repetir). Percorre as causas porque o LangChain embrulha o erro do SDK."""
    visto = e
    while visto is not None:
        if isinstance(visto, RespostaInvalida):
            return "resposta invalida", True
        # Pelo nome: o SDK pode usar httpx ou httpx2, com classes distintas e nomes iguais.
        nomes = {c.__name__ for c in type(visto).__mro__}
        if isinstance(visto, (Estourou, TimeoutError)) or "TimeoutException" in nomes:
            return "tempo esgotado", True
        if isinstance(visto, ConnectionError) or "TransportError" in nomes:
            return "conexao", True
        codigo = getattr(visto, "code", None)
        if isinstance(codigo, int):
            # 429 e cota: repetir em 0,2 s so gasta mais cota. 4xx e erro nosso ou da chave.
            return f"http {codigo}", codigo >= 500
        visto = visto.__cause__ or visto.__context__
    return type(e).__name__, False


class Protecao:
    def __init__(self, circuito: Circuito | None = None):
        self.circuito = circuito or Circuito()
        self._pool = ThreadPoolExecutor(8, thread_name_prefix="llm")
        self._trava = threading.Lock()
        self.contagem = Counter()
        self.falhas_por_motivo = Counter()
        self.latencias = deque(maxlen=500)

    def contar(self, nome: str, n: int = 1):
        with self._trava:
            self.contagem[nome] += n

    def executar(self, chamar, prazo: float):
        """Executa chamar() ate o instante `prazo` (time.monotonic), ou levanta LLMIndisponivel."""
        for tentativa in range(1, TENTATIVAS + 1):
            resta = prazo - time.monotonic()
            if resta < MINIMO_S:
                raise LLMIndisponivel("prazo total esgotado")
            try:
                self.circuito.permitir()
            except LLMIndisponivel:
                self.contar("recusadasPeloCircuito")
                raise
            self.contar("chamadas")
            if tentativa > 1:
                self.contar("repeticoes")
            t0 = time.monotonic()
            # O limite aqui cobre tambem o que o timeout do cliente HTTP nao cobre, como a resolucao de nome.
            futuro = self._pool.submit(chamar)
            try:
                saida = futuro.result(timeout=min(TENTATIVA_S, resta))
            except Exception as e:  # noqa: BLE001 - toda falha do modelo leva ao fallback
                futuro.cancel()
                motivo, repetir = motivo_da_falha(e)
                self.circuito.falha()
                with self._trava:
                    self.falhas_por_motivo[motivo] += 1
                log.warning(json.dumps({"nivel": "aviso", "msg": "LLM falhou", "motivo": motivo, "tentativa": tentativa,
                                        "ms": int((time.monotonic() - t0) * 1000), "circuito": self.circuito.estado}))
                if not repetir or tentativa == TENTATIVAS:
                    raise LLMIndisponivel(motivo) from e
                time.sleep(min(ESPERA_S * random.uniform(0.5, 1.5), max(0.0, prazo - time.monotonic())))
            else:
                self.circuito.sucesso()
                with self._trava:
                    self.latencias.append((time.monotonic() - t0) * 1000)
                return saida

    def indicadores(self) -> dict:
        with self._trava:
            l, c = sorted(self.latencias), dict(self.contagem)
            motivos = dict(self.falhas_por_motivo)
        return {"circuito": self.circuito.estado, "falhasPorMotivo": motivos,
                "latenciaMs": {"p50": round(l[len(l) // 2]), "p95": round(l[min(len(l) - 1, int(len(l) * 0.95))])} if l else None,
                **{k: c.get(k, 0) for k in ("chamadas", "repeticoes", "recusadasPeloCircuito", "acertosCache", "fallbacks", "tokensEntrada", "tokensSaida")}}
