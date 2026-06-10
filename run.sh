#!/usr/bin/env bash
# Launch the cooking app on http://localhost:36637.
# Requires only python3 (stdlib). No pip, no node, no npm.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 server.py "$@"
