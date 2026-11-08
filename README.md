# HackUTD scam-call demo

A scout finds a callback form on an owned demo site, submits a fictional profile, and shares the form instructions through SpacetimeDB. Two other browser workers submit their profiles after short, randomized delays. Two tested Photon phone lines connect volunteer callers to ElevenLabs characters.

Source: [calebtwang/HackUTD](https://github.com/calebtwang/HackUTD).

Everything the scout visits is part of this project's clearly marked demonstration. Browser workers enforce the exact local origin, including redirects and subresources. They run as three separate processes on one computer; this demo does not provide separate IP addresses or crawl real scam sites.

## What is implemented

- A fake forum, callback form, benign comparison pages, and an admin page listing actual submitted phone numbers only. Names, references, sites, and worker receipts appear on the dashboard or evidence page.
- Three Playwright workers with separate database identities. The scout reads page content and form labels; followers receive persisted jobs through real SpacetimeDB subscriptions.
- Database-owned authorization, verified receipts, randomized schedules, job leases, and idempotent submissions.
- Two explicitly labeled discovery modes: the **model demo** uses a configured text-model API; **rehearsal** uses fixed fixture rules. Both perform real browser submissions and database coordination. Phone readiness is tracked separately.
- Photon-to-ElevenLabs SIP setup helpers, three fictional voice personas, provisional call observations, and signed post-call transcript matching. Phone numbers, provider credentials, routing, and a successful inbound test are separate setup requirements.

The current setup has three browser workers and two tested phone lines, for Scout and Finch. Wren is browser-only and submits `DEMO-WREN`, which is not a phone number and is omitted from the admin number list. All three accepted submissions remain visible in the worker/evidence views. New or reconfigured phone lines must pass a call test before their readiness flags are enabled.

## Run

Use Node **26.12 or newer**. The launcher accepts `DEMO_NODE=/path/to/node` and also finds the optional Node runtime in the surrounding workspace.

```sh
scripts/start-demo.sh --install
```

Configure SpacetimeDB using [the setup instructions](docs/SETUP.md), then run:

```sh
scripts/start-demo.sh
```

Open [the demo](http://127.0.0.1:3210). On macOS, **Start Demo.command** runs the same launcher. Keep its terminal open. The database must already be running, or the app must point at your published Maincloud database.

**Run rehearsal** needs only the database. **Start model demo** additionally requires a model connection and can run before phone setup is complete. Calls use only the separately tested lines; a browser-only worker still participates in discovery and submission. See [the judge walkthrough](docs/DEMO.md) and [voice setup](docs/SETUP.md#phone-and-call-evidence-setup).

## Call evidence

Each synthetic reference belongs to one profile's submission. A live model report produces a **possible** connection. A signed post-call transcript can establish that the caller said the reference before the character disclosed it. This connects the call to the seeded submission; it does not identify a caller or prove who operates a website. The app has no live audio stream or live transcript feed.

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

`.env` and `.local/` are private runtime state and are ignored by Git. Keep provider keys, SIP credentials, owner/worker tokens, call transcripts, and personal configuration out of a public source export. Share source and lockfiles; reinstall `node_modules`, Chromium, and runtimes on the destination machine. The dashboard and browser workers run locally; the webhook receiver can be hosted publicly to accept provider events. This project does not include automatic number purchases, outbound calls, SMS continuation, or real-world scam interception.
