# Estagio 1: compila/instala dependencias Python em um prefixo isolado
FROM python:3.12-slim AS builder
WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Estagio 2: imagem final so com o necessario para executar, usuario nao-root
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=builder /install /usr/local
COPY main.py .
RUN useradd -r -u 10001 app
USER app
EXPOSE 8003
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8003/ready')" || exit 1
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8003"]
