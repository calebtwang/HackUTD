# Setup and operation

Run commands from the project directory. Use Node 26.12 or later with npm on `PATH`; the launcher can also use `DEMO_NODE=/path/to/node` or the optional runtime at `../../work/node-runtime/bin/node`. The older `HONEYLINE_NODE` variable remains a compatibility alias. Provider accounts are unnecessary for a local rehearsal.

## 1. Install the browser runtime

```sh
scripts/start-demo.sh --install
```

This installs the locked project dependencies and Playwright Chromium. It does not buy numbers, configure accounts, publish a database, or start a run.

Create private configuration only if it does not already exist:

```sh
umask 077
mkdir -p .local
test -f .env || cp .env.example .env
chmod 600 .env
```

Edit this project's `.env` in a local text editor. Credentials and connection settings are read at startup; restart the app after changes. Do not overwrite a working `.env` with the example. `.local/` retains provider resource mappings, tested-readiness flags, worker identities, runtime state, and legacy fallback copies. Preserve those files when restarting this installation; both `.env` and `.local/` are ignored by Git.

| Settings in `.env` | Purpose |
| --- | --- |
| `SPACETIMEDB_HOST`, `SPACETIMEDB_DATABASE`, `SPACETIMEDB_TOKEN` | Database endpoint, name, and publishing-owner authentication |
| `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME` | Model discovery connection |
| `PHOTON_PROJECT_ID`, `PHOTON_API_KEY` | Existing Photon project connection |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_SECRET` | Agent setup and signed call events |
| `ELEVENLABS_SIP_USERNAME`, `ELEVENLABS_SIP_PASSWORD` | Matching SIP credentials used by both providers |
| `WORKER_SECRET`, `VOICE_TOOL_SECRET` | Stable private authentication values for workers and call observations |
| `PUBLIC_WEBHOOK_URL` | Public HTTPS origin for call events |
| Each profile's `*_PHONE`, `*_ELEVENLABS_AGENT_ID`, `*_ELEVENLABS_VOICE_ID` | Allocated number, assigned agent, and optional stock voice selection |

For an existing installation, copy its existing values into `.env` without changing them. A routine configuration cleanup must not rotate shared secrets or replace assigned provider IDs. Optional voice IDs may remain blank. Mara uses the internal ID `scout` and `SCOUT_*` variables; Otis uses `finch` and `FINCH_*`. These IDs preserve existing connections and do not assign different agent roles. See `.env.example` for the complete variable list.

## 2. Start a local SpacetimeDB database

The app uses the real SpacetimeDB 2.14.1 SDK/module. Install its CLI:

```sh
scripts/spacetime-setup.sh
scripts/spacetime.sh --version
npm install --prefix spacetimedb
```

Use a CLI compatible with the project's 2.14.1 module. If needed, select that release with `scripts/spacetime.sh version install 2.14.1 --use`. In one terminal, leave the local database running:

```sh
scripts/spacetime.sh start --listen-addr 127.0.0.1:3000 --data-dir .local/spacetime-data --non-interactive
```

In a second terminal, publish under an isolated local CLI identity:

```sh
scripts/spacetime.sh --config-path .local/spacetime-local.toml publish honeyline-demo --server http://127.0.0.1:3000 --module-path spacetimedb --delete-data=never --yes=skip-login
```

The publishing identity owns the database. The application bridge must use that same identity; an arbitrary new token cannot administer it. Save the CLI token directly as `SPACETIMEDB_TOKEN` in `.env` without displaying it:

```sh
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
const output = execFileSync('scripts/spacetime.sh', [
  '--config-path', '.local/spacetime-local.toml', 'login', 'show', '--token',
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tokens = [...new Set(output.match(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g) || [])];
if (tokens.length !== 1) throw new Error('Expected exactly one owner token; nothing was saved.');
const previous = readFileSync('.env', 'utf8');
const retained = previous.split('\n').filter(line => !/^\s*(?:export\s+)?SPACETIMEDB_TOKEN\s*=/.test(line)).join('\n').trimEnd();
const updated = retained + '\nSPACETIMEDB_TOKEN=' + JSON.stringify(tokens[0]) + '\n';
writeFileSync('.env.tmp', updated, { mode: 0o600 });
chmodSync('.env.tmp', 0o600);
renameSync('.env.tmp', '.env');
console.log('Owner token saved in the private .env file.');
NODE
```

The default `.env.example` points at this local database; the snippet fills in its owner token. Existing database names and hosted endpoint identifiers retain their original names for compatibility; do not rename them as part of a visual change. Use the same CLI configuration for future updates. `--delete-data=never` prevents an update from clearing database contents.

Generated SDK bindings are included. After changing the database schema, regenerate them and typecheck:

```sh
scripts/spacetime.sh generate --lang typescript --out-dir server/module_bindings --module-path spacetimedb
npm run check
```

### Maincloud instead of a local database

Sign in and publish your own uniquely named database with an isolated configuration:

```sh
scripts/spacetime.sh --config-path .local/spacetime-cloud.toml login --no-browser
scripts/spacetime.sh --config-path .local/spacetime-cloud.toml publish YOUR-UNIQUE-DATABASE-NAME --server maincloud --module-path spacetimedb --delete-data=never
```

Database names must be lowercase letters/numbers separated by dashes. Save the owner token with the snippet above, replacing only the CLI config path with `.local/spacetime-cloud.toml`. Set these `.env` entries to your values:

```dotenv
SPACETIMEDB_HOST=https://maincloud.spacetimedb.com
SPACETIMEDB_DATABASE=your-unique-database-name
```

`SPACETIMEDB_TOKEN` must belong to the selected host and database. Preserve the isolated local and cloud CLI configurations if switching between them. Workers automatically keep separate identity files for each host/database. The legacy `SPACETIMEDB_TOKEN_FILE` option remains supported, but a nonempty `SPACETIMEDB_TOKEN` takes precedence. Demo tables are readable by database subscribers, so use synthetic profiles and consented demonstration conversations.

## 3. Start the demo

```sh
scripts/start-demo.sh --check
scripts/start-demo.sh
```

Open [the agent manager](http://localhost:3210). On macOS, **Start Demo.command** runs the same launcher. The local app runs on port 3210 and its separate webhook receiver on port 3211 unless changed in `.env`. **Start** launches two equal browser-agent processes; no manual worker terminals are required. Each agent can use its own entry point, or leave it blank to wait for shared sites. Mara defaults to `http://localhost:3210/forum`; Otis defaults to blank. Discovery runs until **Stop** and checks entry points again every 60 seconds.

The manager shows only agent names, phone numbers, editable entry points, controls, and a Sites table with URLs and form instructions. Public HTTP(S) entry points receive bounded, read-only crawling. Their observed fields appear in Sites, with a **Read only** note; no external form is submitted. On owned demo pages, the agents submit their name and phone through the browser and coordinate subsequent submissions through SpacetimeDB.

Plain-text URL feeds add source-attributed listings immediately, before destination inspection. Rows update with pending, inspected, unavailable, analysis-failed, or not-flagged results. A failed fetch remains visible with its actual error; it never receives invented form instructions. A feed report is not independent verification, and observed field labels alone are not a validated submission recipe.

| Page | Contents |
| --- | --- |
| `/` | Agent manager and discovered sites |
| `/forum` | Owned forum and example links |
| `/phishing` | Fictional banking form: **Full name** and **Phone number** |
| `/admin` | Actual submitted, callable-format numbers only, one per line |
| `/debug` | Connections, rehearsal controls, submission receipts, activity, and call diagnostics |
| `/demo/benign-news` | Harmless library announcement |
| `/demo/benign-event` | Harmless seed-swap announcement |

For model discovery, set `MODEL_BASE_URL`, `MODEL_NAME`, and `MODEL_API_KEY` in `.env`, then restart. Both agents use that API when discovering in model mode. **Start** requires a database and model connection; phone readiness is independent. **Run rehearsal** on `/debug` uses owned entry points and fixed rules, and requires only the database; stop it manually when finished. `node --import tsx scripts/test-model.ts` exercises model analysis against the owned fixture while the app is running; this makes a real model request. Setting a Photon key in `.env` does not configure its phone routing.

## Hosting while the laptop is off

Use the [VM hosting guide](HOSTING.md) to run the server and both browser workers on a remote Linux host. The manager is public for viewing; a private `JUDGE_ACCESS_CODE` unlocks controls and diagnostics. Store it only in the VM's private environment file and share it with the presenters. The fixture domain serves the banking form at `/`, its forum at `/forum`, and received numbers at `/admin`; these pages do not load manager or call data. A laptop tunnel does not provide operation after the laptop turns off.

The [HackUTD hackerpack](https://hackutd-2026.notion.site/FREE-API-Credits-40d63cec774080ae8320e492785697bf) lists **$150 in 639Cloud credit** with coupon `HACKUTD2026` at [the 639Cloud portal](https://portal.639cloud.com/login). Its [official sponsor announcement](https://www.639cloud.com/featured-news/639cloud-sponsors-hackutd-zero-day) confirms that event credits can fund virtual machines. Those [VMs support full root access and hourly billing](https://www.639cloud.com/virtual-machines), which fits this app's Node server and Chromium workers. The event credit's expiry, card requirement, and behavior after credit runs out remain unconfirmed until shown in the account. Do not treat the advertised monthly VM price cap as a credit-only spending limit.

Stop the active local run and quit its server before starting the VM against the same database. Preserve the existing worker identity files and provider mappings during the move; do not run duplicate workers from both hosts. Starting or stopping the app does not cancel hosting or phone billing.

## Phone and call evidence setup

Photon requires a saved card even when existing credit covers the purchase and the amount due is $0; credit is applied before charging the card. Add payment details only in Photon's billing page, never in the demo or this repository, and provision numbers only within the approved budget. See [Photon payment methods and credit](https://photon.codes/docs/beta/invoices-and-payments).

Credit-first billing is not a guarantee of zero future card charges. This project does not enforce a provider-side card spending block, and Photon's API usage limit is soft: it does not stop usage. To end future number renewals after the demo, release the owned numbers in Photon and verify that release completes; stopping the app does not release them. A successful release closes the resource's charge period. See the [Photon API specification](https://api.photon.codes/openapi.json).

The presentation uses two lines for Mara and Otis. The setup steps below apply when reproducing or reconfiguring these connections; keep their existing provider mappings intact.

1. Create a Photon project and obtain only the voice-capable dedicated numbers needed for the presentation, using any applicable sponsor credit within the approved budget. Number provisioning is an account action; the code never purchases numbers. A failed or uncertain order must be resolved before placing a replacement order.
2. Set `ELEVENLABS_API_KEY`, `SCOUT_PHONE`, and `FINCH_PHONE` in `.env`. Use only actual allocated E.164 numbers, and preserve existing `*_ELEVENLABS_AGENT_ID` values. Keep new or reconfigured profiles' `voiceReady` flags false in `.local/personas.json` until testing.
3. For call evidence, provide an HTTPS receiver reachable by ElevenLabs. Either tunnel **only port 3211** for local development, or deploy the receiver in `cloud/` against your Maincloud database. Set `PUBLIC_WEBHOOK_URL` in `.env` to its origin. A hosted manager uses the separate access-controlled configuration in [the hosting guide](HOSTING.md).
4. Preview configuration without remote changes:

   ```sh
   node --import tsx scripts/configure-elevenlabs.ts --dry-run --agent all
   ```

5. Configure one agent first:

   ```sh
   node --import tsx scripts/configure-elevenlabs.ts --apply --agent scout
   ```

   This creates or updates this project's named agent, stock voice assignment, observation tool, and signed post-call webhook. It imports a configured existing number as a SIP number, saves IDs privately, and leaves `voiceReady` false. `--voice-only` omits the tool and webhook for an initial audio-only test; rerun without it for call diagnostics. `--agent all` configures both agents. Every apply clears the selected lines' readiness so they can be retested.

6. In Photon, enable inbound voice routing for each corresponding number. Use destination `sips:sip.rtc.elevenlabs.io:5061`, TLS transport, and Auto media encryption. Use the same `ELEVENLABS_SIP_USERNAME` and `ELEVENLABS_SIP_PASSWORD` values saved in `.env` for both providers. The script configures ElevenLabs to allow media encryption and use those credentials. Follow the current [Photon ElevenLabs cookbook](https://photon.codes/docs/beta/cookbooks/voice/elevenlabs). The optional `node --import tsx scripts/configure-photon.ts --dry-run` helper performs read-only account inspection. Select the already-owned resource IDs with `--resources=ID1` or `--resources=ID1,ID2`; review the dry-run before adding `--apply`. Use the two owned resource IDs for the current setup. The helper configures only the selected existing lines and never purchases numbers or places calls. Model discovery remains available independently of these phone tests.
7. Restart the app after the script saves its HMAC webhook secret. If using `cloud/`, configure its five bindings listed in `cloud/deployment.json` with the same database owner token, `VOICE_TOOL_SECRET`, and `ELEVENLABS_WEBHOOK_SECRET` as the local app. `node --import tsx scripts/build-webhook.ts` builds `.local/cloud/worker.mjs`; it does not deploy it. The public `/health` endpoint reports whether bindings are present. See [the hosted receiver guide](../cloud/README.md) for the current deployment and adapter contract.
8. Start model discovery or rehearsal so there is a current run and accepted profile submission. Call an allocated number from a consenting participant's phone. Verify two-way audio, the intended character, clean hangup, and the signed post-call update on `/debug`. The greeting should be only “Hello?”; the character asks who is calling and confirms its fictional name when asked. The caller introduces the pretend offer.
9. After a successful test, set only that persona's `voiceReady` to `true` in `.local/personas.json`, preserving its other fields. Keep its actual phone and assigned agent ID in `.env`, and restart the app while no run is active. Repeat for Mara and Otis. Tested numbers become call links independently of discovery readiness.

Each configured character uses a stock voice, short turns, a 240-second (four-minute) call maximum, a daily limit of 10 calls, one concurrent call, and disabled burst capacity. These agent limits do not cap Photon number renewals or guarantee a total spending limit. A caller mentioning the submitted name can produce only a possible association; neither a live observation nor a signed transcript makes name-only matching verified attribution. A late webhook from an older run is ignored. Keep the current run until its calls finish and their post-call updates arrive.

See [ElevenLabs SIP](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking), [dynamic variables](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables), and [post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks) for provider configuration details.

## Restart and troubleshooting

| Symptom | Check |
| --- | --- |
| Database disconnected | Database process/host, database name, and publishing-owner token must match. Restart the app after changing `.env`. |
| Start unavailable | Check the database and model connection on `/debug`; phone readiness is separate. Rehearsal needs only the database. |
| Phone number is not a call link | That profile needs an allocated number, linked voice agent, and successful inbound test before its readiness flag is enabled. |
| Chromium missing | Run `scripts/start-demo.sh --install`. |
| Worker registration fails after moving machines | Restore that worker's private token. Worker IDs remain bound to their first identities; deleting token files does not release them. |
| Model analysis rejected | Check its API connection and structured response. The app deliberately does not switch to rehearsal silently. |
| No call record during conversation | A call record is created by a reported observation or post-call webhook, not by a live audio connection event. Wait for the signed transcript. |
| Phone works but call details do not arrive | Check `/debug`, the current run, public endpoint, matching tool/HMAC secrets, current agent assignment, and provider webhook delivery status. |
| Node too old when double-clicking | Install supported Node or launch with `DEMO_NODE` pointing to it. |

**Stop** cancels worker activity; **Reset** clears demo data but preserves worker registrations. A new run also clears previous demo records. Preserve `.local/` and `.env` when restarting your own installation; exclude them when sharing public source. Control-C stops the app. A separately started local database needs its own Control-C.
