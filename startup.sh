#!/bin/sh
set -eu
# Prefer $PWD when it looks like the app root; otherwise use the script directory.
ROOT="${PWD}"
if [ ! -f "$ROOT/package.json" ]; then
  ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
fi
cd "$ROOT"
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi
npm run dev >>/tmp/app-startup.log 2>&1 &
