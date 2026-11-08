#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
workspace_runtime="$project_dir/../../work/spacetime/runtime"
if [ -n "${SPACETIME_ROOT:-}" ]; then
  runtime_dir=$SPACETIME_ROOT
elif [ -x "$workspace_runtime/spacetime" ]; then
  runtime_dir=$workspace_runtime
else
  runtime_dir="$project_dir/.local/spacetime"
fi
if [ ! -x "$runtime_dir/spacetime" ]; then
  printf '%s\n' 'SpacetimeDB CLI is missing. Run scripts/spacetime-setup.sh first.' >&2
  exit 1
fi
exec "$runtime_dir/spacetime" "--root-dir=$runtime_dir" "$@"
