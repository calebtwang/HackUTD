# Margaret · inbound voice agent

A dedicated Photon 2.0 Voice number routes one call per LiveKit Cloud room. The Python worker uses Deepgram streaming STT, an account-selected NVIDIA Nemotron Chat Completions endpoint, and Cartesia streaming TTS with an account-authorized stock voice. Margaret's profile and the supplied prompt live in `personas/`.

## Local setup

Use CPython 3.12. Run from this directory.

```sh
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python -m pip check
python -m unittest discover -s tests -v
umask 077
cp .env.example .env
```

Fill the following values in the private `.env` file.

| Values | Where they come from |
| --- | --- |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | The LiveKit Cloud project that owns the inbound trunk. The worker URL starts with `wss://`. The project credentials must permit worker registration and room deletion. |
| `LIVEKIT_SIP_TRUNK_ID` | The inbound trunk ID returned by LiveKit. The worker checks it against the SIP participant before greeting. |
| `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, `NVIDIA_MODEL` | An accessible Nemotron model's exact ID, key, and HTTPS OpenAI-compatible API root, typically ending in `/v1`. The adapter appends `/chat/completions`. Verify streaming, usage chunks, and a 160-token output budget against that endpoint. Enable `NVIDIA_DISABLE_THINKING` if that model supports the NVIDIA template flag. Select a serving configuration that returns spoken content separately from reasoning. |
| `STT_API_KEY`, `STT_MODEL` | Your Deepgram key and an English streaming model available to that key. |
| `TTS_API_KEY`, `TTS_MODEL`, `TTS_VOICE_ID` | Your Cartesia key, streaming model, and licensed stock voice ID. Choose a model and voice combination that returns word timestamps. |

Provider documentation describes capabilities. Availability, exact model and voice IDs, licenses, and retention terms depend on the selected accounts. [Deepgram STT](https://docs.livekit.io/agents/models/stt/deepgram/) · [Cartesia TTS](https://docs.livekit.io/agents/models/tts/cartesia/) · [NVIDIA NIM setup](https://build.nvidia.com/playbooks/nim-llm/instructions) · [LiveKit-compatible LLMs](https://docs.livekit.io/agents/models/llm/openai-compatible-llms/)

## Photon and LiveKit setup

1. In Photon 2.0/Beta, confirm Voice eligibility and assign or select a Voice profile for the dedicated number. Shared iMessage assignments are ineligible. Use a separate test phone and keep personal calls outside this route. [Photon–LiveKit cookbook](https://photon.codes/docs/beta/cookbooks/voice/livekit)
2. Install the [LiveKit CLI](https://docs.livekit.io/reference/developer-tools/livekit-cli/) and authenticate to the intended Cloud project. Use the LiveKit dashboard or the commands below. The trunk contains only the dedicated E.164 number and a new SIP username and strong password that you choose. Set the trunk maximum to the same value as `MAX_CALL_SECONDS` and pair the supplied required SRTP setting with Photon's **Require encrypted calls** setting. The SIP-side maximum is a backstop if the worker is killed or loses the Room API connection. [Inbound trunks](https://docs.livekit.io/telephony/accepting-calls/inbound-trunk/) · [SIP API](https://docs.livekit.io/reference/telephony/sip-api/)

   ```sh
   lk cloud auth
   lk project list
   umask 077
   cp config/inbound-trunk.example.json config/inbound-trunk.json
   # Fill the number and both SIP credentials in config/inbound-trunk.json.
   lk sip inbound create config/inbound-trunk.json
   ```

3. Copy the returned trunk ID to `.env` and to the dispatch config. Create one **Individual** dispatch rule scoped to that trunk, targeting the exact `AGENT_NAME` in `.env`. The example hides the phone number from the SIP participant identity and attributes. [Dispatch rules](https://docs.livekit.io/telephony/accepting-calls/dispatch-rule/) · [CLI request formats](https://docs.livekit.io/reference/developer-tools/livekit-cli/telephony/)

   ```sh
   cp config/dispatch.example.json config/dispatch.json
   # Replace the trunk ID and, if customized, the dispatch agent name.
   lk sip dispatch create config/dispatch.json
   ```

4. Start one worker using the commands below. In the Photon Voice profile, configure **Inbound calls** with the actual LiveKit project SIP URI as a `sips:` destination, **TLS** transport, and the same SIP username and password as the trunk. Enable required media encryption in Photon for the supplied trunk config. Enable inbound once the worker is registered. Leave outbound unconfigured. [Photon–LiveKit cookbook](https://photon.codes/docs/beta/cookbooks/voice/livekit)
5. With the teammate's consent, dial the dedicated number from a separate phone. Verify they hear Margaret's greeting once and Margaret responds to something they said. Follow the [acceptance checklist](TEST_RESULTS.md).

## Run and deploy

For the first inbound test with a local worker and the real Cloud project:

```sh
. .venv/bin/activate
python agent.py dev
```

For deployment, use **one Docker host and one worker container**, with LiveKit Cloud providing SIP and room infrastructure. Keep the named volume across updates. The SQLite ledger and stop file coordinate jobs on that host. Stop the local dev worker before starting the deployed worker.

```sh
docker build -t margaret-inbound:1 .
docker volume create margaret-state
docker run -d --name margaret-inbound --restart unless-stopped \
  --stop-timeout 40 --env-file .env --env STATE_DIR=/var/lib/margaret \
  --mount source=margaret-state,target=/var/lib/margaret \
  margaret-inbound:1
