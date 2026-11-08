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

The publishing identity owns the database. The application bridge must use that same identity; an arbitrary new token cannot administer it. Export the CLI token directly to a private file without displaying it:

```sh
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
import { writeFileSync, chmodSync } from 'node:fs';
const output = execFileSync('scripts/spacetime.sh', [
  '--config-path', '.local/spacetime-local.toml', 'login', 'show', '--token',
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tokens = [...new Set(output.match(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g) || [])];
if (tokens.length !== 1) throw new Error('Expected exactly one owner token; nothing was saved.');
writeFileSync('.local/admin-token', tokens[0] + '\n', { mode: 0o600 });
chmodSync('.local/admin-token', 0o600);
console.log('Owner token saved privately.');
NODE
```

The default `.env.example` points at this local database and token file. Existing database names and hosted endpoint identifiers retain their original names for compatibility; do not rename them as part of a visual change. Use the same CLI configuration for future updates. `--delete-data=never` prevents an update from clearing database contents.

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

Database names must be lowercase letters/numbers separated by dashes. Export the owner token with the snippet above, replacing the config path with `.local/spacetime-cloud.toml` and the destination with `.local/admin-token-cloud`. Set these `.env` entries to your values:

```dotenv
SPACETIMEDB_HOST=https://maincloud.spacetimedb.com
SPACETIMEDB_DATABASE=your-unique-database-name
SPACETIMEDB_TOKEN_FILE=.local/admin-token-cloud
```

Leave `SPACETIMEDB_TOKEN` blank when using a token file. Preserve the local and cloud tokens separately. Workers automatically keep separate identity files for each host/database. Demo tables are readable by database subscribers, so use synthetic profiles and consented demonstration conversations.

## 3. Start the demo

```sh
scripts/start-demo.sh --check
scripts/start-demo.sh
```

