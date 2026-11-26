"""Servidor que fala a API do Gemini (generateContent) e a do DeepSeek (chat/completions, formato da OpenAI),
para testar os clientes reais sem chave e provocar falhas.

Nao e um modelo: devolve respostas fixas, as mesmas nos dois formatos. Uso avulso, pelo scripts/verificar_llm.sh: python gemini_falso.py 9000
POST /_modo {"modo": "ok|mudo|erro|invalido|sem_tool", "codigo": 503, "atraso": 0, "resposta": {...}, "vezes": n}
GET  /_pedidos -> corpos recebidos
"""

import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class GeminiFalso:
    def __init__(self, porta=0, endereco="127.0.0.1"):
        self.pedidos, self.cabecalhos = [], []
        self.modo()
        falso = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def responder(self, codigo, corpo):
                dados = json.dumps(corpo).encode()
                self.send_response(codigo)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(dados)))
                self.end_headers()
                try:
                    self.wfile.write(dados)
                except OSError:
                    pass  # o cliente desistiu

            def do_GET(self):
                self.responder(200, falso.pedidos)

            def do_POST(self):
                corpo = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
                if self.path == "/_modo":
                    falso.modo(**corpo)
                    return self.responder(200, {})
                falso.pedidos.append(corpo)
                falso.cabecalhos.append(dict(self.headers))
                try:
                    codigo, saida = (falso.tratar_openai if self.path.endswith("/chat/completions") else falso.tratar)(corpo)
                except Exception as e:  # noqa: BLE001
                    codigo, saida = 500, {"error": {"code": 500, "message": repr(e), "status": "INTERNAL"}}
                self.responder(codigo, saida)

        self.srv = ThreadingHTTPServer((endereco, porta), H)
        self.srv.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def _modo_da_vez(self):
        m = self.m
        if self.vezes is not None:  # falha so nas primeiras n chamadas
            self.vezes -= 1
            if self.vezes < 0:
                m = "ok"
        if m == "mudo":
            time.sleep(30)
        if m != "ok" or self.vezes is None:
            time.sleep(self.atraso)
        return m

    def classificacao(self):
        return {"classificacao": "VERDE", "especialidade": "Clínica Geral", "justificativa": "Queixa sem sinal de alerta no protocolo.",
                "trechos": [1], "confianca": 0.9} | self.resposta

    def argumentos_da_tool(self, pedido):
        return self.argumentos or {"especialidade": re.search(r"Especialidade: ([^.]+)\.", pedido)[1], "prazo_horas": int(re.search(r"Prazo máximo: (\d+)", pedido)[1])}

    def escolher(self, resultado_da_tool):
        ids = re.findall(r'slotId\W+([0-9a-f-]{36})', resultado_da_tool)
        return self.escolha or {"slotIds": ids[:2], "orientacao": "Chegue com antecedência."}

    def tratar_openai(self, corpo):
        """DeepSeek: saida estruturada e tool chegam como chamada de funcao; a resposta volta em tool_calls."""
        m = self._modo_da_vez()
        if m == "erro":
            return self.codigo, {"error": {"message": "falha provocada", "type": "server_error", "code": None}}
        nome = (corpo.get("tool_choice") or {}).get("function", {}).get("name") if isinstance(corpo.get("tool_choice"), dict) else None
        if m in ("invalido", "sem_tool") or not nome:
            return 200, self.mensagem({"role": "assistant", "content": "isto nao e json"})
        if nome == "consultar_horarios":
            pedido = " ".join(str(x.get("content", "")) for x in corpo["messages"])
            args = self.argumentos_da_tool(pedido)
        elif nome == "Escolha":
            args = self.escolher(" ".join(str(x.get("content", "")) for x in corpo["messages"] if x["role"] == "tool"))
        else:
            args = self.classificacao()
        chamada = {"id": "chamada-1", "type": "function", "function": {"name": nome, "arguments": json.dumps(args, ensure_ascii=False)}}
        return 200, self.mensagem({"role": "assistant", "content": None, "tool_calls": [chamada]})

    @staticmethod
    def mensagem(m):
        return {"id": "falso", "object": "chat.completion", "created": 0, "model": "deepseek-flash",
                "choices": [{"index": 0, "message": m, "finish_reason": "tool_calls" if m.get("tool_calls") else "stop"}],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 50, "total_tokens": 1050}}

    # --- Para os testes lerem o pedido sem depender do formato
    def texto_do_usuario(self, i):
        p = self.pedidos[i]
        if "messages" in p:
            return next(x["content"] for x in p["messages"] if x["role"] == "user")
        return p["contents"][0]["parts"][0]["text"]

    def pediu_saida_estruturada(self, i):
        p = self.pedidos[i]
        if "messages" in p:
            return p["tool_choice"]["function"]["name"] == "Classificacao"
        return p["generationConfig"]["responseMimeType"] == "application/json"

    def tool_devolvida(self, i):
        """(nome da tool que o modelo pediu, resultado que voltou para ele) no pedido i."""
        p = self.pedidos[i]
        if "messages" in p:
            pedida = next(x for x in p["messages"] if x.get("tool_calls"))["tool_calls"][0]["function"]["name"]
            return pedida, next(x["content"] for x in p["messages"] if x["role"] == "tool")
        c = p["contents"]
        assert c[1]["parts"][0]["thoughtSignature"]
        return c[1]["parts"][0]["functionCall"]["name"], json.dumps(c[2])

    def modo(self, modo="ok", codigo=503, atraso=0.0, resposta=None, vezes=None, argumentos=None, escolha=None):
        self.m, self.codigo, self.atraso, self.resposta, self.vezes, self.argumentos, self.escolha = modo, codigo, atraso, resposta or {}, vezes, argumentos, escolha

    def tratar(self, corpo):
        m = self._modo_da_vez()
        if m == "erro":
            return self.codigo, {"error": {"code": self.codigo, "message": "falha provocada", "status": "UNAVAILABLE"}}
        if m == "invalido":
            return 200, self.texto("isto nao e json")
        partes = [p for c in corpo["contents"] for p in c["parts"]]
        if corpo.get("tools") and m == "ok":
            pedido = " ".join(p.get("text", "") for p in partes)
            args = self.argumentos_da_tool(pedido)
            return 200, self.candidato([{"functionCall": {"name": "consultar_horarios", "args": args}, "thoughtSignature": "YXNzaW5hdHVyYQ=="}])
        if "slotIds" in json.dumps(corpo.get("generationConfig", {})):
            resposta = next(p["functionResponse"]["response"] for p in partes if "functionResponse" in p)
            return 200, self.texto(json.dumps(self.escolher(json.dumps(resposta))))
        return 200, self.texto(json.dumps(self.classificacao()))

    def texto(self, t):
        return self.candidato([{"text": t}])

    @staticmethod
    def candidato(partes):
        return {"candidates": [{"content": {"role": "model", "parts": partes}, "finishReason": "STOP", "index": 0}],
                "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 50, "totalTokenCount": 1050}}


if __name__ == "__main__":
    GeminiFalso(int(sys.argv[1]), "0.0.0.0")
    threading.Event().wait()
