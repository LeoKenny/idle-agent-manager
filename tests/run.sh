#!/bin/sh
# Runs the Python tests, then `herdr-app check` on the mod when Herdr is installed.
set -e
cd "$(dirname "$0")/.."
python3 -m unittest discover -s tests -v
if command -v herdr-app >/dev/null 2>&1; then
  herdr-app check mods/idle-agent-manager 2>&1 | grep -E "^check (passed|failed)"
else
  echo "herdr-app not found: skipped the mod check"
fi
