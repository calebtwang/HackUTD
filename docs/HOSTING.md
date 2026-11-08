# Ubuntu VM deployment

This deployment runs the app and its two worker processes on one VM, with Caddy providing HTTPS for `phoney.desmos.help`, `forum.desmos.help`, `bank.desmos.help`, and the original fixture alias `phish.popsicle.space`. Cutover is complete and the laptop app is stopped; the laptop is no longer needed to run the demo. SpacetimeDB remains on Maincloud; existing Photon, ElevenLabs, and the hosted call-event receiver continue to operate separately. This package does not create provider resources or change their configuration.

The deployed server is a **Vultr `vc2-2c-4gb` VM in Dallas: 2 vCPU, 4 GB RAM, Ubuntu 24.04 LTS, $20/month**. Source is installed at `/opt/hackutd`; private configuration and persistent worker identities are at `/opt/hackutd-private`. Run one app instance only. Both browser workers share that VM and its public IP.

`bank.desmos.help` is the default owned fixture hostname. The deployment network resets TLS connections to `phish.popsicle.space`, although direct server tests succeed. Cloudflare proxying did not resolve that network-specific failure, so the original DNS-only configuration was restored. Both bank hostnames provide the same `/phishing` and `/admin`, with the same exact-host and origin restrictions. The forum is served at `https://forum.desmos.help/`; the old bank `/forum` address redirects there. Its bank link points directly to `https://bank.desmos.help/phishing`. The forum is an explicit read-only discovery origin; only the bank origin accepts owned form submissions. Public entry points remain read-only.

**No hard billing cutoff is configured.** The user deferred that decision. The server continues to incur charges until it is removed under the provider's billing rules; stopping the application is not a billing cutoff.

## Deployment checks recorded on November 8, 2026

- The container image built on the VM. The Chromium smoke check and Caddy configuration check passed.
- Both public hostnames have valid HTTPS certificates. The app health check and Maincloud database connection passed.
- A complete fixed-rule rehearsal produced two actual browser submission receipts, 6.4 seconds apart.
- A complete live model run detected and verified the owned form, produced two actual accepted browser submission receipts, and completed both jobs. The second receipt arrived 10.873 seconds after the first.
- Both existing phone lines retain their previously tested readiness flags. No new provider call test was performed as part of this deployment.
- Restarting the app preserved both worker identity files, the active run, both receipts, and phone readiness; the database reconnected without duplicate submissions.
- The backup hostname also passed a live model run started through the public dashboard. Both real browser receipts appeared in its plain number list. The manager, bank, forum, and number list were opened successfully in the laptop browser through this hostname. The run was stopped with results preserved, ready for the next Start.
- The forum-domain update passed all 97 tests plus TypeScript checking. Two isolated browser sessions produced synthetic bank receipts after crossing from the separate forum; forum writes stayed blocked. The hosted browser smoke test followed the new forum root to the bank, verified its form instructions, and checked the old `/forum` redirect without changing the live run. HTTPS and forum host isolation passed public checks.
- SSH on port 22 uses key authentication only. The operator's current network blocked direct SSH, so a temporary authenticated HTTPS administration bridge was used for installation. The running app does not depend on that bridge; future administration can use direct key-based SSH from a network that permits port 22.

These checks establish hosted browser discovery and submission behavior. They do not claim a new end-to-end phone test after deployment.

## Files and runtime

The bank `/admin` page shows twelve fixed fictional starter numbers, followed by unique phone numbers from accepted browser submission receipts. It refreshes its list automatically every second. Reset clears the real submission receipts and leaves the same starter list; fixture entries never enter SpacetimeDB or count as agent successes.

- `Dockerfile` pins Node `26.13.0-bookworm-slim`, installs the locked npm dependencies including `tsx`, installs the matching Playwright Chromium and Linux libraries, and builds the UI. Development packages remain installed because the runtime uses `tsx`.
- `deploy/compose.yaml` runs one app container and Caddy `2.11.9-alpine`. App memory is capped at 3 GB, Caddy at 256 MB. Only Caddy publishes ports; app ports 3210/3211 stay private.
- `deploy/Caddyfile` serves only the manager, forum, and two specified bank hostnames. The app enforces the separate manager/form host rules and requires the judge access code for controls and full state.
- The app runs as UID/GID 1000 with a read-only image. Its `.local` directory and temporary browser storage are writable. Docker's init process collects exited browser processes.
- Docker restarts exited containers. A supervisor also restarts an app that fails four consecutive HTTP health probes after its startup grace period. Temporary database disconnection uses the app's reconnect logic instead of triggering restart loops.

