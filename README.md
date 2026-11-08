# HackUTD scam-call demo

Two equal agents, Mara and Otis, discover sites from their own entry points and share findings through SpacetimeDB. On the owned demo form, an agent submits its fictional name and phone number; the other agent receives the form instructions and submits after a randomized delay. Photon phone lines connect volunteer callers to ElevenLabs characters.

Source: [calebtwang/HackUTD](https://github.com/calebtwang/HackUTD).

Public HTTP(S) entry points support bounded, read-only discovery. The manager shows the actual discovered URLs and observed fields; external forms are never submitted. Automatic submissions are limited to the owned demo origin. The two workers share one host, without separate IP addresses.

Public entry points can also be plain-text lists with one URL per line. For example, paste the [OpenPhish Community Feed](https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt) into Entry point. Feed-listed URLs appear in Sites immediately with their source and pending inspection. Each row then reports the actual inspection result, including fetch failures, analysis failures, or a page not flagged on inspection. A feed listing is a third-party report, not independent verification. Public pages are read as HTML without running their JavaScript; observed field labels are shown separately from usable form instructions.

## What is implemented

- A fake forum, two-field callback form, benign comparison pages, and an admin page listing actual submitted phone numbers only. The manager's Sites table shows URLs and form instructions; submission receipts appear on `/debug`.
- Two browser workers with separate database identities. Both can discover from an entry point and receive shared sites through real SpacetimeDB subscriptions. Leaving an entry point blank makes that agent wait for shared sites.
- Database-owned authorization, verified receipts, randomized schedules, job leases, and idempotent submissions.
- Two explicitly labeled discovery modes: **Start** uses a configured text-model API; **Run rehearsal** on `/debug` uses fixed fixture rules. Owned-page submissions and database coordination are real in both modes. Phone readiness is tracked separately.
- Photon-to-ElevenLabs SIP setup helpers, two fictional voice personas, provisional call observations, and signed post-call transcripts. Phone numbers, provider credentials, routing, and a successful inbound test are separate setup requirements.

Mara retains the internal ID `scout`, and Otis retains `finch` so existing provider mappings keep working. These IDs do not assign different roles. New or reconfigured phone lines must pass a call test before their readiness flags are enabled.

## Run

Use Node **26.12 or newer**. The launcher accepts `DEMO_NODE=/path/to/node` and also finds the optional Node runtime in the surrounding workspace.

```sh
scripts/start-demo.sh --install
```

Configure SpacetimeDB and the project's private `.env` using [the setup instructions](docs/SETUP.md), then run:

```sh
scripts/start-demo.sh
```

Open [the demo](http://127.0.0.1:3210). On macOS, **Start Demo.command** runs the same launcher. Keep its terminal open. The database must already be running, or the app must point at your published Maincloud database.

For operation while the laptop is off, use the [VM hosting guide](docs/HOSTING.md). The hosted manager is publicly viewable; its access code unlocks entry-point editing, Start/Stop/Reset, and `/debug`. The separate fixture domain opens the fictional banking form at `/`, with its forum at `/forum` and number list at `/admin`. Fixture pages never load manager snapshots or call transcripts. Local development remains trusted and needs no access code.

Credentials and connection settings belong in the project-root `.env`, using `.env.example` as the template. They load at startup, so restart after changes. `.local/` retains resource mappings, tested-readiness flags, runtime state, and any legacy fallback copies. Both are ignored by Git; the app has no credential-entry page.

Set each agent's **Entry point**, then click **Start**. Mara defaults to `http://localhost:3210/forum`; Otis defaults to blank. Either agent can receive an entry point. Discovery continues until **Stop**, checking entry points again every 60 seconds and adding new findings to Sites. **Start** requires a database and model connection; **Run rehearsal** on `/debug` needs only the database. Phone setup is separate. See [the judge walkthrough](docs/DEMO.md) and [voice setup](docs/SETUP.md#phone-and-call-evidence-setup).

| Page | Purpose |
| --- | --- |
| `/` | Agent entry points, controls, and live Sites table |
| `/forum` | Owned forum linking the example pages |
| `/phishing` | Fictional banking form with Full name and Phone number |
| `/admin` | Received callable-format numbers, one per line |
| `/debug` | Connections, rehearsal, receipts, activity, and call diagnostics |
| `/demo/benign-news` | Harmless library announcement |
| `/demo/benign-event` | Harmless seed-swap announcement |

## Call evidence

A caller mentioning a submitted fictional name can produce a **possible association** with that submission. Name-only observations are not verified attribution, even when they come from a signed post-call transcript. Call diagnostics and transcripts appear on `/debug`. The app has no live audio stream or live transcript feed.

## Development

```sh
npm run check
npm test
npm run build
```

Tests cover state transitions, receipt gating, retries, source matching, webhook handling, model output validation, and browser origin isolation. `build` compiles the React interface; run the app through the Node server, which also supplies its APIs.

Follow the [project design rules](AGENTS.md): plain controls, short labels, and only information needed to operate or understand the demo.

| Path | Purpose |
| --- | --- |
| `src/` | Dashboard and owned demonstration pages |
| `workers/` | Browser agents, model adapter, validated form recipes |
| `spacetimedb/src/` | Database tables and transaction rules |
| `server/` | Local app, database bridge, call evidence handling |
| `cloud/` | Optional public webhook receiver for a Maincloud database |
| `scripts/` | Runtime, database, and provider configuration helpers |
| `shared/contracts.ts` | Shared types and fictional personas |

Keep `.env`, `.local/`, provider keys, SIP credentials, owner/worker tokens, call transcripts, and personal configuration out of a public source export. Share source, `.env.example`, and lockfiles; reinstall `node_modules`, Chromium, and runtimes on the destination machine. The manager and browser workers can run on a local computer or a VM; the webhook receiver can be hosted separately. This project does not include automatic number purchases, outbound calls, SMS continuation, or real-world scam interception.
