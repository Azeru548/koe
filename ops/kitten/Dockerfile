# Koe — Kitten TTS sidecar.
#
# Deliberately a plain Python image: the model is 25 MB (int8 nano) and the
# wrapper is stdlib-only, so there is no server framework to install or patch.
# Built by `docker compose up -d --build kitten` from docker-compose.yml.

FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    KITTEN_PORT=8881

WORKDIR /app

# PINNED on purpose: the dependency list below is hand-picked against this
# exact version. A bump must be followed by `python smoke.py` (CI runs it), or a
# new required module will only surface as a 500 on a live request.
#
# `pip install kittenml` on its own drags in torch, torchaudio, diffusers,
# transformers, spacy and 24 NVIDIA CUDA wheels — 6.5 GB installed, for a
# dependency the int8 ONNX path never imports (verified: `torch` is absent from
# sys.modules after a full generate()). Installing the package --no-deps plus
# the modules the ONNX path does use gives a ~300 MB environment that
# synthesises correctly, which is what makes this sidecar viable on a small box.
RUN pip install --no-cache-dir --no-deps "kittenml==0.9.8" \
 && pip install --no-cache-dir \
      onnxruntime numpy huggingface_hub safetensors \
      phonemizer espeakng_loader kitten-text-processing num2words \
      scipy soundfile misaki pyloudnorm einops omegaconf hydra-core brotli

COPY server.py /app/server.py
COPY smoke.py /app/smoke.py

EXPOSE 8881

CMD ["python", "/app/server.py"]
