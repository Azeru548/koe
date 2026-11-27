#!/usr/bin/env bash
# Netlify build: the public site is static now. The studio, the key issuer and
# the MCP endpoint need Node, ffmpeg and edge-tts, so they are not deployed —
# only the landing page, the docs and the assets they reference.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf site
mkdir -p site

cp index.html site/index.html
cp docs.html site/docs.html
cp robots.txt sitemap.xml site/

cp assets/favicon-32.png assets/apple-touch-icon.png assets/logo-mark.png \
   assets/oiran.png assets/og-cover.jpg assets/og-docs.jpg site/

cp mcp-sample-andrew.mp3 site/

echo "built site/: $(ls site | tr '\n' ' ')"
