# Koe — Kitten TTS sidecar.
#
# Deliberately a plain Python image: the model is 25 MB (int8 nano) and the
# wrapper is stdlib-only, so there is no server framework to install or patch.
# Built by `docker compose up -d --build` from docker-compose.yml.

FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    KITTEN_PORT=8881

WORKDIR /app

# numpy arrives with the package; `kittenml` pulls the small onnxruntime build.
RUN pip install --no-cache-dir kittenml

COPY server.py /app/server.py

EXPOSE 8881

CMD ["python", "/app/server.py"]
