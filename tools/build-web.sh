#!/bin/bash
# Build the standalone web version into docs/ for GitHub Pages.
# docs/web/app/ sits two levels under the site root so the renderer's
# relative asset URLs ('../../assets/...', '../../node_modules/...') resolve to docs/.
set -e
cd "$(dirname "$0")/.."

mkdir -p docs/web/app docs/assets/fonts docs/assets/mediapipe docs/assets/models docs/assets/motions
mkdir -p "docs/node_modules/@mediapipe/tasks-vision"

npx esbuild src/web/entry.js --bundle --format=esm --target=es2022 \
  --outfile=docs/web/app/bundle.js --log-level=warning

cp src/web/index.html docs/web/app/index.html
cp assets/fonts/Yomogi-Regular.ttf docs/assets/fonts/
cp assets/mediapipe/face_landmarker.task docs/assets/mediapipe/
cp assets/models/default.vrm docs/assets/models/
cp assets/motions/*.vrma docs/assets/motions/
cp -R node_modules/@mediapipe/tasks-vision/wasm "docs/node_modules/@mediapipe/tasks-vision/"

echo "done. preview: python3 -m http.server -d docs 8080 -> http://localhost:8080/web/app/"
