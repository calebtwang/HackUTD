# Demo video script (2:00)

Spoken lines are in quotes. Use the reference that matches the line being called: Scout / Mara Bell is "Cedar Finch 47", Finch / Otis Vale is "Copper Meadow 62". Keep the "Simulated" label on screen for every call segment.

## 0:00–0:18 The problem

[Visual: a phone screen showing an incoming call to an older person.]

"Picture your grandmother getting a call. The voice says it is her bank, and it knows her name and where she lives. When it says there is a problem with her account, she believes it."

"According to Pew Research Center, 68 percent of Americans aged 65 and older say they receive suspected scam calls at least weekly. The callers get her details from leaked contact lists."

## 0:18–0:36 The idea

[Visual: the call ends. Her card slides into a row that fills with fictional personas.]

"Phoney fills those lists with fictional people instead. Each persona has a name, a backstory, and a phone number that rings an AI character. When a scammer calls, they spend their time on a character, not on someone's grandmother, and every call is recorded as evidence of how the number leaked."

## 0:36–1:02 Live: discover and submit

[Switch to the demo forum and the fictional bank callback form. "Demo phishing site" label visible.]

"Everything here runs on SpacetimeDB. An AI scout reads this owned demo forum, finds the callback form, and submits a fictional profile."

[Agent manager activity feed.]

"The database refuses to share the form until the scout's submission has a verified receipt. Once it does, Finch and Wren receive their jobs through live subscriptions, wait a randomized delay, and submit their own profiles. Who may claim a job, when it is due, and what counts as a receipt are all rules inside the database."

[Pause for the two follower submissions to appear.]

## 1:02–1:28 Live: the call

[Teammate dials a tested line. On-screen label: "Simulated impersonation call."]

"Submitting the form does not place a call. Our teammate is now calling the planted number, playing the scammer."

Teammate: "Hello, this is your bank's security department. I'm calling about reference Cedar Finch 47."

[Let the character answer live for about eight seconds.]

"That is an ElevenLabs character answering a Photon line."

## 1:28–1:46 Live: the evidence

[Evidence view in the agent manager.]

"The call becomes evidence. A live observation is only a possible match. A verified match requires the signed transcript to show the caller said the reference before our character did. The transcript arrives through a Cloudflare Worker, lands in SpacetimeDB, and the manager updates from the same tables the agents write to."

## 1:46–2:00 Close

[Return to the persona row, then the closing slide.]

"Today this is three personas and one form. The architecture is thousands of personas across every list a scammer can buy, so that the next time one of them dials a grandmother, the odds are it is one of ours."

"More time talking to AI. Less time pressuring someone's grandmother."

## Rehearsal notes

- Use the same reference in the planted form and in the teammate's line.
- Start the run before recording so the database and model show connected.
- If a live step stalls, cut to a clearly labeled prerecorded run. Do not describe a prerecorded clip as live.
- Do not show real phone numbers on screen.

## Changes for the spacetime-optimized branch

Replace the discover-and-submit segment's second paragraph and the evidence segment with the following. Timings stay the same.

0:36–1:02, after "submits a fictional profile":

"The database refuses to share the form until the scout's submission has a verified receipt. Once it does, Finch and Wren receive their jobs through live subscriptions and submit their own profiles. Behind them, a simulation running inside SpacetimeDB on its own scheduler is planting hundreds of fictional personas across dozens of leaky forms and generating thousands of simulated calls. Every rule here is a reducer: who may claim a job, when it is due, what counts as a receipt."

[Show the simulation table on the operator board: call counter climbing, sites ranked by traced leaks, "Simulated" label visible. Open a second browser window beside it so both update together.]

1:28–1:46, evidence:

"The call becomes evidence. A live observation is only a possible match. A verified match requires the signed transcript to show the caller said the reference before our character did. The transcript arrives through a Cloudflare Worker, lands in SpacetimeDB, and appears here, tagged live, in the same ledger as the simulated calls. The real form's leak count goes up by one."

[Point at the real form's row moving among the simulated sites.]
