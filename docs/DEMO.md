# Judge walkthrough

Mara and Otis are equal agents with separate browser processes and database identities. Either can discover sites; an agent with a blank entry point waits for shared findings. The two processes share one host.

On a hosted installation, open the manager domain and enter the access code to unlock controls. The manager's tables remain publicly viewable, while `/debug` requires the code. Open the fixture domain for the banking form; `/forum` and `/admin` are on that same fixture domain. Local development uses the paths below without an access code.

The deployed manager is `https://phoney.desmos.help`. Use `https://bank.desmos.help/forum` as the entry point on the hackathon network; leave the other agent's entry blank. The bank is at `https://bank.desmos.help/` and collected numbers at `https://bank.desmos.help/admin`. The originally requested `https://phish.popsicle.space` remains configured, but the current network resets connections to that hostname. Both fixture hostnames use the same server and database.

1. Open `/`, `/forum`, `/phishing`, and `/admin`. Check connections on `/debug`. Finish earlier calls before resetting or starting a new run.
2. Show the forum and the fictional banking form. It asks for **Full name** and **Phone number** only.
3. Leave Mara's entry point at the owned forum and Otis's blank, then click **Start**. The local default is `http://localhost:3210/forum`; a hosted installation defaults to its fixture domain's `/forum`. Either agent can instead receive its own entry point. Discovery continues until **Stop**, with the entry points checked again every 60 seconds.
4. Watch the Sites table grow with discovered URLs and form instructions. On the owned form, the discovering agent submits its actual configured details through the browser. SpacetimeDB shares the verified instructions and schedules the other agent after a randomized delay. `/admin` contains only received, callable-format phone numbers, one per line; detailed receipts are on `/debug`.
5. To demonstrate public discovery, stop the current run and enter a public HTTP(S) page or plain-text URL feed for either agent. Feed entries appear immediately as source-attributed listings; inspection results update each row, including unavailable pages or pages not flagged on inspection. External sites show **Read only** and receive no submissions. Observed field labels are not complete form instructions. A feed listing or model assessment does not establish confirmed fraud.
6. Ask a consenting volunteer to call one of the tested numbers. Tell them the conversation is transcribed. The character should say “Hello?”, ask who is calling, and confirm its fictional name when asked. The volunteer introduces a pretend offer and can ask for the submitted name.
7. Hang up and open `/debug`. Call observations and post-call transcripts may show a **possible association** with the submitted name. A name alone is not verified attribution or proof of a site's involvement. Wait for the post-call update before resetting.
8. Click **Stop** when finished. **Reset** clears the run's records; it does not release phone numbers or cancel provider billing.

For a database-only walkthrough, choose **Run rehearsal** on `/debug` with owned entry points. Detection then uses fixed rules; browser submissions and database coordination remain real. Stop rehearsal manually when finished.

The volunteer can stop at any time. Each call has a four-minute maximum. If a line fails, use the other tested line and describe the failure accurately. SpacetimeDB coordinates the agents, Photon supplies the phone channel, and ElevenLabs runs the characters. Outbound calling, SMS continuation, separate worker IP addresses, and measured scam prevention are not part of this demo.

An installed, running VM keeps the manager and agents available after the laptop closes. A local terminal or a tunnel from the laptop does not. Follow the [hosting guide](HOSTING.md) for the cutover, and stop the old local run before starting workers on the VM.
