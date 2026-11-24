"""Cliente do ChromaDB pela API REST v2. O cliente oficial nao tem timeout (timeout=None) e travaria a SAGA."""

import os

import httpx

CAMINHO = "/api/v2/tenants/default_tenant/databases/default_database/collections"


class Vetores:
    def __init__(self, env=os.environ, leitura: float = 1.0):
        self.http = httpx.Client(base_url=f"http://{env['CHROMA_HOST']}:{env.get('CHROMA_PORT', '8000')}",
                                 timeout=httpx.Timeout(leitura, connect=0.5), trust_env=False)

    def _pedir(self, metodo, caminho="", **kw):
        r = self.http.request(metodo, CAMINHO + caminho, **kw)
        r.raise_for_status()
        return r.json() if r.content else None

    def colecao(self, nome: str) -> dict | None:
        r = self.http.get(f"{CAMINHO}/{nome}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    def criar(self, nome: str) -> dict:
        return self._pedir("POST", json={"name": nome, "get_or_create": True, "configuration": {"hnsw": {"space": "cosine"}}})

    def gravar(self, id_: str, trechos: list[dict], vetores: list[list[float]]):
        self._pedir("POST", f"/{id_}/upsert", json={
            "ids": [t["id"] for t in trechos], "embeddings": vetores, "documents": [t["texto"] for t in trechos],
            "metadatas": [{"documento": t["documento"], "secao": t["secao"], "pagina": t["pagina"] or 0} for t in trechos]})

    def contar(self, id_: str) -> int:
        return self._pedir("GET", f"/{id_}/count")

    def marcar(self, id_: str, dados: dict):
        self._pedir("PUT", f"/{id_}", json={"new_metadata": dados})

    def nomes(self) -> list[str]:
        return [c["name"] for c in self._pedir("GET", params={"limit": 100})]

    def apagar(self, nome: str):
        r = self.http.delete(f"{CAMINHO}/{nome}")
        if r.status_code != 404:
            r.raise_for_status()

    def buscar(self, id_: str, vetor: list[float], k: int) -> list[dict]:
        r = self._pedir("POST", f"/{id_}/query", json={
            "query_embeddings": [vetor], "n_results": k, "include": ["documents", "metadatas", "distances"]})
        return [{"texto": t, "documento": m["documento"], "secao": m["secao"], "pagina": int(m["pagina"]) or None,
                 "similaridade": round(1 - d, 4)}
                for t, m, d in zip(r["documents"][0], r["metadatas"][0], r["distances"][0])]
