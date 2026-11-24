"""Cria o modelo a partir do ambiente. Sem chave, devolve None e a Triagem trabalha por regras."""

import os

from .protecao import TENTATIVA_S

MODELO_PADRAO = "gemini-3.5-flash-lite"


def criar(env=os.environ):
    chave = env.get("GEMINI_API_KEY")
    if not chave:
        return None
    from langchain_google_genai import ChatGoogleGenerativeAI, HarmBlockThreshold, HarmCategory

    # Relatos de violencia e risco de suicidio sao parte da triagem: o filtro do provedor nao pode recusa-los.
    livre = {c: HarmBlockThreshold.BLOCK_NONE for c in (
        HarmCategory.HARM_CATEGORY_HARASSMENT, HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT)}
    return ChatGoogleGenerativeAI(
        model=env.get("LLM_MODELO") or MODELO_PADRAO, google_api_key=chave, base_url=env.get("LLM_URL") or None,
        max_output_tokens=1024, safety_settings=livre,
        timeout=TENTATIVA_S,
        max_retries=1,  # so uma tentativa: o padrao do SDK sao 6, por dentro das nossas
        # O SDK manda o timeout tambem como prazo do servidor; 3,5 s seria curto demais para ele.
        additional_headers={"X-Server-Timeout": "10"},
    )
