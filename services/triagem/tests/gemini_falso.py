"""Servidor que fala a API do Gemini (generateContent), para testar o cliente real sem chave e provocar falhas.

Nao e um modelo: devolve respostas fixas. Uso avulso, pelo scripts/verificar_llm.sh: python gemini_falso.py 9000
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
                    codigo, saida = falso.tratar(corpo)
                except Exception as e:  # noqa: BLE001
                    codigo, saida = 500, {"error": {"code": 500, "message": repr(e), "status": "INTERNAL"}}
                self.responder(codigo, saida)

        self.srv = ThreadingHTTPServer((endereco, porta), H)
        self.srv.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def modo(self, modo="ok", codigo=503, atraso=0.0, resposta=None, vezes=None, argumentos=None, escolha=None):
        self.m, self.codigo, self.atraso, self.resposta, self.vezes, self.argumentos, self.escolha = modo, codigo, atraso, resposta or {}, vezes, argumentos, escolha

    def tratar(self, corpo):
        m = self.m
        if self.vezes is not None:  # falha so nas primeiras n chamadas
            self.vezes -= 1
            if self.vezes < 0:
                m = "ok"
        if m == "mudo":
            time.sleep(30)
        if m != "ok" or self.vezes is None:
            time.sleep(self.atraso)
        if m == "erro":
            return self.codigo, {"error": {"code": self.codigo, "message": "falha provocada", "status": "UNAVAILABLE"}}
        if m == "invalido":
            return 200, self.texto("isto nao e json")
        partes = [p for c in corpo["contents"] for p in c["parts"]]
        if corpo.get("tools") and m == "ok":
            pedido = " ".join(p.get("text", "") for p in partes)
            args = self.argumentos or {"especialidade": re.search(r"Especialidade: ([^.]+)\.", pedido)[1], "prazo_horas": int(re.search(r"Prazo máximo: (\d+)", pedido)[1])}
            return 200, self.candidato([{"functionCall": {"name": "consultar_horarios", "args": args}, "thoughtSignature": "YXNzaW5hdHVyYQ=="}])
        if "slotIds" in json.dumps(corpo.get("generationConfig", {})):
            resposta = next(p["functionResponse"]["response"] for p in partes if "functionResponse" in p)
            ids = re.findall(r'slotId\W+([0-9a-f-]{36})', json.dumps(resposta))
            return 200, self.texto(json.dumps(self.escolha or {"slotIds": ids[:2], "orientacao": "Chegue com antecedência."}))
        return 200, self.texto(json.dumps({"classificacao": "VERDE", "especialidade": "Clínica Geral", "justificativa": "Queixa sem sinal de alerta no protocolo.",
                                           "trechos": [1], "confianca": 0.9} | self.resposta))

    def texto(self, t):
        return self.candidato([{"text": t}])

    @staticmethod
    def candidato(partes):
        return {"candidates": [{"content": {"role": "model", "parts": partes}, "finishReason": "STOP", "index": 0}],
                "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 50, "totalTokenCount": 1050}}


if __name__ == "__main__":
    GeminiFalso(int(sys.argv[1]), "0.0.0.0")
    threading.Event().wait()
