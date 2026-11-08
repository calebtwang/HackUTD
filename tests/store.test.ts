import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_STATE, PERSONAS, type DemoState, type Site } from '../shared/contracts';
import { LEASE_MS, transition, type PrivateState } from '../spacetimedb/src/logic';

const secret = 'test-only-worker-secret-123456789';
function fixture() {
  let state: DemoState = structuredClone(EMPTY_STATE);
  let auth: PrivateState = { admin: 'owner', workerSecret: '', workers: {} };
  let now = 1_000; let sequence = 0;
  function dispatch(sender: string, action: string, input: unknown) {
    // Model SpacetimeDB rollback: never commit a partially failed transition.
    const next = structuredClone(state); const nextAuth = structuredClone(auth);
    transition(next, nextAuth, { sender, now, random: () => 0.5, uuid: () => `event-${++sequence}` }, action, input);
    state = next; auth = nextAuth;
  }
  const personas = PERSONAS.map((p, i) => ({ ...p, phone: `DEMO-00${i + 1}` }));
  dispatch('owner', 'configure', { personas, workerSecret: secret });
  for (const p of personas) dispatch(p.id, 'register_worker', { agentId: p.id, workerSecret: secret });
  dispatch('owner', 'start_run', { runId: 'run-1', seedUrl: 'http://127.0.0.1:3210/forum' });
  const site: Site = { id: 'site-1', runId: 'run-1', url: 'http://127.0.0.1:3210/prize', title: 'Demo Prize',
    evidence: ['Explicit mock form'], confidence: 'demo fixture', discoveredBy: 'scout', status: 'discovered', verifiedAt: 0, analysisMode: 'fixture',
    recipe: { url: 'http://127.0.0.1:3210/prize', fields: [{ label: 'Name', valueFrom: 'name' }, { label: 'Phone', valueFrom: 'phone' }, { label: 'Marker', valueFrom: 'marker' }], submitLabel: 'Submit', successText: 'Accepted' } };
  const discover = () => dispatch('scout', 'discover_site', { runId: 'run-1', agentId: 'scout', site });
  const claim = (id: string) => dispatch(id, 'claim_job', { runId: 'run-1', agentId: id, jobId: `run-1:site-1:${id}` });
  const accept = (id: string) => { const p = personas.find(p => p.id === id)!; dispatch('owner', 'accept_submission', { runId: 'run-1', siteId: 'site-1', agentId: id, name: p.name, phone: p.phone, marker: p.marker }); };
  const publish = () => dispatch('scout', 'publish_site', { runId: 'run-1', agentId: 'scout', siteId: 'site-1' });
  const complete = (id: string) => dispatch(id, 'complete_job', { runId: 'run-1', agentId: id, jobId: `run-1:site-1:${id}`, receiptId: `run-1:site-1:${id}` });
  return { dispatch, personas, discover, claim, accept, publish, complete, site, state: () => state, time: (n: number) => { now = n; } };
}

test('only publishing owner can configure, reset, and accept submissions', () => {
  const f = fixture();
  assert.throws(() => f.dispatch('visitor', 'configure', { personas: f.personas, workerSecret: secret }), /Admin/);
  assert.throws(() => f.dispatch('visitor', 'reset', {}), /Admin/);
  assert.throws(() => f.dispatch('visitor', 'register_worker', { agentId: 'scout', workerSecret: secret }), /another identity/);
  assert.throws(() => f.dispatch('visitor', 'register_worker', { agentId: 'finch', workerSecret: 'bad' }), /credential/);
});

test('reconfiguring an unchanged running demo does not reset its state', () => {
  const f = fixture(); f.discover();
  const before = f.state();
  f.dispatch('owner', 'configure', { personas: f.personas, workerSecret: secret });
  assert.deepEqual(f.state(), before);
});

test('discovery is limited to the demo origin and a typed three-field recipe', () => {
  const f = fixture();
  assert.throws(() => f.dispatch('scout', 'discover_site', { runId: 'run-1', agentId: 'scout', site: { ...f.site, url: 'https://external.example/form' } }), /owned demo origin/);
  assert.throws(() => f.dispatch('finch', 'discover_site', { runId: 'run-1', agentId: 'finch', site: f.site }), /Only the scout/);
  assert.equal(f.state().sites.length, 0);
});

test('only a verified scout receipt broadcasts and random delays persist under replay', () => {
  const f = fixture(); f.discover();
  assert.throws(f.publish, /accepted before broadcasting/);
  assert.throws(() => f.accept('scout'), /Claim the job/);
  f.claim('scout'); f.accept('scout'); f.publish();
  const jobs = structuredClone(f.state().jobs);
  assert.equal(jobs.length, 3);
  assert.equal(jobs.find(j => j.agentId === 'finch')!.dueAt, 8500);
  assert.equal(jobs.find(j => j.agentId === 'wren')!.dueAt, 16000);
  f.time(40_000); f.publish();
  assert.deepEqual(f.state().jobs, jobs);
});

test('worker leases cannot race and expire for crash recovery', () => {
  const f = fixture(); f.discover(); f.claim('scout');
  assert.throws(() => f.claim('scout'), /active lease/);
  assert.throws(() => f.dispatch('finch', 'claim_job', { runId: 'run-1', agentId: 'scout', jobId: 'run-1:site-1:scout' }), /worker identity/);
  f.time(1000 + LEASE_MS + 1); f.claim('scout');
  assert.equal(f.state().jobs[0].leaseUntil, 1000 + LEASE_MS * 2 + 1);
});

test('accepted submission survives worker restart and replay without duplicates', () => {
  const f = fixture(); f.discover(); f.claim('scout'); f.accept('scout');
  f.time(1000 + LEASE_MS + 1); f.claim('scout'); f.accept('scout'); f.complete('scout'); f.publish();
  assert.equal(f.state().submissions.length, 1);
  assert.equal(f.state().jobs[0].receiptId, 'run-1:site-1:scout');
});

test('followers cannot act early, and completion requires real receipts', () => {
  const f = fixture(); f.discover(); f.claim('scout'); f.accept('scout'); f.publish();
  assert.throws(() => f.claim('finch'), /not due/);
  assert.throws(() => f.complete('finch'), /acceptance receipt/);
  f.time(20_000);
  for (const id of ['finch', 'wren']) { f.claim(id); f.accept(id); f.complete(id); }
  assert.equal(f.state().run?.status, 'complete');
  assert.equal(f.state().submissions.length, 3);
  assert.equal(f.state().events.find(event => event.kind === 'complete')?.message, 'All three agents have confirmed browser submissions.');
  f.accept('wren');
  assert.equal(f.state().submissions.length, 3);
  f.dispatch('owner', 'start_run', { runId: 'run-1', seedUrl: 'http://127.0.0.1:3210/forum' });
  assert.equal(f.state().run?.status, 'complete');
  assert.equal(f.state().submissions.length, 3);
});

test('stopped and reset runs reject delayed side effects', () => {
  const f = fixture(); f.discover(); f.claim('scout');
  f.dispatch('owner', 'stop_run', {});
  assert.throws(() => f.accept('scout'), /not active/);
  f.dispatch('owner', 'reset', {});
  assert.throws(() => f.accept('scout'), /another run/);
  assert.equal(f.state().submissions.length, 0);
});
