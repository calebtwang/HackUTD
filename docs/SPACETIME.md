# SpacetimeDB responsibilities

SpacetimeDB stores the demo's shared state and enforces its coordination rules. Two browser workers have separate database identities and subscribe to committed changes. Either worker can discover a site; the other receives work only after the discoverer's form submission has an accepted receipt.

**Integration status:** native job timers, private raw tables, and restricted backend views are implemented and published to Maincloud without deleting existing data. The updated VM application is healthy. The verification results below distinguish hosted migration checks from the complete browser, Reset, and timer tests performed in isolated databases.

## Where the backend runs

| Responsibility | Owner | What it does |
| --- | --- | --- |
| Configuration and worker authorization | SpacetimeDB reducers | Restrict configuration to the owner and bind each registered worker identity to its agent ID. |
| Run lifecycle and shared discovery | SpacetimeDB reducers and tables | Start, stop, and reset runs; deduplicate site URLs; retain feed sources and observed inspection results. |
| Submission rules | SpacetimeDB reducers | Enforce the owned origin, configured name and phone, active run, claimed job, and accepted receipt. Repeated submissions remain idempotent. |
| Delayed work and recovery | SpacetimeDB scheduled reducers | Release real peer jobs at their stored due time and make expired leases available again. |
| Read permissions and projections | SpacetimeDB views | Keep raw tables private; provide identity-checked backend views and a public numbers-only collector projection. |
| Call persistence | SpacetimeDB reducers | Validate current-run call records and retain completed evidence when an older provisional update arrives. |
| HTTP and process management | Node server | Serve the pages, enforce host/origin and access-code rules, relay form requests, and start or restart browser processes. |
| Web inspection and form interaction | Node workers and Playwright | Fetch public pages with address checks, inspect content, call the external text model, and fill and submit the owned bank form. |
| Provider verification and interpretation | Node or Cloudflare adapter | Verify webhook signatures, bind provider agents and conversations, reject stale calls, and match caller transcript turns to submitted names. |
| Phone calls and speech | Photon and ElevenLabs | Route inbound phone calls and run the fictional voice characters. |

The responsibility map explains the project's Spacetime track submission: persistent application state and the coordination rules run in the database. HTTP authentication, external I/O, browser execution, and provider services remain separate parts of the backend. The project does not claim that all backend code runs inside SpacetimeDB.

## A real submission and its scheduled peer

1. A worker inspects the configured forum and the linked bank form, then records a validated site and recipe through a reducer. Public internet findings are observation-only and cannot receive submission jobs.
2. The discovering worker claims its job, fills **Full name** and **Phone number** in Playwright, and clicks **Request callback**. The form makes an HTTP request to the Node bridge.
3. The bridge invokes `accept_submission`. The database checks the active run, owned site, agent details, and unexpired claimed lease before storing a receipt. The worker requires both page confirmation and the matching database receipt.
4. `publish_site` requires that accepted receipt. It creates the other agent's job with a database-chosen delay of 5–10 seconds.
5. With native scheduling, the peer job begins as `scheduled`. A one-shot row in the private `job_schedule` table invokes the database scheduler at the stored deadline and changes it to `pending`. A worker cannot claim a still-scheduled job merely because its own clock says the time has passed.
6. Claiming creates a lease-expiry timer. If the lease expires before completion, the scheduler releases the job back to `pending`. Receipt idempotency lets a restarted worker finish already accepted work without adding the number twice.

Each callback checks the run, job status, and expected deadline. Stale callbacks cannot reopen a completed job or revive work from a stopped or replaced run. The private `active_run` singleton identifies the current run. Database timers only change job eligibility; the browser worker still has to perform the actual form interaction.

## Database read boundaries

The integration makes the raw run, agent, site, job, submission, event, and call tables private. Saved owner and registered worker identities can read their corresponding `backend_demo_run`, `backend_agent`, `backend_site`, `backend_job`, `backend_submission`, `backend_demo_event`, and `backend_call` views. Anonymous identities receive no rows from these backend views. The private configuration table retains authorization data.

