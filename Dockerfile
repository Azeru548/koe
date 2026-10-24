FROM node:20-slim

# Python + edge-tts (Microsoft neural voices, free, no API key).
# Piper (offline engine) is installed best-effort and is optional.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages edge-tts

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

COPY server.js guard.js stats.js stats.html index.html mcp.html voices.js audio.js hosted-mcp.js mcp-sample-*.mp3 ./
COPY assets ./assets

ENV NODE_ENV=production
ENV TTS_BACKEND=native

EXPOSE 3000

CMD ["node", "server.js"]
