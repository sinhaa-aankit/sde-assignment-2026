#!/usr/bin/env bash
# Starts the controller against a running simulator and runs until the scenario finishes.
#   ./run.sh http://127.0.0.1:8700
# Needs Node.js >= 24 (built-in SQLite + TypeScript). No npm install needed: the controller has zero runtime dependencies.
# If Node 24 isn't installed, it runs the same code in the official node:24 Docker image instead.
# State goes to state/<scenario>.db (override with CONTROLLER_DB). Kill it any time; run it again and it resumes.
set -euo pipefail
SIM_URL="${1:?usage: ./run.sh <SIM_URL>}"
cd "$(dirname "$0")"
mkdir -p state

if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  exec node --disable-warning=ExperimentalWarning controller/main.ts "$SIM_URL"
else
  echo "Node >= 24 not found — running the controller in docker (node:24-slim)" >&2
  exec docker run --rm --network host -v "$PWD":/app -w /app ${CONTROLLER_DB:+-e CONTROLLER_DB="$CONTROLLER_DB"} \
    node:24-slim node --disable-warning=ExperimentalWarning controller/main.ts "$SIM_URL"
fi
