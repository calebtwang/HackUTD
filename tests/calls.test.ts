import test from 'node:test';
import assert from 'node:assert/strict';
import { possibleMatch, callerNameMention, parseTranscript, observedCallStart } from '../server/calls.js';
import type { Submission } from '../shared/contracts.js';
const rows: Submission[] = [{id:'receipt1',runId:'run1',siteId:'site1',agentId:'scout',name:'Mara Bell',phone:'+15550100001',receivedAt:1}];
test('full name tolerates case and punctuation but not partial names',()=>{
  assert.equal(possibleMatch('Is this MARA, BELL?',rows)?.id,'receipt1');
  assert.equal(possibleMatch('Mara',rows),undefined);
  assert.equal(possibleMatch('Mara Bella',rows),undefined);
});
test('a name submitted to several sites cannot identify one source',()=>{
  const repeated=[...rows,{...rows[0],id:'receipt2',siteId:'site2'}];
  assert.equal(possibleMatch('Mara Bell?',repeated),undefined);
  assert.equal(callerNameMention([{role:'user',message:'Mara Bell?'}],repeated),undefined);
});
test('caller-first full name is retained for a possible association',()=>{
  assert.equal(callerNameMention([{role:'agent',message:'Hello?'},{role:'user',message:'Is this Mara Bell?'}],rows)?.submission.id,'receipt1');
});
test('agent-disclosed full name cannot create evidence from caller repetition',()=>{
  assert.equal(callerNameMention([{role:'agent',message:'I am Mara Bell'},{role:'user',message:'Mara Bell, right'}],rows),undefined);
});
test('caller-first mention survives a later agent confirmation',()=>{
  assert.equal(callerNameMention([{role:'user',message:'Mara Bell?'},{role:'agent',message:'Yes, Mara Bell.'}],rows)?.submission.id,'receipt1');
});
test('only actual text transcript turns are parsed',()=>assert.deepEqual(parseTranscript([{role:'user',message:'Hi'},{role:'user',message:null},null]),[{role:'user',message:'Hi'}]));

test('documented ElevenLabs ISO UTC microseconds and Z timestamps derive the same call start',()=>{
  const officialExample='2025-12-12T12:33:45.123456+00:00';
  const now=Date.parse('2025-12-12T12:33:45.123Z');
  const expected=Math.floor(now/1000)-142;
  assert.equal(observedCallStart(officialExample,142,now),expected);
  assert.equal(observedCallStart('2025-12-12T12:33:45.123Z',142,now),expected);
  assert.equal(observedCallStart('2025-12-12T06:33:45.123-06:00',142,now),expected);
  assert.equal(observedCallStart('Friday, 12:33 12 December 2025',142,now),undefined);
  assert.equal(observedCallStart(officialExample,Infinity,now),undefined);
  assert.equal(observedCallStart('not-a-timestamp',142,now),undefined);
});
