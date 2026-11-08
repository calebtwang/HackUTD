#!/usr/bin/env bash
# Run only on the selected Ubuntu VM. No remote installer script is executed.
set -euo pipefail
[[ "$(id -u)" == 0 ]] || { echo 'Run this installer with sudo on the Ubuntu VM.' >&2; exit 1; }
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || { echo 'This installer supports Ubuntu only.' >&2; exit 1; }
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  echo 'Docker Engine and Compose are already installed.'
  exit 0
fi
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker compose version
