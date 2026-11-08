import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { handleRequest, verifyElevenLabs, type Env } from '../cloud/worker';
import { EMPTY_STATE, PERSONAS, type Call, type DemoState } from '../shared/contracts';

// Cloudflare extends SubtleCrypto with this documented API; Node's test runtime does not.
Object.defineProperty(crypto.subtle,'timingSafeEqual',{value:(a:ArrayBuffer,b:ArrayBuffer)=>timingSafeEqual(new Uint8Array(a),new Uint8Array(b)),configurable:true});
const env: Env = {SPACETIMEDB_HOST:'https://database.example',SPACETIMEDB_DATABASE:'demo',SPACETIMEDB_TOKEN:'test-owner-secret',VOICE_TOOL_SECRET:'test-tool-secret',ELEVENLABS_WEBHOOK_SECRET:'test-hmac-secret'};
const now = Math.floor(Date.now()/1000);
function sign(raw: string, timestamp = String(now)): string { return `t=${timestamp},v0=${createHmac('sha256',env.ELEVENLABS_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex')}`; }
function fixture() {
  const state: DemoState = {...structuredClone(EMPTY_STATE),run:{id:'run-1',status:'complete',seedUrl:'http://127.0.0.1:3210/forum',startedAt:(now-10)*1000},agents:PERSONAS.map(p=>({...p,status:'ready',heartbeatAt:0,voiceAgentId:`provider_${p.id}`})),
    submissions:[{id:'receipt',runId:'run-1',siteId:'site-1',agentId:'scout',name:'Mara Bell',phone:'DEMO-SCOUT',marker:'Cedar Finch 47',receivedAt:1}]};
  const calls: Call[] = []; let reads = 0;
  const send = async (input:string|URL|Request,init?:RequestInit): Promise<Response> => {
    assert.equal(new Headers(init?.headers).get('Authorization'),`Bearer ${env.SPACETIMEDB_TOKEN}`);
    assert.equal(init?.redirect,'manual');
    if (String(input).endsWith('/sql')) {
      reads++;
      const query = String(init?.body); const table = /FROM (\w+)/.exec(query)?.[1];
      const map: Record<string,unknown[]> = {demo_run:[state.run],agent:state.agents,submission:state.submissions,call:state.calls};
      assert.ok(table && table in map); assert.ok(!query.includes(';'));
      return Response.json([{schema:{elements:[]},rows:map[table!].map(x=>[JSON.stringify(x)])}]);
    }
    assert.ok(String(input).endsWith('/call/dispatch?confirmed=true'));
    const args = JSON.parse(String(init?.body)); assert.equal(args[0],'call_event');
    calls.push(JSON.parse(args[1]).call);
    return new Response(null,{status:200});
  };
  return {state,calls,send,reads:()=>reads};
}
function request(path:string,body:string,headers:Record<string,string> = {}): Request {
  return new Request(`https://worker.example${path}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body});
}
function postEvent() { return {type:'post_call_transcription',data:{agent_id:'provider_scout',conversation_id:'conv_test',metadata:{start_time_unix_secs:now-2,call_duration_secs:12},analysis:{transcript_summary:'Demo completed'},transcript:[{role:'agent',message:'Hello?'},{role:'user',message:'Cedar Finch 47'}]}}; }

test('health is sanitized and unknown routes expose no controls or CORS',async()=>{
  const response=await handleRequest(new Request('https://worker.example/health'),env);
  assert.deepEqual(await response.json(),{service:'Honeyline call events',ready:true});
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
  assert.equal((await handleRequest(new Request('https://worker.example/api/state'),env)).status,404);
});
test('unauthorized tool calls are rejected before any database access',async()=>{
  const f=fixture();const response=await handleRequest(request('/webhooks/elevenlabs/observed','{}',{Authorization:'Bearer wrong'}),env,f.send);
  assert.equal(response.status,401);assert.equal(f.reads(),0);assert.equal(f.calls.length,0);
});
test('valid observed reference creates a provisional call using positional reducer arguments',async()=>{
  const f=fixture();const response=await handleRequest(request('/webhooks/elevenlabs/observed',JSON.stringify({conversation_id:'conv_test',agent_id:'provider_scout',observed_text:'Cedar Finch 47',observed_at:new Date(now*1000).toISOString(),call_duration_seconds:2}),{Authorization:`Bearer ${env.VOICE_TOOL_SECRET}`}),env,f.send);
  assert.equal(response.status,200);assert.equal(f.reads(),4);assert.equal(f.calls[0].matchStatus,'possible');assert.equal(f.calls[0].matchedSiteId,'site-1');
});
test('live observation from a call started before reset cannot attach to the new run',async()=>{
  const f=fixture();const response=await handleRequest(request('/webhooks/elevenlabs/observed',JSON.stringify({conversation_id:'conv_old',agent_id:'provider_scout',observed_text:'Cedar Finch 47',observed_at:new Date(now*1000).toISOString(),call_duration_seconds:100}),{Authorization:`Bearer ${env.VOICE_TOOL_SECRET}`}),env,f.send);
  assert.equal(response.status,200);assert.equal(f.calls.length,0);
});
test('live observations with missing platform time do not reach the database',async()=>{
  const f=fixture();const response=await handleRequest(request('/webhooks/elevenlabs/observed',JSON.stringify({conversation_id:'conv_test',agent_id:'provider_scout',observed_text:'Cedar Finch 47'}),{Authorization:`Bearer ${env.VOICE_TOOL_SECRET}`}),env,f.send);
  assert.equal(response.status,400);assert.equal(f.reads(),0);
});
test('HMAC rejects changed raw bytes, stale, future, duplicate, and non-finite timestamps',async()=>{
  const raw='{"message":"café"}';const bytes=new TextEncoder().encode(raw);
  assert.equal(await verifyElevenLabs(bytes,sign(raw),env.ELEVENLABS_WEBHOOK_SECRET),true);
  assert.equal(await verifyElevenLabs(new TextEncoder().encode(`${raw} `),sign(raw),env.ELEVENLABS_WEBHOOK_SECRET),false);
  for(const timestamp of [String(now-1801),String(now+1801),'NaN','Infinity']) assert.equal(await verifyElevenLabs(bytes,sign(raw,timestamp),env.ELEVENLABS_WEBHOOK_SECRET,now*1000),false);
  assert.equal(await verifyElevenLabs(bytes,`${sign(raw)},t=${now}`,env.ELEVENLABS_WEBHOOK_SECRET),false);
});
test('verified final webhook matches only caller-first evidence and preserves schema limits',async()=>{
  const f=fixture();const raw=JSON.stringify(postEvent());
  const response=await handleRequest(request('/webhooks/elevenlabs/post-call',raw,{'ElevenLabs-Signature':sign(raw)}),env,f.send);
  assert.equal(response.status,200);assert.equal(f.calls[0].status,'completed');assert.equal(f.calls[0].matchStatus,'verified');
  const bad=postEvent();bad.data.transcript=[{role:'agent',message:'Cedar Finch 47'},{role:'user',message:'Cedar Finch 47'}];const other=JSON.stringify(bad);
  await handleRequest(request('/webhooks/elevenlabs/post-call',other,{'ElevenLabs-Signature':sign(other)}),env,f.send);
  assert.equal(f.calls[1].matchStatus,'none');
});
test('late signed call before current run is acknowledged without changing database state',async()=>{
  const f=fixture();const event=postEvent();event.data.metadata.start_time_unix_secs=now-100;const raw=JSON.stringify(event);
  const response=await handleRequest(request('/webhooks/elevenlabs/post-call',raw,{'ElevenLabs-Signature':sign(raw)}),env,f.send);
  assert.equal(response.status,200);assert.equal(f.calls.length,0);
});
test('body limits are enforced without relying on Content-Length',async()=>{
  const f=fixture();const raw=JSON.stringify({pad:'x'.repeat(9000)});
  const response=await handleRequest(request('/webhooks/elevenlabs/observed',raw,{Authorization:`Bearer ${env.VOICE_TOOL_SECRET}`}),env,f.send);
  assert.equal(response.status,413);assert.equal(f.reads(),0);
});
test('database failures are retryable and cannot expose upstream secrets',async()=>{
  const raw=JSON.stringify(postEvent());
  const response=await handleRequest(request('/webhooks/elevenlabs/post-call',raw,{'ElevenLabs-Signature':sign(raw)}),env,async()=>new Response(`secret ${env.SPACETIMEDB_TOKEN}`,{status:401}));
  assert.equal(response.status,503);assert.ok(!(await response.text()).includes(env.SPACETIMEDB_TOKEN));
});
