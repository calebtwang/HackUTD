import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_STATE, type DemoState, type Job } from '../shared/contracts';
import { desiredJobTimers, releaseJobTimer, sameJobTimer, type JobTimer } from '../spacetimedb/src/scheduling';

function job(id:string,status:string,dueAt=5_000,leaseUntil=0):Job {
  return {id,runId:'run-1',siteId:'site-1',agentId:'finch',dueAt,leaseUntil,status,receiptId:''};
}
function state(jobs:Job[]):DemoState {
  return {...structuredClone(EMPTY_STATE),run:{id:'run-1',status:'running',seedUrl:'https://bank.example/forum',startedAt:1_000},jobs};
}

test('migration preserves chosen deadlines and schedules only current active future jobs and leases',()=>{
  const current=state([
    job('future','pending',8_765),job('due','pending',900),job('delayed','scheduled',6_000),
    job('lease','claimed',1_000,61_000),job('expired','claimed',1_000,500),job('done','succeeded'),
    {...job('older','pending',9_000),runId:'old-run'},
  ]);
  const timers=desiredJobTimers(current,1_000);
  assert.equal(current.jobs[0].status,'scheduled');assert.equal(current.jobs[0].dueAt,8_765);
  assert.equal(current.jobs[1].status,'pending');assert.equal(current.jobs[6].status,'pending');
  assert.deepEqual(timers,[
    {jobId:'future',runId:'run-1',kind:'release',expectedAt:8_765},
    {jobId:'delayed',runId:'run-1',kind:'release',expectedAt:6_000},
    {jobId:'lease',runId:'run-1',kind:'lease',expectedAt:61_000},
    {jobId:'expired',runId:'run-1',kind:'lease',expectedAt:500},
  ]);
  assert.deepEqual(desiredJobTimers(current,1_000),timers);
  assert.equal(current.jobs[4].status,'claimed','migration waits for the native timer even for an expired lease');
});

test('a due timer releases a real scheduled job once, without manufacturing any receipt or call',()=>{
  const current=state([job('delayed','scheduled')]);
  const timer=desiredJobTimers(current,1_000)[0];
  assert.equal(releaseJobTimer(current,timer,4_999),false);assert.equal(current.jobs[0].status,'scheduled');
  assert.equal(releaseJobTimer(current,timer,5_000),true);assert.equal(current.jobs[0].status,'pending');
  assert.equal(releaseJobTimer(current,timer,6_000),false);assert.deepEqual(desiredJobTimers(current,6_000),[]);
  assert.deepEqual(current.submissions,[]);assert.deepEqual(current.calls,[]);assert.deepEqual(current.sites,[]);
});

test('stale timers cannot release rescheduled, claimed, succeeded, replaced, or stopped jobs',()=>{
  const timer:JobTimer={jobId:'delayed',runId:'run-1',kind:'release',expectedAt:5_000};
  for(const altered of [job('delayed','scheduled',6_000),job('delayed','claimed',5_000,70_000),job('delayed','succeeded'),job('different','scheduled')]) {
    const current=state([altered]);const before=structuredClone(current);
    assert.equal(releaseJobTimer(current,timer,10_000),false);assert.deepEqual(current,before);
  }
  const replaced=state([job('delayed','scheduled')]);replaced.run!.id='new-run';
  assert.equal(releaseJobTimer(replaced,timer,10_000),false);
  const stopped=state([job('delayed','scheduled')]);stopped.run!.status='stopped';
  assert.equal(releaseJobTimer(stopped,timer,10_000),false);assert.deepEqual(desiredJobTimers(stopped,10_000),[]);
  stopped.run=null;stopped.jobs=[];
  assert.equal(releaseJobTimer(stopped,timer,10_000),false);assert.deepEqual(desiredJobTimers(stopped,10_000),[]);
});

test('lease expiry preserves an accepted receipt and a newer lease defeats an older timer',()=>{
  const leased=job('leased','claimed',1_000,61_000);leased.receiptId='accepted-receipt';
  const current=state([leased]);
  current.submissions=[{id:'accepted-receipt',runId:'run-1',siteId:'site-1',agentId:'finch',phone:'+12025550102',name:'Otis Vale',receivedAt:2_000}];
  const timer=desiredJobTimers(current,1_000)[0];
  assert.equal(releaseJobTimer(current,timer,60_999),false);
  assert.equal(releaseJobTimer(current,timer,61_000),true);
  assert.equal(current.jobs[0].status,'pending');assert.equal(current.jobs[0].leaseUntil,0);
  assert.equal(current.jobs[0].receiptId,'accepted-receipt');assert.equal(current.submissions.length,1);
  current.jobs[0].status='claimed';current.jobs[0].leaseUntil=121_000;
  assert.equal(releaseJobTimer(current,timer,100_000),false);
  const replacement=desiredJobTimers(current,61_000)[0];
  assert.equal(sameJobTimer(timer,replacement),false);
  assert.equal(sameJobTimer(replacement,{...replacement}),true);
  assert.equal(releaseJobTimer(current,replacement,121_000),true);
});
