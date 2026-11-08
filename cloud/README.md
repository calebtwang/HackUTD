# Hosted call-event adapter

This small Cloudflare Worker accepts ElevenLabs call events and writes them into the existing SpacetimeDB module. The local dashboard receives database subscriptions normally. No inbound network tunnel to the demonstration laptop is needed.

Deployed endpoint: [honeyline-call-events.byteevangelist.workers.dev](https://honeyline-call-events.byteevangelist.workers.dev/health).

The Worker exposes only:

- `GET /health`: sanitized configuration readiness; no credentials or database records.
- `POST /webhooks/elevenlabs/observed`: bearer-authenticated provisional live observations.
- `POST /webhooks/elevenlabs/post-call`: HMAC-authenticated final transcript events.

There are no UI, admin, general proxy, arbitrary query, or CORS endpoints.

## Build and deployment inputs

From the project directory:

```sh
node --import tsx scripts/build-webhook.ts
```

The script generates binding types from `cloud/deployment.json` and bundles the portable Worker into `.local/cloud/worker.mjs`. The bundle has no Node runtime imports and does not contain credentials. Deployment is managed separately; the build command never uploads anything.

Use the compatibility date and observability settings in `cloud/deployment.json`. Its binding declarations intentionally contain no values. Supply these values during deployment:

| Binding | Kind | Value |
| --- | --- | --- |
| `SPACETIMEDB_HOST` | Plain text | `https://maincloud.spacetimedb.com` |
| `SPACETIMEDB_DATABASE` | Plain text | Your Honeyline database name |
| `SPACETIMEDB_TOKEN` | Secret | That database owner's authenticated token |
| `VOICE_TOOL_SECRET` | Secret | Same private tool credential used by the configured ElevenLabs tool |
| `ELEVENLABS_WEBHOOK_SECRET` | Secret | HMAC secret issued for the ElevenLabs post-call webhook |

Use the same HTTPS base URL when configuring the ElevenLabs observation tool and post-call webhook. Neither API keys nor tokens belong in source, Git, URL query strings, or public output. Keep database region placement unset until the actual Maincloud region is known; this adapter performs parallel reads followed by one reducer call.

## Observation contract

Authenticate with `Authorization: Bearer <VOICE_TOOL_SECRET>`. Send JSON:

```json
{
  "conversation_id": "platform-filled conversation ID",
  "agent_id": "platform-filled agent ID",
  "observed_text": "An exact short quote from the caller",
  "observed_at": "2026-11-08T12:00:00.000+00:00",
  "call_duration_seconds": 12
}
```

The tool binds `conversation_id` to `system__conversation_id`, `agent_id` to `system__agent_id`, `observed_at` to `system__time_utc`, and numeric `call_duration_seconds` to `system__call_duration_secs`. The model supplies only the observed caller quote. Time metadata is required and must be fresh. The adapter estimates the call start from time minus elapsed duration, then rejects calls predating the current demonstration run. This prevents a late tool event after Reset from creating a misleading call in the new run.

## Final-event contract

Send the original raw JSON with `ElevenLabs-Signature: t=<unix-seconds>,v0=<hex-HMAC-SHA256>`. The signed bytes are the timestamp, a period, and the unchanged raw request body. Verification occurs before parsing. The timestamp must be finite and within 30 minutes in either direction. Incoming bodies are capped while streaming: 8 KiB for observations, 2 MiB for final events. Provider transcripts are further capped to fit the database reducer limits.

Only caller-first marker mentions in the signed transcript can become verified attribution evidence. A name by itself is insufficient; the agent repeating its own marker cannot manufacture evidence. Final call writes are keyed by provider conversation ID; duplicate delivery updates the same database record. The module also prevents a concurrently delayed provisional observation from downgrading a completed call.

## SpacetimeDB HTTP interface

The adapter issues four parallel, fixed SQL queries using `POST /v1/database/<database>/sql`, `Content-Type: text/plain`, and the owner bearer credential. Each query selects the `data` JSON column from one known public table: `demo_run`, `agent`, `submission`, or the matching `call`. Returned JSON contains an array of statement results whose `rows` are positional arrays, e.g. `[["{...}"]]`.

Although the reference mentions semicolon-separated queries, the deployed Maincloud server rejected multiple statements during verification. The implementation intentionally sends separate queries. Calls are saved through:

```text
POST /v1/database/<database>/call/dispatch?confirmed=true
Authorization: Bearer <database-owner-token>
Content-Type: application/json

["call_event", "{\"call\":{...}}"]
```

The outer JSON is a positional reducer argument array; its second element is the serialized payload string. The database remains responsible for authorization, current-run checks, state transitions and idempotency. Failed upstream writes return a retryable response and never echo upstream bodies or secrets. Enable retries in the ElevenLabs webhook configuration.

## Verification

`tests/cloud-webhook.test.ts` covers authentication before database access, exact-byte HMAC checks, timestamp boundaries, streaming body limits, current/stale run attribution, positional reducer arguments, and sanitized upstream failures. It uses Node's Web APIs plus a test shim for Cloudflare's documented `crypto.subtle.timingSafeEqual` extension. Upstream requests use Workers-supported `redirect: 'manual'` and reject non-success responses; credentials are never automatically followed to a redirect destination.

Actual deployed checks passed on November 8, 2026:

| Check | Result |
| --- | --- |
| Health | 200; sanitized `ready: true` |
| Missing observation credential | 401 |
| Invalid final-event HMAC | 401 |
| Valid HMAC for an ignored event type | 200 |
| Valid signed synthetic conversation with unknown agent | 400 after successful database reads |
| Valid tool credential with no active demo profile | 409 after successful database reads |

These checks verified the deployed authentication and Maincloud read path. They left the current run, submissions, and calls unchanged. They did not create a synthetic call record or test a real phone call; end-to-end call-save verification is a separate step once voice agents and numbers are configured.

Primary references: [SpacetimeDB HTTP API](https://spacetimedb.com/docs/http/database/), [Cloudflare Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [ElevenLabs system dynamic variables](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables), [ElevenLabs post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks).
