import test from 'node:test';
import assert from 'node:assert/strict';
import { demoMode } from '../server/demo-mode';
import { EMPTY_STATE, type DemoState } from '../shared/contracts';

test('a long-running model crawl retains its mode after old activity is evicted', () => {
  const state: DemoState = {...structuredClone(EMPTY_STATE),run:{id:'ongoing',status:'running',mode:'live',seedUrl:'http://127.0.0.1:3210/forum',startedAt:1}};
  assert.equal(demoMode(state,'rehearsal'),'live');
});

test('a persisted live run stays live when the local server restarts in rehearsal mode', () => {
  const state: DemoState = { ...structuredClone(EMPTY_STATE),
    run: {id:'current',status:'complete',seedUrl:'http://127.0.0.1:3210/forum',startedAt:2000},
    events: [
      {id:'previous-start',runId:'previous',agentId:'scout',kind:'system',message:'Rehearsal started. Fixture rules.',timestamp:1000},
      {id:'current-start',runId:'current',agentId:'scout',kind:'system',message:'Live demo started with model analysis and tested phone numbers.',timestamp:2000},
    ],
  };
  assert.equal(demoMode(state,'rehearsal'),'live');
  state.events[1].message='Rehearsal started. Fixture rules.';
  assert.equal(demoMode(state,'live'),'rehearsal');
});

test('a fresh run uses the requested mode until its recorded start event arrives', () => {
  const state: DemoState = { ...structuredClone(EMPTY_STATE),
    run: {id:'fresh',status:'running',seedUrl:'http://127.0.0.1:3210/forum',startedAt:2000},
    events: [{id:'old',runId:'previous',agentId:'scout',kind:'system',message:'Rehearsal started.',timestamp:1000}],
  };
  assert.equal(demoMode(state,'live'),'live');
});
