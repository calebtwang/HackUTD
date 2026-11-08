#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
usage() {
  printf '%s\n' \
    'Usage: scripts/start-demo.sh [--check | --install | --help]' \
    '  no option   Start the local dashboard and webhook receiver.' \
    '  --check     Check Node, dependencies, and installed Chromium.' \
    '  --install   Install locked dependencies and Chromium, then check.' \
    'Set DEMO_NODE to a Node executable if it is not on PATH.' \
    'Configure SpacetimeDB separately; see docs/SETUP.md.'
}
action=${1:-start}
if [ "$#" -gt 1 ]; then usage >&2; exit 2; fi
case "$action" in
  --help|-h) usage; exit 0 ;;
  start|--check|--install) ;;
  *) usage >&2; exit 2 ;;
esac
supported_node() {
  [ -x "$1" ] && "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 26 || (major === 26 && minor >= 12) ? 0 : 1)' >/dev/null 2>&1
}
node_bin=''
runtime_override=${DEMO_NODE:-${HONEYLINE_NODE:-}}
if [ -n "$runtime_override" ]; then
  if ! supported_node "$runtime_override"; then
    printf '%s\n' 'DEMO_NODE must point to an executable Node 26.12 or later.' >&2
    exit 1
  fi
  node_bin=$runtime_override
elif candidate=$(command -v node 2>/dev/null) && supported_node "$candidate"; then
  node_bin=$candidate
elif supported_node "$project_dir/../../work/node-runtime/bin/node"; then
  node_bin="$project_dir/../../work/node-runtime/bin/node"
else
  printf '%s\n' 'Install Node 26.12 or later, or set DEMO_NODE to its executable.' >&2
  exit 1
fi
PATH="$(dirname -- "$node_bin"):$PATH"
export PATH
if [ "$action" = '--install' ]; then
  if ! command -v npm >/dev/null 2>&1; then
    printf '%s\n' 'npm is missing. Install a Node distribution that includes npm.' >&2
    exit 1
  fi
  npm ci
  "$node_bin" node_modules/playwright/cli.js install chromium
fi
if [ ! -f node_modules/tsx/package.json ] || [ ! -f node_modules/playwright/package.json ]; then
  printf '%s\n' 'Dependencies are missing. Run scripts/start-demo.sh --install first.' >&2
  exit 1
fi
"$node_bin" --input-type=module <<'NODE'
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
if (!existsSync(chromium.executablePath())) {
  console.error('Chromium is missing. Run scripts/start-demo.sh --install first.');
  process.exit(1);
}
console.log(`Node ${process.versions.node}, project dependencies, and Chromium are available.`);
NODE
if [ "$action" != 'start' ]; then
  printf '%s\n' 'Runtime check passed. Database credentials and phone service are separate checks.'
  exit 0
fi
printf '%s\n' 'Starting the demo. Keep this terminal open; press Control-C to stop.'
exec "$node_bin" --import tsx server/index.ts
