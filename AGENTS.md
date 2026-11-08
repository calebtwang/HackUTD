# Project brief

This is a HackUTD demonstration of agents discovering a fake phishing form from a fake forum, sharing its form instructions through SpacetimeDB, submitting their own phone numbers after randomized delays, and receiving calls through Photon and ElevenLabs.

## Interface requirements

- Do not invent a project name, slogan, catchphrase, mascot, or brand voice.
- The agent manager is a bare-bones operational interface: plain tables, status text, ordinary controls, and logs. No hero section, promotional copy, decorative cards, metric tiles, gradients, unnecessary icons, or animations.
- Labels must describe the data or action. Use sentence case and ordinary system fonts.
- The fake banking page deliberately resembles an old website: compact fixed-width layout, rectangular sections, gray navigation, plain form fields, and a red header inspired by older Java download pages. Keep it visibly labeled as a demo phishing site; use a fictional bank.
- The collection page at `/admin` contains only the submitted, callable-format phone numbers, one per line. No header, navigation, metadata, counts, or placeholder prose. Identity and source details belong in the agent manager and evidence view.
- The fake forum is simple HTML with links to the owned example pages.
- Preserve the existing crawler contract: `data-crawl-content`, Full name / Phone number / Reference labels, Request callback button, and the verified submission receipt.

## Demo integrity

- Keep discovery and phone readiness separate. Only mark a phone ready after an actual successful call test.
- Calls reach fictional people receiving unexpected calls. They ask who is calling, confirm their name when asked, and wait for the caller to introduce an offer. Never make the characters pitch a project or a bonus.
- Source matches must be supported by the caller's transcript. Do not turn an unverified match into a verified one for presentation.
- This demo uses owned pages and three browser processes on one computer. Do not claim separate machines or IP addresses unless those are actually configured.
- Keep `.env`, `.local`, credentials, real phone numbers, and private transcripts out of Git. Do not republish screenshots containing live numbers.
- Existing provider identifiers may retain old internal names. Preserve working resource mappings and credentials when changing presentation; do not provision replacements just to rename them.
