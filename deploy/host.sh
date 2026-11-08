#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
private_dir="${DEMO_PRIVATE_DIR:-/opt/hackutd-private}"
command -v docker >/dev/null || { echo 'Install Docker Engine and the Compose plugin first.' >&2; exit 1; }
docker compose version >/dev/null
compose=(docker compose --env-file /dev/null --project-directory "$project_dir/deploy" -f "$project_dir/deploy/compose.yaml")
case "${1:-status}" in
  check) "${compose[@]}" config --quiet ;;
  build) "${compose[@]}" build app ;;
  smoke)
    docker run --rm --init --network none --read-only --cap-drop=ALL --security-opt=no-new-privileges:true --shm-size=512m --tmpfs /tmp:size=268435456,mode=1777 --entrypoint node hackutd-app:local --input-type=module -e 'import {chromium} from "playwright"; const browser=await chromium.launch({headless:true}); try {const page=await browser.newPage(); await page.setContent("<p>Browser ready</p>"); if(await page.locator("p").innerText()!=="Browser ready") throw new Error("Browser check failed"); console.log("Chromium launched and parsed an offline page.");} finally {await browser.close();}'
    docker run --rm --entrypoint caddy -v "$project_dir/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.11.9-alpine validate --config /etc/caddy/Caddyfile --adapter caddyfile
    ;;
  start)
    [[ -f "$private_dir/demo.env" && -f "$private_dir/.local/personas.json" ]] || { echo 'Copy the private env, current worker identities, and personas.json before starting.' >&2; exit 1; }
    "${compose[@]}" up -d --wait --wait-timeout 180
    ;;
  stop) "${compose[@]}" stop ;;
  restart) "${compose[@]}" restart app ;;
  status) "${compose[@]}" ps ;;
  logs) "${compose[@]}" logs --tail=100 --follow app ;;
  *) echo 'Usage: deploy/host.sh check|build|smoke|start|stop|restart|status|logs' >&2; exit 2 ;;
esac