The public `collector_numbers` view returns deduplicated, callable-format phone numbers from accepted receipts. It contains no names, source mappings, provider IDs, or transcripts. The HTTP `/admin` page combines that projection with fixed fictional starter numbers. Starter numbers are scene-setting display data; they are never receipts, jobs, calls, or evidence of worker activity. Reset removes run receipts while leaving those fixed display entries in place.

The hosted browser keeps using the Node manager's access-code boundary for detailed state and call diagnostics. Database credentials remain on the trusted server, workers, and webhook adapter. The anonymous browser subscription to every raw table from the reviewed branch is not used.

## Branch credit and retained scope

The [`spacetime-optimized` branch](https://github.com/calebtwang/HackUTD/tree/spacetime-optimized) contributed the scheduled-reducer and native-view patterns. This integration applies those patterns to actual job deadlines, lease recovery, and restricted projections of the existing two-agent workflow.

Simulation generation, invented call counts or time-saved totals, marker-based live-call mirroring, and third-persona assumptions from that branch are not included. Current call evidence remains a possible association from a caller mentioning a submitted fictional name. A signed transcript authenticates the provider event; a name alone does not prove which website supplied the number or identify a scammer.

## Verification status

The following local integration checks passed on November 8, 2026:

- All 105 tests, application type checking and build, and database-module type checking passed.
- An actual old-schema-to-new-schema publication using `--delete-data=never` preserved an existing synthetic receipt and call. Existing worker identities could read the backend views after the upgrade.
- Anonymous raw-table SQL reads were denied; anonymous backend views returned no rows. The owner retained private SQL access, preserving the database access contract used by the Cloudflare call-event adapter.
- A delayed job became `pending` while every client was disconnected. A real 60-second lease also expired back to `pending` with every client disconnected. Stop removed schedule rows, and Reset cleared the collector projection.
- In a separate fresh database and isolated application, new worker identities registered and both workers submitted through the actual forum-to-bank browser flow. Their accepted receipts were 6,651 ms apart.
- The open number-list page updated from 12 fixed fictional entries to 14 entries after the two receipts, then returned to 12 after Reset. The starter fixtures remained separate from submission records.

The hosted migration also passed on November 8, 2026:

- Maincloud publication used `--delete-data=never`, adding the scheduler tables and views and changing raw-table access. The updated VM image started healthy, and the manager health endpoint returned HTTP 200.
- The active run, every existing site, both accepted receipts, and seven historical call records remained unchanged. Configured names, phone numbers, provider agent IDs, and tested-readiness flags were preserved.
- The hosted `/admin` list matched the 12 fixed fictional entries plus the accepted receipt numbers.
- Owner SQL access to the private run, agent, submission, and call tables worked. Anonymous SQL access to raw calls was denied, and the anonymous `backend_call` view returned no rows.
- The public manager, manager health endpoint, forum root, bank `/phishing` page, and call-adapter health endpoint all returned HTTP 200. The deployed store and worker file hashes matched the local source, and the application remained healthy.

The full two-worker browser flow, automatic Reset display update, and disconnected-client 60-second lease test were exercised in isolated databases. The active hosted run was not reset, and no fresh phone-call test was performed for this migration. No real scam calls, intercepted victims, or measured prevention outcomes are claimed.

## Submission requirements

The official [HackUTD Spacetime challenge](https://zeroday.hackutd.co/) requires a public GitHub repository and the majority of the backend to be built on Spacetime. The source repository is [calebtwang/HackUTD](https://github.com/calebtwang/HackUTD). Keep `.env`, `.local/`, database tokens, provider credentials, real phone numbers, and private transcripts out of that public repository.

The official [HackUTD ZeroDay Devpost requirements](https://hackutd-zeroday.devpost.com/) require a demo video with a maximum length of two minutes. Show the observed browser submission, database receipt, delayed peer job, and resulting number-list update. Describe phone calls as volunteer demonstrations and explain the remaining Node/provider responsibilities accurately.
