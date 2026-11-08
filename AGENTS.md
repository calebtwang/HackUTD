# Project brief

This is a HackUTD demonstration of agents discovering a fake phishing form from a fake forum, sharing its form instructions through SpacetimeDB, submitting their own phone numbers after randomized delays, and receiving calls through Photon and ElevenLabs.

## Interface requirements

- Do not invent a project name, slogan, catchphrase, mascot, or brand voice.
- The agent manager is a bare-bones operational interface: plain tables, status text, ordinary controls, and logs. No hero section, promotional copy, decorative cards, metric tiles, gradients, unnecessary icons, or animations.
- Labels must describe the data or action. Use sentence case and ordinary system fonts.
- The fake banking page deliberately resembles an old website: compact fixed-width layout, rectangular sections, gray navigation, plain form fields, and a red header inspired by older Java download pages. Keep it visibly labeled as a demo phishing site; use a fictional bank.
- The collection page at `/admin` contains only the submitted, callable-format phone numbers, one per line. No header, navigation, metadata, counts, or placeholder prose. Identity and source details belong in the agent manager.
- The fake forum is simple HTML with links to the owned example pages.
- Dashboard agent table: Name, Phone, Entry point only. Sites table: Site and Form instructions only. Blank entry points wait for shared sites. No navigation bar, status column, reference codes, summary counters, or Evidence page. Connections, receipts, and diagnostic logs belong at `/debug`.
- Primary pages: `/`, `/forum`, `/phishing`, `/admin`, `/debug`. Internal provider IDs remain stable; do not present them as scout/follower roles.
- Hosted judging uses `phoney.desmos.help` for the manager and `phish.popsicle.space` for the fictional banking form, forum, and number list. The manager is publicly viewable; an access code protects run controls and debugging. The demo hostname must not expose manager state, diagnostics, or control APIs.
- `bank.desmos.help` is an explicitly configured backup demo hostname for networks that cannot reach the primary. Apply the same fixture isolation and exact-origin policy to both hostnames.
- Preserve the existing crawler contract: `data-crawl-content`, Full name / Phone number labels, Request callback button, and the verified submission receipt.

## Demo integrity

- Keep discovery and phone readiness separate. Only mark a phone ready after an actual successful call test.
- Calls reach fictional people receiving unexpected calls. They ask who is calling, confirm their name when asked, and wait for the caller to introduce an offer. Never make the characters pitch a project or a bonus.
- Source matches must be supported by the caller's transcript. Do not turn an unverified match into a verified one for presentation.
- URLs read from a public feed appear immediately with source attribution. Keep a feed report separate from an actual page inspection; show pending or failed inspection honestly, and never invent form instructions for an unavailable page.
- The two workers run on one host, whether a laptop or a cloud server. Owned forms use browser submissions; public pages and URL feeds use bounded read-only discovery with public-address checks. Do not claim separate machines or IP addresses unless those are actually configured.
- During a hosting migration, stop the old workers before starting the hosted instance and preserve the existing SpacetimeDB worker identity files. Never run both installations against the same active run. Do not claim a deployment is live before verifying both public hostnames and the actual discovery/submission flow.
- Keep `.env`, `.local`, credentials, real phone numbers, and private transcripts out of Git. Do not republish screenshots containing live numbers.
- Existing provider identifiers may retain old internal names. Preserve working resource mappings and credentials when changing presentation; do not provision replacements just to rename them.
