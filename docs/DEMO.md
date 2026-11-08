# Judge walkthrough

The setup has three browser workers and two tested phone lines. Scout and Finch can answer calls; Wren is browser-only. All sites in the walkthrough are owned demo pages.

1. Open the dashboard, `/forum`, and `/admin`. Check that the database and model are connected. End any earlier calls before starting a new run.
2. Show the forum links and the demo form. The form asks for **Full name**, **Phone number**, and **Reference**.
3. Click **Start model demo**. Watch the scout inspect the forum and form, then submit its profile through the browser. If using **Run rehearsal**, explain that detection uses fixed rules; the browser actions and database are still real.
4. Watch the accepted submissions appear. SpacetimeDB shares the verified form instructions and schedules the two followers after short, randomized delays. The dashboard or evidence page shows all three worker receipts. `/admin` lists only actual phone numbers, so it shows Scout and Finch and omits Wren's `DEMO-WREN` placeholder.
5. Ask a volunteer to call one of the two tested numbers. Tell them the conversation is transcribed for the demo. Use the matching synthetic name and reference from the dashboard or evidence page. The agent should say “Hello?”, ask who is calling, and confirm its name only when asked. The volunteer then introduces the pretend offer and independently mentions the reference.
6. Hang up and open the evidence page. A live observation is only a possible connection. After the signed post-call transcript arrives, show a verified match only if the caller actually said the matching reference. Wait for delivery before resetting or starting another run.

| Character | Synthetic reference |
| --- | --- |
| Scout / Mara Bell | Cedar Finch 47 |
| Finch / Otis Vale | Copper Meadow 62 |

The volunteer can stop at any time. Each call has a four-minute maximum. If a line fails, use the other tested line and describe the failure accurately. If evidence is delayed or unmatched, do not claim a verified result.

SpacetimeDB provides shared state and job coordination. Photon supplies the phone channel; ElevenLabs runs the characters. This is a controlled demonstration, not evidence of prevented scams, separate worker IP addresses, or a T-Mobile carrier integration. Outbound calling and SMS continuation are not implemented.
