import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCall, callRunStatus, parseTranscript } from '../server/calls';
import { EMPTY_STATE, PERSONAS, type DemoState } from '../shared/contracts';
import { transition, type PrivateState } from '../spacetimedb/src/logic';

function state(): DemoState {
  return { ...structuredClone(EMPTY_STATE), run: { id: 'current-run', status: 'complete', seedUrl: 'http://127.0.0.1:3210/forum', startedAt: 100_123 },
    agents: PERSONAS.map(p => ({ ...p, status: 'ready', heartbeatAt: 1 })) };
}

test('signed call adapter caps fit the database schema and reducer payload size', () => {
  const current = state();
  const call = buildCall(current, current.agents[0], 'provider-call');
  call.transcript = parseTranscript(Array.from({length:1000}, () => ({ role: 'user', message: '\u0000'.repeat(8000) })));
  call.status = 'completed';
  assert.ok(call.transcript.length <= 200);
  assert.ok(call.transcript.every(turn => turn.message.length <= 5000));
  assert.ok(JSON.stringify({call}).length < 150_000);
  const auth: PrivateState = { admin:'owner', workerSecret:'unused', workers:{} };
  transition(current,auth,{sender:'owner',now:150_000,random:()=>0,uuid:()=>''},'call_event',{call});
  assert.equal(current.calls.length,1);
  assert.equal(current.agents[0].status,'ready');
  const provisional = { ...call, status:'active', matchStatus:'none' as const, transcript:[] };
  transition(current,auth,{sender:'owner',now:160_000,random:()=>0,uuid:()=>''},'call_event',{call:provisional});
  assert.equal(current.calls[0].status,'completed');
  assert.equal(current.calls[0].transcript.length,call.transcript.length);
});

test('completed demo runs still accept current inbound call events', () => {
  const current = state();
  assert.equal(callRunStatus(current,'new-provider-call',101),'current');
  assert.equal(callRunStatus(current,'new-provider-call',100),'current');
});

test('late webhooks from an earlier run are ignored even if an ID was observed', () => {
  const current = state();
  current.calls.push(buildCall(current,current.agents[0],'old-provider-call'));
  assert.equal(callRunStatus(current,'old-provider-call',99),'old');
});

test('new calls without provider time cannot be silently assigned to the current run', () => {
  const current = state();
  assert.equal(callRunStatus(current,'unknown-call',undefined),'unknown');
  current.calls.push(buildCall(current,current.agents[0],'known-call'));
  assert.equal(callRunStatus(current,'known-call',undefined),'current');
  current.run = null;
  assert.equal(callRunStatus(current,'known-call',101),'unknown');
});