The exact image tags were confirmed in the official registries, and the image was built and started on the deployed VM. [Node image](https://hub.docker.com/_/node/), [Caddy image](https://hub.docker.com/_/caddy), and [Playwright browser installation](https://playwright.dev/docs/browsers) explain the base/runtime requirements. Repeat the build and smoke checks below when changing runtime dependencies or moving to another server.

## Prepare the VM

The following instructions document a fresh deployment or recovery; the current VM is already provisioned at the paths above.

1. Select the VM in the approved hosting account and verify its price, applied credits, credit expiration, and any automatic renewal before provisioning. This package does not assume an unverified credit expiration or spending cap.
2. Allow inbound TCP 80/443 and, optionally, UDP 443. Limit SSH to the operator's address. Do not publish 3210, 3211, a database port, or Docker's socket.
3. Point DNS A records for the manager, forum, and configured bank hostnames at the VM's public IPv4 address. Add AAAA records only if the VM's IPv6 route works. Caddy obtains certificates after DNS and ports are ready.
4. Place the source at `/opt/hackutd`. On a fresh Ubuntu VM, run `sudo bash deploy/install-docker-ubuntu.sh`. The script uses [Docker's official apt repository](https://docs.docker.com/engine/install/ubuntu/); it does not run a downloaded installer script. If conflicting Docker packages already exist, resolve them using the official instructions instead of deleting unrelated services.

To create a source-only transfer archive from the project checkout:

```sh
python3 deploy/package-source.py /tmp/hackutd-source.tar.gz
```

It contains deployment/runtime source, not `.env`, `.local`, Git history, screenshots, `dist`, or `node_modules`. Transfer this archive over SSH and extract it into `/opt/hackutd`. Alternatively, use the current approved source checkout. Build the image before cutover; building does not start the app:

```sh
cd /opt/hackutd
sudo ./deploy/host.sh check
sudo ./deploy/host.sh build
sudo ./deploy/host.sh smoke
```

The smoke check launches Chromium against an offline in-memory page and validates Caddy's configuration. It mounts no credentials, starts no app workers, and makes no phone calls.

## Migrate the existing private configuration

Use the existing database, provider IDs, and worker identities. Each registered worker ID is bound to its saved SpacetimeDB identity; creating new token files on the VM will not recover that registration.

1. Build and prepare the VM first. When ready to move, press **Stop** in the current manager, wait for its workers to stop, and quit the laptop app. Do not run the laptop app and VM app against the same database at the same time. This deliberate stop preserves the current results; do not use Reset.
2. Export only the required private files, using the supported Node runtime from the existing installation:

   ```sh
   node deploy/export-private.mjs /tmp/hackutd-private.tar.gz
   ```

   The script derives the current database namespace from `.env` and includes exactly `.env`, `.local/personas.json`, and the current `worker-scout-<namespace>.json` / `worker-finch-<namespace>.json`. It omits old worker identities, Wren, logs, transcripts, and other `.local` files. It refuses missing or mismatched identities and never prints their contents. The archive is private, mode 0600, and must stay outside the source checkout.
3. Transfer that archive over SSH. On the VM, create `/opt/hackutd-private` as a private directory, extract with `--no-same-owner`, and rename its `.env` to `demo.env`. Keep only the four transferred files. Do not extract secrets into `/opt/hackutd`.
4. Privately edit `/opt/hackutd-private/demo.env` to add `JUDGE_ACCESS_CODE` with at least 6 nonblank characters. Preserve the existing model, database, Photon, ElevenLabs, shared-secret, phone, and agent-ID values. `SPACETIMEDB_TOKEN` must contain the existing database owner token; this migration does not use an old laptop file path. Keep `PUBLIC_WEBHOOK_URL` pointed at the already working hosted call-event receiver. No phone purchase or provider reconfiguration is part of this step.
5. Set the private directory and its contents to UID/GID 1000; directories mode 0700, files mode 0600. For example, after verifying the destination path:

   ```sh
   sudo chown -R 1000:1000 /opt/hackutd-private
   sudo find /opt/hackutd-private -type d -exec chmod 700 {} +
   sudo find /opt/hackutd-private -type f -exec chmod 600 {} +
   ```

   Remove the temporary private archives from both machines after confirming the transfer. Keep the original installation's private files as the recovery copy; never add an archive or credential file to Git.

Compose mounts `demo.env` read-only at `/run/secrets/demo.env` and `.local` at `/app/.local`. Secrets are loaded by dotenv at startup rather than embedded in the image or Compose configuration. The following non-secret settings are fixed by Compose and take precedence over the transferred file:

| Setting | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` / `WEBHOOK_PORT` | `3210` / `3211` |
| `MANAGER_PUBLIC_ORIGIN` | `https://phoney.desmos.help` |
| `DEMO_PUBLIC_ORIGIN` | `https://bank.desmos.help` |
| `FORUM_PUBLIC_ORIGIN` | `https://forum.desmos.help` |
| `DEMO_PUBLIC_ALIASES` | `https://phish.popsicle.space` |
| `DOTENV_CONFIG_PATH` | `/run/secrets/demo.env` |

The supervisor refuses to start if the migrated identities, tested-readiness file, database owner token, shared secrets, or judge access code are missing. A persisted run whose owned origin is still localhost cannot be resumed on the new host; start a new hosted run after migration rather than altering old receipts.

## Start and verify

After the laptop app is stopped and the private files are in place:

```sh
cd /opt/hackutd
sudo ./deploy/host.sh start
sudo ./deploy/host.sh status
```

Confirm the app is healthy and Caddy obtains certificates. Open the manager hostname, authenticate with the judge code, and verify the existing phone readiness and database connection. Confirm the form hostname displays the owned demo and cannot open manager controls. Start a hosted rehearsal and wait for both real browser submissions to appear before testing model discovery. Confirm a container restart retains the same worker identities and reconnects to the same run. Actual phone tests are a separate, consented step; do not place automatic calls as a deployment health check.

Useful commands:

```sh
sudo ./deploy/host.sh logs
sudo ./deploy/host.sh restart
sudo ./deploy/host.sh stop
```

`stop` stops containers without deleting private state or TLS certificates. To change source, build the new image, then run `start` to recreate the app with the same private mount. When replacing `deploy/Caddyfile` through an archive extraction, recreate the Caddy container so its bind mount uses the replacement file; reloading a container that still holds the old inode will keep the old configuration. To change a mounted env value, restart the app. Do not scale the app service or run another copy on a second host. Keep Caddy's named data volume: it holds certificates and private keys. [Caddy persistence guidance](https://hub.docker.com/_/caddy).

For rollback, stop the VM app before restarting the laptop installation. End any running hosted run before starting a local one; its owned form origin differs. Keep the database and saved worker identities intact throughout. Stopping a VM does not necessarily stop hosting charges, and this deployment does not release paid phone numbers or cancel their renewals.
