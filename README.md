# HackUTD scam-call demo

SpacetimeDB is the whole backend. One TypeScript module (SpacetimeDB 2.14.1, `spacetimedb/src`) holds every table, enforces every rule in its reducers, drives a recurring simulation from its own scheduler, and serves two public views. There is no separate application database and no server-side business logic outside the module: the Express bridge, the browser board, three Playwright workers, and a Cloudflare webhook worker are all just SpacetimeDB clients.

A scout finds a callback form on an owned demo site, submits a fictional profile, and shares the form instructions through SpacetimeDB. Two other browser workers submit their profiles after short, randomized delays. Two tested Photon phone lines connect volunteer callers to ElevenLabs characters.

Source: [calebtwang/HackUTD](https://github.com/calebtwang/HackUTD).

Everything the scout visits is part of this project's clearly marked demonstration. Browser workers enforce the exact local origin, including redirects and subresources. They run as three separate processes on one computer; this demo does not provide separate IP addresses or crawl real scam sites.

## Architecture

Every client talks to the one module. The module also schedules itself.

```
     Playwright worker: scout  (own identity) ─┐
     Playwright worker: finch  (own identity) ─┤
     Playwright worker: wren   (own identity) ─┤
                                               │  dispatch(action, payload)
     Express bridge (owner identity) ──────────┤  + simulation reducers
                                               │
                                               v
                                   ┌───────────────────────┐
     Browser board ──subscribe──>  │   SpacetimeDB module   │
     (anonymous, read-only)        │   honeyline-demo       │
                                   │                        │
     Cloudflare webhook worker ──> │  tables + reducers +   │
     (owner identity, call_event)  │  views + scheduler     │
                                   └───────────┬───────────┘
                                               │ ScheduleAt.interval(2s)
                                               v
                                          sim_tick reducer
                                      (advances the simulation)
```

- Three Playwright worker processes each register under a separate database identity and submit through `dispatch`.
- The Express bridge runs as the publishing owner identity and relays browser and provider activity into `dispatch`.
- The browser board subscribes directly to the public tables and views as an anonymous reader; it issues no reducers.
- The Cloudflare webhook worker forwards signed provider events as `dispatch('call_event', ...)` under the owner identity.
- The module's own scheduler fires `sim_tick` every two seconds while a simulation is running; no client drives it.

## What is implemented

- A fake forum, callback form, benign comparison pages, and an admin page listing actual submitted phone numbers only. Names, references, sites, and worker receipts appear on the dashboard or evidence page.
- Three Playwright workers with separate database identities. The scout reads page content and form labels; followers receive persisted jobs through real SpacetimeDB subscriptions.
- Database-owned authorization, verified receipts, randomized schedules, job leases, and idempotent submissions.
- Two explicitly labeled discovery modes: the **model demo** uses a configured text-model API; **rehearsal** uses fixed fixture rules. Both perform real browser submissions and database coordination. Phone readiness is tracked separately.
- Photon-to-ElevenLabs SIP setup helpers, three fictional voice personas, provisional call observations, and signed post-call transcript matching. Phone numbers, provider credentials, routing, and a successful inbound test are separate setup requirements.

The current setup has three browser workers and two tested phone lines, for Scout and Finch. Wren is browser-only and submits `DEMO-WREN`, which is not a phone number and is omitted from the admin number list. All three accepted submissions remain visible in the worker/evidence views. New or reconfigured phone lines must pass a call test before their readiness flags are enabled.

## Rules enforced by the database

These hold regardless of what a client sends, because the module checks them inside the reducer before it writes. Each rule names the reducer or view that enforces it; all are in `spacetimedb/src` (`logic.ts` holds the `dispatch` state machine, `index.ts` the reducers and views).

- Only the publishing owner identity can configure, start, stop, reset, accept submissions, or record calls — `dispatch` (`configure`, `start_run`, `stop_run`, `reset`, `accept_submission`, `call_event`).
- A worker can only act under its own first-seen identity and the shared worker secret — `dispatch` (`register_worker`, `worker`).
- Exactly three personas (scout, finch, wren) with unique markers, and phones in E.164 or an explicit `DEMO-` form — `dispatch` (`configure`).
- Reconfiguring an unchanged running demo is a no-op; personas cannot change while a run is running — `dispatch` (`configure`).
- Only the scout discovers a site, and only one site per run, on the run's own owned origin — `dispatch` (`discover_site`).
- A site is broadcast to followers only after the scout's own submission is accepted — `dispatch` (`publish_site`).
- Follower jobs are released on randomized schedules and leased, so a job runs once at a time and only when due — `dispatch` (`publish_site`, `claim_job`).
- A submission is accepted only against a claimed, unexpired job, must match the agent's configured alias, and is idempotent per run/site/agent — `dispatch` (`accept_submission`).
- A job completes only with a verified acceptance receipt — `dispatch` (`complete_job`).
- A late or provisional call write never downgrades completed or verified call evidence — `dispatch` (`call_event`).
- Only verified live calls are mirrored into the simulation tables as `source: 'live'`, idempotently by external call id, with the persona phone stored masked — `dispatch` / `recordLive`.
- Only the owner can start or stop the simulation, and `sim_tick` runs only when its sender is the database itself — `start_simulation`, `stop_simulation`, `sim_tick`.
- The admin number list exposes only submitted phone numbers in callable E.164 format, with no names or source — `collector_numbers` view.
- The operator ledger exposes identity and source for each submission but never the phone number — `operator_ledger` view.

## Simulation

The simulation exists to show scale on the board without making real calls. It is clearly separated from live activity.

- **Live** rows come only from real demo activity: discovered sites, accepted submissions, and calls verified by a signed transcript. They are written by `dispatch`/`recordLive` and carry `source: 'live'`.
- **Simulated** rows are generated in-database by the `sim_tick` scheduled reducer from the pure model in `spacetimedb/src/sim.ts`. Every such row carries `source: 'simulated'` (rings and purchases are simulation-only by construction). The board labels them as simulated; a simulated call is never counted as a verified match.
- It is **deterministic**: `start_simulation(seed, personaCount, siteCount, ringCount)` seeds the world, and each tick derives its RNG from the seed and tick number, so the same seed replays identically. The module uses no wall clock or `Math.random`.
- `sim.ts` has no SpacetimeDB imports and is unit-tested directly from Node (`tests/sim.test.ts`): determinism, seed divergence, count floors, marker-to-persona attribution, leakiness ordering, and marker uniqueness.

## Tables and views

All names are the SQL (snake_case) names. The private tables are not subscribable by anonymous readers.

| Name | Kind | Public | Holds |
| --- | --- | --- | --- |
| `config` | table | no | Owner identity, worker secret, and worker-identity map (JSON) |
| `demo_run` | table | yes | The current run |
| `agent` | table | yes | The three personas and their status |
| `site` | table | yes | Discovered site and its form recipe |
| `job` | table | yes | Follower jobs, leases, and receipts |
| `submission` | table | yes | Accepted submissions |
| `demo_event` | table | yes | Activity log |
| `call` | table | yes | Call records and match status |
| `sim_site` | table | yes | Sites (live and simulated) with leak and traced-call counts |
| `sim_persona` | table | yes | Personas with masked phone and marker |
| `sim_plant` | table | yes | Persona-on-site plants |
| `sim_ring` | table | yes | Simulated caller rings |
| `sim_ring_purchase` | table | yes | Which rings bought which site lists |
| `leak_call` | table | yes | Individual calls (live and simulated) |
| `sim_stats` | table | yes | Running flag, seed, tick, and aggregate counters |
| `sim_tick_schedule` | table | no | Private schedule row driving `sim_tick` |
| `collector_numbers` | view | yes | Submitted E.164 phone numbers only |
| `operator_ledger` | view | yes | Submission identity and source, no phone number |

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

The in-database simulation is independent of a run. Start and stop it from the CLI as the owner; it labels all generated rows as simulated and advances on the module's own scheduler. See [simulation controls](docs/SETUP.md#simulation-controls).

## Call evidence

Each synthetic reference belongs to one profile's submission. A live model report produces a **possible** connection. A signed post-call transcript can establish that the caller said the reference before the character disclosed it. This connects the call to the seeded submission; it does not identify a caller or prove who operates a website. The app has no live audio stream or live transcript feed.

## Development

```sh
npm run check
npm test
npm run build
```

Tests cover state transitions, receipt gating, retries, source matching, webhook handling, model output validation, browser origin isolation, and the deterministic simulation model (`tests/sim.test.ts`). `build` compiles the React interface; run the app through the Node server, which also supplies its APIs.

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
