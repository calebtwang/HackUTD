import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWorkerSupervisor, type WorkerExit } from '../server/worker-supervisor.ts';

class FakeProcess extends EventEmitter {
  killed: Array<NodeJS.Signals|number> = [];
  kill(signal: NodeJS.Signals|number = 'SIGTERM') { this.killed.push(signal); return true; }
}
function fixture() {
  let activeRun = 'run-1';
  let spawnFailures = 0;
  const spawned: Array<{ agentId: string; runId: string; child: FakeProcess }> = [];
  const timers: Array<{ fire: () => void; delay: number; cancelled: boolean }> = [];
  const events: WorkerExit[] = [];
  const supervisor = createWorkerSupervisor({
    isRunActive: runId => runId === activeRun,
    spawn: (agentId, runId) => {
      if (spawnFailures > 0) { spawnFailures--; throw new Error('Synthetic spawn failure'); }
      const child = new FakeProcess(); spawned.push({ agentId, runId, child }); return child;
    },
    onExit: event => events.push(event),
    schedule: (fire, delay) => { const timer = { fire, delay, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
  });
  return { supervisor, spawned, timers, events, setRun: (runId: string) => { activeRun = runId; }, failSpawns: (count: number) => { spawnFailures = count; } };
}

test('signal and normal exits get five bounded retries with increasing backoff', () => {
  const f=fixture(); f.supervisor.start('run-1',['scout']);
  for (const [index,delay] of [1000,5000,15000,30000,60000].entries()) {
    f.spawned.at(-1)!.child.emit('exit',index===0?null:0,index===0?'SIGKILL':null);
    assert.equal(f.timers[index].delay,delay);
    assert.equal(f.events[index].attempt,index+1);
    f.timers[index].fire();
  }
  assert.equal(f.events[0].signal,'SIGKILL');
  assert.equal(f.spawned.length,6);
  f.spawned.at(-1)!.child.emit('exit',1,null);
  assert.equal(f.timers.length,5);
  assert.equal(f.events.at(-1)!.delayMs,null);
});

test('each worker has its own retry budget and spawn failures cannot crash the supervisor', () => {
  const f=fixture(); f.failSpawns(1); f.supervisor.start('run-1',['scout','finch']);
  assert.equal(f.spawned.length,1);
  assert.equal(f.events[0].spawnError,true);
  f.timers[0].fire();
  f.spawned.find(item=>item.agentId==='finch')!.child.emit('exit',1,null);
  assert.equal(f.events.at(-1)!.attempt,1);
  assert.equal(f.events.at(-1)!.agentId,'finch');
});

test('an error followed by exit schedules only one replacement', () => {
  const f=fixture(); f.supervisor.start('run-1',['scout']);
  const child=f.spawned[0].child;
  child.emit('error',new Error('Synthetic startup error'));
  child.emit('exit',1,null);
  assert.equal(f.timers.length,1); assert.equal(f.events.length,1);
});

test('Stop cancels pending retries and makes late callbacks and exits harmless', () => {
  const f=fixture(); f.supervisor.start('run-1',['scout','finch']);
  f.spawned[0].child.emit('exit',1,null);
  const pending=f.timers[0];
  f.supervisor.stop();
  assert.equal(pending.cancelled,true);
  assert.deepEqual(f.spawned[1].child.killed,['SIGTERM']);
  pending.fire();
  f.spawned[1].child.emit('exit',null,'SIGTERM');
  assert.equal(f.spawned.length,2); assert.equal(f.events.length,1);
});

test('a replacement run invalidates old timers and old process exits', () => {
  const f=fixture(); f.supervisor.start('run-1',['scout','finch']);
  const oldFinch=f.spawned[1].child;
  f.spawned[0].child.emit('exit',1,null);
  f.setRun('run-2'); f.supervisor.start('run-2',['scout','finch']);
  f.timers[0].fire(); oldFinch.emit('exit',1,null);
  assert.equal(f.spawned.length,4); assert.equal(f.events.length,1);
  f.spawned[2].child.emit('exit',1,null);
  assert.equal(f.events.at(-1)!.runId,'run-2'); assert.equal(f.events.at(-1)!.attempt,1);
});

test('an authoritative stopped run or shutdown prevents a queued restart', () => {
  const f=fixture(); f.supervisor.start('run-1',['scout']);
  f.spawned[0].child.emit('exit',1,null);
  f.setRun(''); f.timers[0].fire();
  assert.equal(f.spawned.length,1);
  f.supervisor.start('run-1',['scout']);
  assert.equal(f.spawned.length,1);
});
