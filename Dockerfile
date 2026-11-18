# Pinned by minor version: a floating tag means an unrelated upstream release
# can change the runtime under a rebuild that was supposed to change nothing.
FROM node:20.19.6-slim

# Python + edge-tts (Microsoft neural voices, free, no API key).
# edge-tts is pinned: it is the primary engine, it speaks a CLI this server
# parses, and an unpinned upgrade has silently broken that contract before.
# Piper (offline engine) is installed best-effort and is optional.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages edge-tts==7.3.1

# Optional: Piper offline engine + its voice model (~64 MB).
# Non-fatal: the studio still works with edge voices if this fails.
ENV PIPER_ROOT=/piper
RUN mkdir -p /piper/models \
 && (pip3 install --no-cache-dir --break-system-packages piper-tts \
     || echo "WARN: piper-tts package unavailable — offline engine disabled") \
 && (curl -fsSL -o /piper/models/en_US-lessac-medium.onnx \
       https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx \
     && curl -fsSL -o /piper/models/en_US-lessac-medium.onnx.json \
       https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json \
     || echo "WARN: piper model download failed — offline engine disabled")

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the whole build context: a hand-maintained file list silently dropped
# db.js from the image once already. `.dockerignore` keeps node_modules, output,
# tests, ops and local secrets out of the build context.
COPY . .

# Run as the unprivileged `node` user (uid 1000) that the base image ships.
# `output/` is where jobs, audio and the synthesis cache are written, and the
# default KOE_DB_PATH (./koe.db) lands in /app too, so both must be writable.
# A bind-mounted data directory must be writable by uid 1000 as well.
RUN mkdir -p /app/output && chown -R node:node /app

ENV NODE_ENV=production
ENV TTS_BACKEND=native

USER node

EXPOSE 3000

# Docker itself should be able to tell a wedged server from a working one, not
# only Caddy from outside. Starts slowly (sidecar probes, DB open) — hence the
# generous start period.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health >/dev/null || exit 1

CMD ["node", "server.js"]
