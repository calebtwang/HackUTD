import test from 'node:test';
import assert from 'node:assert/strict';
import { modelDemoReady, modelDemoStartMessage, phonePresentation } from '../shared/readiness';
import { EMPTY_STATE, PERSONAS, type SetupStatus } from '../shared/contracts';
import { demoMode } from '../server/demo-mode';

function setup(tested: number): SetupStatus {
  return {database:{connected:true,host:'https://database.example',name:'demo'},model:{configured:true,provider:'configured-model'},voice:{configured:tested,total:3,webhookReady:false},publicUrl:'',mode:'live'};
}
test('model discovery is available with zero, two, or three tested lines',()=>{
  for (const count of [0,2,3]) assert.equal(modelDemoReady(setup(count)),true);
});
test('model discovery still requires both its actual dependencies',()=>{
  const current=setup(3); current.model.configured=false;
  assert.equal(modelDemoReady(current),false);
  current.model.configured=true; current.database.connected=false;
  assert.equal(modelDemoReady(current),false);
});
test('two tested lines are callable while Wren remains an explicit browser-only placeholder',()=>{
  const profiles=PERSONAS.map((p,index)=>({...p,phone:index<2?`+1555000000${index}`:'DEMO-WREN',voiceAgentId:`agent_${p.id}`,voiceReady:index<2}));
  const [scout,finch,wren]=profiles.map(phonePresentation);
  assert.equal(scout.href,'tel:+15550000000');assert.equal(finch.href,'tel:+15550000001');
  assert.deepEqual(wren,{state:'browser-only',label:'BROWSER ONLY',href:null});
  assert.equal(profiles.length,3);
});
test('importing a number alone never makes it a tested line',()=>{
  assert.deepEqual(phonePresentation({phone:'+15550000000',voiceAgentId:'agent_scout',voiceReady:false}),{state:'untested',label:'TEST NEEDED',href:null});
  assert.equal(phonePresentation({phone:'DEMO-WREN',voiceAgentId:'agent_wren',voiceReady:true}).href,null);
  assert.equal(phonePresentation({phone:'+15550000000',voiceAgentId:'',voiceReady:true}).href,null);
});
test('persisted model mode and its start event remain honest with partial phone coverage',()=>{
  const message=modelDemoStartMessage(setup(2));
  assert.equal(message,'Live demo started with model analysis. Phone lines tested: 2 of 3.');
  const state={...structuredClone(EMPTY_STATE),run:{id:'run-1',status:'complete' as const,seedUrl:'http://127.0.0.1:3210/forum',startedAt:1},events:[{id:'event',runId:'run-1',agentId:'scout',kind:'system',message,timestamp:1}]};
  assert.equal(demoMode(state,'rehearsal'),'live');
  assert.match(modelDemoStartMessage(setup(0)),/Phone lines tested: 0 of 3\./);
});
