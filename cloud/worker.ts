import type { Env } from './worker-env';
import type { Agent, Call, DemoRun, DemoState, Submission } from '../shared/contracts';
import { buildCall, callRunStatus, findAgent, observedCallStart, parseTranscript, possibleMatch, verifiedMatch } from '../server/calls';

export type { Env } from './worker-env';
const encoder = new TextEncoder();
const OBSERVED_PATH = '/webhooks/elevenlabs/observed';
const POST_CALL_PATH = '/webhooks/elevenlabs/post-call';
const SQL_TABLES = ['demo_run', 'agent', 'submission', 'call'] as const;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400,'Invalid JSON object.');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(value)) throw new HttpError(400,'Invalid provider identifier.');
  return value;
}
export async function limitedBody(message: Request | Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = Number(message.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > maxBytes) throw new HttpError(413,'Payload is too large.');
  if (!message.body) return new Uint8Array(0);
  const reader = message.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new HttpError(413,'Payload is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  return bytes;
}
function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { throw new HttpError(400,'Invalid JSON body.'); }
}
export async function secureTokenEqual(provided: string, expected: string): Promise<boolean> {
  const [left,right] = await Promise.all([crypto.subtle.digest('SHA-256',encoder.encode(provided)),crypto.subtle.digest('SHA-256',encoder.encode(expected))]);
  // Cloudflare's documented fixed-buffer comparison; no secret-dependent early return.
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer,b: ArrayBuffer): boolean };
  return subtle.timingSafeEqual(left,right);
}
export async function verifyElevenLabs(raw: Uint8Array<ArrayBuffer>, header: string, secret: string, now = Date.now()): Promise<boolean> {
  const fields = header.split(',').map(x => x.trim());
  const timestamps = fields.filter(x => x.startsWith('t=')).map(x => x.slice(2));
  const signatures = fields.filter(x => /^v0=[a-fA-F0-9]{64}$/.test(x)).map(x => x.slice(3));
  if (timestamps.length !== 1 || !/^\d{1,12}$/.test(timestamps[0]) || !signatures.length || signatures.length > 4) return false;
  const timestamp = Number(timestamps[0]);
  if (!Number.isSafeInteger(timestamp) || !Number.isFinite(now) || Math.abs(now - timestamp*1000) > 30*60*1000) return false;
  const prefix = encoder.encode(`${timestamps[0]}.`); const signed = new Uint8Array(prefix.length+raw.length);
  signed.set(prefix); signed.set(raw,prefix.length);
  const key = await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const results = await Promise.all(signatures.map(signature => crypto.subtle.verify('HMAC',key,
    Uint8Array.from(signature.match(/../g)!,byte => parseInt(byte,16)),signed)));
  return results.some(Boolean);
}
function databaseBase(env: Env): string {
  let host: URL;
  try { host = new URL(env.SPACETIMEDB_HOST); } catch { throw new HttpError(503,'Database adapter is not configured.'); }
  if (host.protocol !== 'https:' || host.username || host.password || host.search || host.hash || !/^[a-zA-Z0-9_-]{1,150}$/.test(env.SPACETIMEDB_DATABASE)) throw new HttpError(503,'Database adapter is not configured.');
  return `${host.origin}/v1/database/${encodeURIComponent(env.SPACETIMEDB_DATABASE)}`;
}
async function sqlRows<T>(env: Env, table: typeof SQL_TABLES[number], callId: string, send: Fetch): Promise<T[]> {
  const query = `SELECT data FROM ${table}${table==='call' ? ` WHERE id = '${callId}'` : ''}`;
  const response = await send(`${databaseBase(env)}/sql`,{method:'POST',headers:{'Content-Type':'text/plain','Authorization':`Bearer ${env.SPACETIMEDB_TOKEN}`},body:query,redirect:'manual',signal:AbortSignal.timeout(10_000)});
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(503,'Database read is temporarily unavailable.'); }
  const result = parseJson(await limitedBody(response,512*1024));
  if (!Array.isArray(result) || result.length !== 1) throw new HttpError(503,'Unexpected database response.');
  const rows = record(result[0]).rows;
  if (!Array.isArray(rows) || rows.length > 500) throw new HttpError(503,'Unexpected database response.');
  return rows.map(row => {
    if (!Array.isArray(row) || row.length !== 1 || typeof row[0] !== 'string') throw new HttpError(503,'Unexpected database row.');
    return JSON.parse(row[0]) as T;
  });
}
export async function readState(env: Env, callId: string, send: Fetch = fetch): Promise<DemoState> {
  identifier(callId);
  const [runs,agents,submissions,calls] = await Promise.all([
    sqlRows<DemoRun>(env,'demo_run',callId,send), sqlRows<Agent>(env,'agent',callId,send),
    sqlRows<Submission>(env,'submission',callId,send), sqlRows<Call>(env,'call',callId,send),
  ]);
  return {run:runs[0] ?? null,agents,submissions,calls,sites:[],jobs:[],events:[]};
}
async function saveCall(env: Env, call: Call, send: Fetch): Promise<void> {
  const payload = JSON.stringify({call});
  if (payload.length > 150_000) throw new HttpError(413,'Call transcript exceeds the storage limit.');
  const response = await send(`${databaseBase(env)}/call/dispatch?confirmed=true`,{
    method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${env.SPACETIMEDB_TOKEN}`},
    body:JSON.stringify(['call_event',payload]),redirect:'manual',signal:AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new HttpError(503,'Call could not be saved; retry this delivery.');
}
function configured(env: Env): boolean {
  return Boolean(env.SPACETIMEDB_HOST && env.SPACETIMEDB_DATABASE && env.SPACETIMEDB_TOKEN && env.VOICE_TOOL_SECRET && env.ELEVENLABS_WEBHOOK_SECRET);
}
export async function handleRequest(request: Request, env: Env, send: Fetch = fetch): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (request.method === 'GET' && path === '/health') return json({service:'Honeyline call events',ready:configured(env)});
    if (![OBSERVED_PATH,POST_CALL_PATH].includes(path)) return json({error:'Not found.'},404);
    if (request.method !== 'POST') return json({error:'Method not allowed.'},405);
    if (!configured(env)) throw new HttpError(503,'Call event adapter is not configured.');
    if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) throw new HttpError(415,'Use application/json.');
    if (path === OBSERVED_PATH) {
      const token = (request.headers.get('Authorization') || '').replace(/^Bearer /,'');
      if (!await secureTokenEqual(token,env.VOICE_TOOL_SECRET)) throw new HttpError(401,'Unauthorized.');
      const body = record(parseJson(await limitedBody(request,8*1024)));
      const callId = identifier(body.conversation_id); const agentId = identifier(body.agent_id);
      if (typeof body.observed_text !== 'string' || body.observed_text.length > 1000) throw new HttpError(400,'Invalid observation.');
      const startedAt=observedCallStart(body.observed_at,body.call_duration_seconds);
      if (startedAt===undefined) throw new HttpError(400,'Valid platform observation time and call duration are required.');
      const state = await readState(env,callId,send); const agent = findAgent(state,agentId);
      if (!agent || !state.run) throw new HttpError(409,'No active demo profile.');
      if (callRunStatus(state,callId,startedAt)==='old') return json({received:true,ignored:'Call predates the current demo run.'});
      const call = buildCall(state,agent,callId);
      if (call.status === 'completed') return json({received:true});
      if (!state.calls.some(item=>item.id===callId)) call.startedAt=startedAt*1000;
      call.durationSeconds=Math.max(call.durationSeconds,Number(body.call_duration_seconds));
      const match = possibleMatch(body.observed_text,state.submissions.filter(row => row.runId === call.runId && row.agentId === agent.id));
      if (match) { call.matchStatus='possible'; call.matchedSiteId=match.siteId; call.evidence=body.observed_text; }
      await saveCall(env,call,send);
      return json({received:true,possible_match:Boolean(match),instruction:'Continue the conversation naturally. Do not disclose internal matching or reference markers.'});
    }
    const raw = await limitedBody(request,2*1024*1024);
    if (!await verifyElevenLabs(raw,request.headers.get('ElevenLabs-Signature') || '',env.ELEVENLABS_WEBHOOK_SECRET)) throw new HttpError(401,'Invalid webhook signature.');
    const event = record(parseJson(raw));
    if (event.type !== 'post_call_transcription') return json({received:true});
    const data = record(event.data); const metadata = data.metadata ? record(data.metadata) : {};
    const analysis = data.analysis ? record(data.analysis) : {};
    const callId = identifier(data.conversation_id); const agentId = identifier(data.agent_id);
    const state = await readState(env,callId,send); const agent = findAgent(state,agentId);
    if (!agent) throw new HttpError(400,'Unknown demo agent.');
    const runStatus = callRunStatus(state,callId,metadata.start_time_unix_secs);
    if (runStatus === 'old') return json({received:true,ignored:'Call predates the current demo run.'});
    if (runStatus === 'unknown') throw new HttpError(409,'A current run and call start timestamp are required.');
    const call = buildCall(state,agent,callId);
    call.transcript = parseTranscript(data.transcript); call.status = 'completed';
    const duration = Number(metadata.call_duration_secs); call.durationSeconds=Number.isFinite(duration) ? Math.max(0,duration) : 0;
    const started = Number(metadata.start_time_unix_secs); if (Number.isFinite(started) && started > 0) call.startedAt = started*1000;
    call.summary=typeof analysis.transcript_summary === 'string' ? analysis.transcript_summary.slice(0,4000) : '';
    const match=verifiedMatch(call.transcript,state.submissions.filter(row => row.runId===call.runId && row.agentId===agent.id));
    call.matchStatus=match?'verified':'none'; call.matchedSiteId=match?.submission.siteId || ''; call.evidence=match?.evidence || '';
    await saveCall(env,call,send);
    return json({received:true});
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 503;
    if (status >= 500) console.error(JSON.stringify({event:'webhook_adapter_error',path,status}));
    return json({error:error instanceof HttpError ? error.message : 'Call event adapter is temporarily unavailable.'},status);
  }
}
export default { fetch(request: Request, env: Env): Promise<Response> { return handleRequest(request,env); } };
