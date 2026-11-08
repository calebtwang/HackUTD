# Devpost submission text

Paste each section into the matching Devpost field. Sponsor tracks: SpacetimeDB (primary), Photon, and one more at most. The SpacetimeDB prize requires the public GitHub repo link.

## Title

Phoney

## Tagline (under 100 characters)

Fictional personas are planted in scam lead forms; a SpacetimeDB ledger records which form leaked each number.

## Inspiration

Scam callers buy contact lists and work them by volume. The people who get hurt are the ones who pick up. We asked what happens if a meaningful share of every list is made of people who do not exist, each one backed by an AI voice that answers, keeps the caller talking, and records exactly which form leaked the number.

## What it does

Phoney plants fictional identities into scam lead forms and traces the calls that come back.

- An AI scout browses an owned demo forum, finds a callback form, and submits a fictional profile with a unique reference word.
- Two follower agents receive the verified form instructions through SpacetimeDB subscriptions and submit their own profiles after randomized delays.
- When a caller dials a planted number, an ElevenLabs character answers through a Photon phone line. The signed post-call transcript is matched against the planted reference to prove which form leaked the number.
- A simulation that runs inside the database models the same loop at scale: hundreds of personas, dozens of leaky forms, several scam operations, and thousands of calls, so the board is alive without anyone on the phone. Real calls land in the same tables tagged live. Simulated rows are tagged simulated everywhere they appear.

## How we built it

SpacetimeDB is the whole backend. There is no API server for the shared state. Every participant is a database client:

- Three browser worker processes (Playwright) with their own database identities.
- A local operator console that connects to the database directly from the browser.
- A Node bridge that holds the owner identity and relays form submissions and call events.
- A Cloudflare Worker that receives signed ElevenLabs post-call webhooks on the public internet and writes them to the same database.
- The database's own scheduler, which drives the simulation with a scheduled reducer.

Every rule is a reducer, so no client can skip it:

1. Only the publishing identity may configure personas or start a run.
2. A worker must prove a shared secret once; after that its identity is bound to its agent slot and cannot be reused by another connection.
3. Only the scout may discover a site, and only on the owned demo origin.
4. The form instructions are not shared with followers until the scout's submission has a verified receipt from the form itself.
5. Follower jobs carry a due time chosen inside the database; a claim before that time is refused.
6. Jobs are leased. A second worker cannot claim a job while the lease is live.
7. A job completes only with a receipt that matches the worker's configured identity.
8. Call evidence can only move upward: a live observation is provisional, a signed transcript is verified, and a late provisional write can never downgrade a verified match.
9. The simulation tick can only be invoked by the database's own scheduler identity.
10. Public views expose numbers to the collector page and identities to the operator board, never both to the same reader.

Voice: Photon SIP trunk into ElevenLabs conversational agents. Discovery: an OpenAI-compatible text model reads page text and form labels; rehearsal mode uses fixed rules instead. Frontend: React and Vite.

## Challenges we ran into

Keeping the demo honest. Provisional and verified evidence come from two different webhooks that can arrive out of order, and the rule that resolves them had to live in one transaction. Getting inbound SIP into ElevenLabs through Photon took most of the first night. Making the simulation deterministic from a seed inside the database so the same campaign replays identically.

## Accomplishments that we're proud of

Three independent agents coordinating entirely through database rules, with no coordinator process. A real phone call that lands in the same ledger as thousands of simulated ones and is proven back to the form that leaked it. Zero server code for shared state.

## What we learned

A database that enforces the rules changes how you write agents. The agents got simpler every time we moved a check into a reducer, because a refused transaction is a clearer signal than a prompt instruction.

## What's next for Phoney

Persona pool and site frontier with claims, so any number of workers can join. Phone lines as scarce seats allocated by the database to the personas that have leaked the most. A carrier integration that scores a real customer's incoming call against the rings the honeypots have observed.

## Built with

SpacetimeDB, TypeScript, Node, React, Vite, Playwright, Photon, ElevenLabs, Cloudflare Workers.

## Demo video and repo

Video: paste the public link. Repo: https://github.com/calebtwang/HackUTD (branch `spacetime-optimized` if merged late, otherwise `main`).

## Judge Q&A notes

- "Why SpacetimeDB and not Postgres plus websockets?" The lease, the receipt gate, the evidence merge, and the simulation tick are each one transaction that every client sees the instant it commits. The simulation runs inside the database on its own scheduler. We wrote no server code for shared state.
- "Is the simulation real traffic?" No. It is labeled simulated on every row and every screen. Real calls are tagged live and sit in the same tables.
- "Separate machines?" No. Three browser processes on one laptop with separate database identities. We say so on the board.
- "How does a number get onto a scam list?" In the demo, our scout submits it to our own form. In production, over weeks through lead-gen forms and data-broker lists.
