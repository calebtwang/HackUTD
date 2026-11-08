#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runtime_dir=${SPACETIME_ROOT:-"$project_dir/.local/spacetime"}
if [ -x "$runtime_dir/spacetime" ]; then
  printf '%s\n' 'SpacetimeDB is already installed at the selected location.'
  exit 0
fi
mkdir -p "$project_dir/.local"
installer="$project_dir/.local/spacetime-install.sh"
curl -fsSL https://install.spacetimedb.com -o "$installer"
sh "$installer" --root-dir "$runtime_dir" -y
