#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/daemon"
if [[ ! -f config.json ]]; then cp config.example.json config.json; fi
exec go run .