docker logs -f margaret-inbound
```

Use plain `KEY=value` entries in Docker's env file. The Docker image contains neither credentials nor populated trunk files. The worker has no public application port requirement. [LiveKit self-hosted worker deployment](https://docs.livekit.io/deploy/custom/deployments/) · [Worker startup modes](https://docs.livekit.io/agents/server/startup-modes/)

## Operating controls

- Defaults are one active call, up to ten minutes per call, and 60 cumulative admitted call minutes for the lifetime of the SQLite ledger. Admission reserves the full per-call allowance up front. Confirmed teardown reconciles to rounded elapsed time. A crash or unconfirmed teardown retains the full charge and temporarily retains the concurrency slot. A call refused for capacity, budget, or operator stop is disconnected without a greeting. Keep the same state volume and use one worker deployment for this route.
- After 15 seconds of inactivity Margaret checks once. At 45 seconds the worker ends the call if silence continues. Caller speech starts a new silence window. The worker leaves a short farewell window inside the duration deadline and requests room deletion. LiveKit documents that room deletion disconnects SIP participants. [LiveKit inbound workflow and hangup](https://docs.livekit.io/telephony/accepting-calls/workflow-setup/)
- Toggle the operator stop with the following commands. The file rejects new calls and ends active calls at the next lifecycle check. Removing it allows new calls again.

  ```sh
  docker exec margaret-inbound touch /var/lib/margaret/STOP
  docker exec margaret-inbound rm /var/lib/margaret/STOP
  docker stop --time 40 margaret-inbound
  ```

  For the local default state directory, create or remove `state/STOP`. Use a normal stop to test shutdown and use the configured SIP limit to bound calls if the process dies abruptly.

- Transcript segments are queued per call and kept in a per-job `InMemoryTranscriptSink`. The summary log includes counts, failures, the termination reason, room deletion status, and measured response latency when available. It omits conversation text. LiveKit audio recording and transcript upload are disabled for the session. Verify project and provider data settings before a live test, tell participants about transcription, and use synthetic details. Persistent transcript storage requires an explicitly implemented and configured sink with disclosures and retention controls.
- Silero VAD, Deepgram final recognition, and LiveKit endpointing govern response timing. Streaming Cartesia word timing helps LiveKit keep the interrupted reply's played prefix in memory and transcripts. Caller claims remain unverified, and recent turns plus a bounded extractive summary supply recall. Explicit ending phrases use short fixed responses. Other conversational boundaries, relevance, and repetition depend on the selected Nemotron model and need the phone acceptance test. [LiveKit turn handling](https://docs.livekit.io/agents/logic/turns/)