Open [the dashboard](http://127.0.0.1:3210). On macOS, **Start Demo.command** runs the same launcher. The local app runs on port 3210 and its separate webhook receiver on port 3211 unless changed in `.env`. The **Run rehearsal** button launches three browser-worker processes automatically. No manual worker terminals are required. The app records activity in the interface and prints concise worker events to its terminal.

The [admin page](http://127.0.0.1:3210/admin) lists only actual submitted phone numbers. Use the dashboard or evidence page for synthetic names, references, sites, and all three worker receipts. The demo form retains the labels **Full name**, **Phone number**, and **Reference**.

The local-only [connections page](http://127.0.0.1:3210/setup) accepts model and provider keys without displaying saved values. Saving a Photon key does not configure its phone routing. For a model connection, supply the provider's OpenAI-compatible API base URL, model ID, and key. The scout calls that API only in the model demo. Model discovery requires a database and model connection; phone readiness is independent. `node --import tsx scripts/test-model.ts` exercises model analysis against the owned fixture while the app is running; this makes a real model request.

## Phone and call evidence setup

Photon requires a saved card even when existing credit covers the purchase and the amount due is $0; credit is applied before charging the card. Add payment details only in Photon's billing page, never in the demo or this repository, and provision numbers only within the approved budget. See [Photon payment methods and credit](https://photon.codes/docs/beta/invoices-and-payments).

Credit-first billing is not a guarantee of zero future card charges. This project does not enforce a provider-side card spending block, and Photon's API usage limit is soft: it does not stop usage. To end future number renewals after the demo, release the owned numbers in Photon and verify that release completes; stopping the app does not release them. A successful release closes the resource's charge period. See the [Photon API specification](https://api.photon.codes/openapi.json).

The current presentation uses two tested lines for Scout and Finch. Wren stays browser-only, with `DEMO-WREN` as its form value. All three workers still participate in the model demo and in rehearsal; no third number is required to demonstrate coordination. The setup steps below apply when reproducing or reconfiguring these connections.

1. Create a Photon project and obtain only the voice-capable dedicated numbers needed for the presentation, using any applicable sponsor credit within the approved budget. Number provisioning is an account action; the code never purchases numbers. A failed or uncertain order must be resolved before placing a replacement order.
2. Save the ElevenLabs API key locally. Set the selected profiles' phone entries in `.local/personas.json`, or their `SCOUT_PHONE`, `FINCH_PHONE`, and `WREN_PHONE` environment overrides, to the actual E.164 numbers. Preserve existing agent IDs and keep `voiceReady` false until testing. Leave Wren's phone blank for the current two-line setup; the app supplies `DEMO-WREN` in browser submissions.
3. For call evidence, provide an HTTPS receiver reachable by ElevenLabs. Either tunnel **only port 3211**, or deploy the receiver in `cloud/` against your Maincloud database. Set `PUBLIC_WEBHOOK_URL` to its origin. Never expose the dashboard's local setup page through this connection.
4. Preview configuration without remote changes:

   ```sh
   node --import tsx scripts/configure-elevenlabs.ts --dry-run --agent all
   ```

5. Configure one agent first:

   ```sh
   node --import tsx scripts/configure-elevenlabs.ts --apply --agent scout
   ```

   This creates or updates this project's named agent, stock voice assignment, observation tool, and signed post-call webhook. It imports a configured existing number as a SIP number, saves IDs privately, and leaves `voiceReady` false. `--voice-only` omits the tool and webhook for an initial audio-only test; rerun without it for evidence. `--agent all` configures all three. Every apply clears the selected lines' readiness so they can be retested.

6. In Photon, enable inbound voice routing for each corresponding number. Use destination `sips:sip.rtc.elevenlabs.io:5061`, TLS transport, and Auto media encryption. Copy the SIP username/password from the private `.local/elevenlabs-sip.json` file into Photon's routing configuration. The script configures ElevenLabs to allow media encryption and use the same credentials. Follow the current [Photon ElevenLabs cookbook](https://photon.codes/docs/beta/cookbooks/voice/elevenlabs). The optional `node --import tsx scripts/configure-photon.ts --dry-run` helper performs read-only account inspection. Select one to three distinct, already-owned resource IDs with `--resources=ID1`, `--resources=ID1,ID2`, or `--resources=ID1,ID2,ID3`; review the dry-run before adding `--apply`. Use the two owned resource IDs for the current setup. The helper configures only the selected existing lines and never purchases numbers or places calls. Model discovery remains available independently of these phone tests.
7. Restart the app after the script saves its HMAC webhook secret. If using `cloud/`, configure its five bindings listed in `cloud/deployment.json` with the same database owner token, `VOICE_TOOL_SECRET`, and `ELEVENLABS_WEBHOOK_SECRET` as the local app. `node --import tsx scripts/build-webhook.ts` builds `.local/cloud/worker.mjs`; it does not deploy it. The public `/health` endpoint reports whether bindings are present. See [the hosted receiver guide](../cloud/README.md) for the current deployment and adapter contract.
8. Start a model demo or rehearsal so there is a current run and accepted profile submission. Call an allocated number from a consenting participant's phone. Verify two-way audio, the intended character, clean hangup, and the signed post-call evidence. The greeting should be only “Hello?”; the character must not announce its synthetic reference first. A browser-only placeholder cannot be called.
9. After a successful test, set only that persona's `voiceReady` to `true` in `.local/personas.json`, preserving its existing phone, agent ID, and other fields. Restart the app while no run is active, or POST `/api/setup/reload` locally. Repeat for Scout and Finch. Keep Wren's `voiceReady` false. A tested line can offer **Call me** independently; the model demo does not require three phone lines.

Each configured character uses a stock voice, short turns, a 240-second (four-minute) call maximum, a daily limit of 10 calls, one concurrent call, and disabled burst capacity. These agent limits do not cap Photon number renewals or guarantee a total spending limit. A live tool report is provisional; completed caller transcripts establish marker evidence. A late webhook from an older run is ignored. Keep the current run until its calls finish and their evidence arrives.

See [ElevenLabs SIP](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking), [dynamic variables](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables), and [post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks) for provider configuration details.

## Restart and troubleshooting

| Symptom | Check |
| --- | --- |
| Database disconnected | Database process/host, database name, and publishing-owner token must match. Restart the app after changing `.env`. |
| Model demo unavailable | Check the database and model connection; phone readiness is separate. Rehearsal needs only the database. |
| Call me unavailable | That profile needs an allocated number, linked voice agent, and successful inbound test before its readiness flag is enabled. Wren is browser-only in the two-line setup. |
| Chromium missing | Run `scripts/start-demo.sh --install`. |
| Worker registration fails after moving machines | Restore that worker's private token. Worker IDs remain bound to their first identities; deleting token files does not release them. |
| Model analysis rejected | Check its API connection and structured response. The app deliberately does not switch to rehearsal silently. |
| No call record during conversation | A call record is created by a reported observation or post-call webhook, not by a live audio connection event. Wait for the signed transcript. |
| Phone works but evidence does not arrive | Check the current run, public endpoint, matching tool/HMAC secrets, current agent assignment, and provider webhook delivery status. |
| Node too old when double-clicking | Install supported Node or launch with `DEMO_NODE` pointing to it. |

**Stop** cancels worker activity; **Reset** clears demo data but preserves worker registrations. A new run also clears previous demo records. Preserve `.local/` and `.env` when restarting your own installation; exclude them when sharing public source. Control-C stops the app. A separately started local database needs its own Control-C.
