"""Cria o modelo a partir do ambiente. Sem chave, devolve None e a Triagem trabalha por regras.

Provedores: DeepSeek (padrao quando ha DEEPSEEK_API_KEY) e Gemini. LLM_PROVEDOR escolhe um deles explicitamente.
Os dois entram na mesma chain: saida estruturada, tool e protecao sao iguais; muda so o cliente.
"""

import os

from .protecao import TENTATIVA_S

PADRAO = {"deepseek": "deepseek-flash", "gemini": "gemini-3.5-flash-lite"}
SERVIDOR = {"deepseek": "https://api.deepseek.com", "gemini": "https://generativelanguage.googleapis.com"}
CHAVE = {"deepseek": "DEEPSEEK_API_KEY", "gemini": "GEMINI_API_KEY"}


def provedor(env=os.environ) -> str | None:
    escolhido = (env.get("LLM_PROVEDOR") or "").strip().lower()
    if escolhido in CHAVE:
        return escolhido if env.get(CHAVE[escolhido]) else None
    return next((p for p in ("deepseek", "gemini") if env.get(CHAVE[p])), None)


def nome(modelo) -> str:
    return getattr(modelo, "model_name", None) or modelo.model


def de(modelo) -> str:
    return "deepseek" if type(modelo).__name__ == "ChatDeepSeek" else "gemini"


def sufixo(env=os.environ) -> str:
    """Arquivos das medidas: os do Gemini ficam com o nome original; os de outro provedor levam o nome dele."""
    p = provedor(env)
    return "" if p in (None, "gemini") else "-" + p


def criar(env=os.environ, prazo: float | None = None):
    """prazo: tempo de cada chamada; o padrao e o da producao (a avaliacao usa um prazo folgado)."""
    p = provedor(env)
    if p is None:
        return None
    modelo = env.get("LLM_MODELO") or PADRAO[p]
    return (_deepseek if p == "deepseek" else _gemini)(env, modelo, env[CHAVE[p]], prazo or TENTATIVA_S)


def _deepseek(env, modelo, chave, prazo):
    from langchain_openai import ChatOpenAI

    class ChatDeepSeek(ChatOpenAI):
        """A API do DeepSeek segue a da OpenAI. Saida estruturada por chamada de funcao, que ele aceita sem raciocinio."""

        def with_structured_output(self, schema=None, *, method="function_calling", **kwargs):
            return super().with_structured_output(schema, method=method, **kwargs)

    return ChatDeepSeek(
        model=modelo, api_key=chave, base_url=env.get("LLM_URL") or SERVIDOR["deepseek"],
        max_tokens=1024, temperature=0,
        # Sem raciocinio: medido com as 24 perguntas de avaliacao, foi o mais rapido (p50 1,4 s) e acertou mais.
        extra_body={"thinking": {"type": "disabled"}},
        timeout=prazo,
        max_retries=0,  # as novas tentativas sao as nossas, na Protecao
    )


def _gemini(env, modelo, chave, prazo):
    from langchain_google_genai import ChatGoogleGenerativeAI, HarmBlockThreshold, HarmCategory

    # Relatos de violencia e risco de suicidio sao parte da triagem: o filtro do provedor nao pode recusa-los.
    livre = {c: HarmBlockThreshold.BLOCK_NONE for c in (
        HarmCategory.HARM_CATEGORY_HARASSMENT, HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT)}
    return ChatGoogleGenerativeAI(
        model=modelo, google_api_key=chave, base_url=env.get("LLM_URL") or None,
        max_output_tokens=1024, safety_settings=livre,
        timeout=prazo,
        max_retries=1,  # so uma tentativa: o padrao do SDK sao 6, por dentro das nossas
        # O SDK manda o timeout tambem como prazo do servidor; 3,5 s seria curto demais para ele.
        additional_headers={"X-Server-Timeout": "10"},
    )
