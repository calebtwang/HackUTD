import test from 'node:test';
import assert from 'node:assert/strict';
import { possibleMatch, verifiedMatch, parseTranscript, observedCallStart } from '../server/calls.js';
import type { Submission } from '../shared/contracts.js';
const rows: Submission[] = [{id:'receipt1',runId:'run1',siteId:'site1',agentId:'scout',name:'Mara Bell',phone:'+15550100001',marker:'Cedar Finch 47',receivedAt:1}];
test('a name alone never establishes a marker match',()=>assert.equal(possibleMatch('Is this Mara Bell?',rows),undefined));
test('exact reference tolerates case and punctuation',()=>assert.equal(possibleMatch('Your reference is CEDAR, FINCH 47.',rows)?.id,'receipt1'));
test('a different reference number does not match',()=>assert.equal(possibleMatch('Cedar Finch 470',rows),undefined));
test('caller reference is verified when caller says it first',()=>assert.equal(verifiedMatch([{role:'agent',message:'Hello?'},{role:'user',message:'Cedar Finch 47 is your reference'}],rows)?.submission.id,'receipt1'));
test('agent-disclosed reference cannot contaminate evidence',()=>assert.equal(verifiedMatch([{role:'agent',message:'My reference is Cedar Finch 47'},{role:'user',message:'Cedar Finch 47, right'}],rows),undefined));
test('caller-first evidence stays valid after agent repeats reference',()=>assert.equal(verifiedMatch([{role:'user',message:'Cedar Finch 47'},{role:'agent',message:'Cedar Finch 47?'}],rows)?.submission.id,'receipt1'));
test('only actual text transcript turns are parsed',()=>assert.deepEqual(parseTranscript([{role:'user',message:'Hi'},{role:'user',message:null},null]),[{role:'user',message:'Hi'}]));

const demoMarkerRows: Submission[] = [
  rows[0],
  {...rows[0],id:'receipt2',agentId:'finch',name:'Otis Vale',marker:'Copper Meadow 62'},
  {...rows[0],id:'receipt3',agentId:'wren',name:'Nell Rowan',marker:'Velvet Acorn 83'},
];
test('all three complete demo markers accept exact spoken-number transcriptions',()=>{
  for (const [text,id] of [['Your reference is Cedar Finch forty-seven.','receipt1'],['COPPER, MEADOW SIXTY TWO is the reference.','receipt2'],['I have Velvet Acorn eighty three here.','receipt3']]) {
    assert.equal(possibleMatch(text,demoMarkerRows)?.id,id);
    assert.equal(verifiedMatch([{role:'agent',message:'Hello?'},{role:'user',message:text}],demoMarkerRows)?.submission.id,id);
  }
});
test('spoken references still require the exact complete marker and correct number',()=>{
  for (const text of ['Mara Bell','Cedar Finch','forty seven','Cedar Finch forty eight','Copper Meadow sixty three','Velvet Acorn eighty four','Cedar Finch sixty two','cedarfinch forty seven','Cedar Finch 470','Cedar Finch 47.5','Cedar Finch forty seven hundred','Copper Meadow sixty two thousand','Velvet Acorn eighty three and one','Cedar Finch forty seven zero']) {
    assert.equal(possibleMatch(text,demoMarkerRows),undefined,text);
    assert.equal(verifiedMatch([{role:'user',message:text}],demoMarkerRows),undefined,text);
  }
  const custom = [{...rows[0],marker:'Willow Grove 47'}];
  assert.equal(possibleMatch('Willow Grove forty seven',custom),undefined);
});
test('agent disclosure blocks caller repetition across digit and spoken forms',()=>{
  for (const [disclosure,repeat] of [['Cedar Finch 47','Cedar Finch forty seven'],['Cedar Finch forty-seven','Cedar Finch 47'],['Copper Meadow sixty two','Copper Meadow 62'],['Velvet Acorn 83','Velvet Acorn eighty three']]) {
    assert.equal(verifiedMatch([{role:'agent',message:disclosure},{role:'user',message:repeat}],demoMarkerRows),undefined);
  }
});
test('caller-first spoken evidence survives a later digit-form agent repetition',()=>{
  const quote='Your reference is Copper Meadow sixty two.';
  const match=verifiedMatch([{role:'user',message:quote},{role:'agent',message:'Copper Meadow 62?'}],demoMarkerRows);
  assert.equal(match?.submission.id,'receipt2');
  assert.equal(match?.evidence,quote);
});
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
