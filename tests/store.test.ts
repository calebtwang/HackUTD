import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalDemoUrl, EMPTY_STATE, PERSONAS, type DemoState, type Site } from '../shared/contracts';
import { backendReaderAllowed, collectorPhoneRows, LEASE_MS, transition, type PrivateState } from '../spacetimedb/src/logic';
import { desiredJobTimers, releaseJobTimer } from '../spacetimedb/src/scheduling';

const secret = 'test-only-worker-secret-123456789';
const base = 'http://127.0.0.1:3210';
const entries = { scout: `${base}/forum`, finch: `${base}/forum` };
function fixture(entryPoints: Record<string,string> = entries) {
  let state: DemoState = structuredClone(EMPTY_STATE);
  let auth: PrivateState = { admin: 'owner', workerSecret: '', workers: {} };
  let now = 1_000; let sequence = 0;
  function dispatch(sender: string, action: string, input: unknown) {
    // Reducer failures roll back the full transaction, including private state.
    const next = structuredClone(state); const nextAuth = structuredClone(auth);
    transition(next, nextAuth, { sender, now, random: () => 0.5, uuid: () => `event-${++sequence}` }, action, input);
    desiredJobTimers(next,now);
    state = next; auth = nextAuth;
  }
  function tick() {
    const next=structuredClone(state);
    for(const timer of desiredJobTimers(next,now)) releaseJobTimer(next,timer,now);
    state=next;
  }
  const personas = PERSONAS.map((p, i) => ({ ...p, phone: `DEMO-00${i + 1}` }));
  dispatch('owner', 'configure', { personas, workerSecret: secret });
  for (const p of personas) dispatch(p.id, 'register_worker', { agentId: p.id, workerSecret: secret });
  const start = (points: Record<string,string>,runId='run-1') => dispatch('owner','start_run',{runId,seedUrl:`${base}/forum`,entryPoints:points});
  start(entryPoints);
  function site(id='site-1', url=`${base}/claim`): Site {
    return {id,runId:'run-1',url,title:'Demo credit',evidence:['Selected today; request a callback.'],confidence:'high',discoveredBy:'scout',status:'discovered',verifiedAt:0,analysisMode:'fixture',recipe:{url,fields:[{label:'Full name',valueFrom:'name'},{label:'Phone number',valueFrom:'phone'}],submitLabel:'Request callback',successText:'Your request has been received'}};
  }
  const discover = (who='scout', item=site()) => dispatch(who,'discover_site',{runId:'run-1',agentId:who,site:item});
  const claim = (who: string, id='site-1') => dispatch(who,'claim_job',{runId:'run-1',agentId:who,jobId:`run-1:${id}:${who}`});
  const accept = (who: string, id='site-1') => { const p=personas.find(p=>p.id===who)!;dispatch('owner','accept_submission',{runId:'run-1',siteId:id,agentId:who,name:p.name,phone:p.phone}); };
  const publish = (who='scout',id='site-1') => dispatch(who,'publish_site',{runId:'run-1',agentId:who,siteId:id});
  const complete = (who: string,id='site-1') => dispatch(who,'complete_job',{runId:'run-1',agentId:who,jobId:`run-1:${id}:${who}`,receiptId:`run-1:${id}:${who}`});
  const scanned = (who: string) => dispatch(who,'discovery_complete',{runId:'run-1',agentId:who});
  const submit = (who: string,id='site-1') => {claim(who,id);accept(who,id);complete(who,id);};
  return {dispatch,personas,start,site,discover,claim,accept,publish,complete,scanned,submit,tick,state:()=>state,auth:()=>auth,time:(value:number)=>{now=value;}};
}

test('owner and per-worker identities protect configuration, receipts, jobs and scan completion',()=>{
  const f=fixture();
  assert.equal(f.state().agents.length,2);
  assert.throws(()=>f.dispatch('visitor','configure',{personas:f.personas,workerSecret:secret}),/Admin/);
  assert.throws(()=>f.dispatch('visitor','reset',{}),/Admin/);
  assert.throws(()=>f.dispatch('visitor','register_worker',{agentId:'scout',workerSecret:secret}),/another identity/);
  assert.throws(()=>f.dispatch('visitor','register_worker',{agentId:'finch',workerSecret:'bad'}),/credential/);
  assert.throws(()=>f.dispatch('visitor','register_worker',{agentId:'wren',workerSecret:secret}),/Unknown agent/);
  assert.throws(()=>f.dispatch('finch','discovery_complete',{runId:'run-1',agentId:'scout'}),/worker identity/);
  f.discover();f.claim('scout');
  assert.throws(()=>f.dispatch('scout','accept_submission',{runId:'run-1',siteId:'site-1',agentId:'scout',name:f.personas[0].name,phone:f.personas[0].phone}),/Admin/);
  assert.throws(()=>f.dispatch('owner','accept_submission',{runId:'run-1',siteId:'site-1',agentId:'scout',name:'Someone else',phone:f.personas[0].phone}),/configured demo alias/);
});

test('unchanged running configuration preserves state; migration removes Wren identity but retains history',()=>{
  const f=fixture();f.discover();const before=structuredClone(f.state());
  f.dispatch('owner','configure',{personas:f.personas,workerSecret:secret});assert.deepEqual(f.state(),before);
  f.dispatch('owner','stop_run',{});
  f.state().agents.push({...f.state().agents[0],id:'wren',name:'Legacy character'});f.auth().workers.wren='old-worker';
  f.state().submissions.push({id:'old-receipt',runId:'older-run',siteId:'old-site',agentId:'wren',name:'Legacy character',phone:'DEMO-WREN',receivedAt:1});
  f.dispatch('owner','configure',{personas:f.personas,workerSecret:secret});
  assert.deepEqual(f.state().agents.map(a=>a.id),['scout','finch']);assert.equal(f.auth().workers.wren,undefined);
  assert.equal(f.state().submissions.find(row=>row.id==='old-receipt')?.agentId,'wren');assert.equal(f.state().sites.length,1);
});

test('entry points require one scanner, allow a blank waiting peer and public read-only starts',()=>{
  const f=fixture({scout:'',finch:`${base}/forum`});
  assert.equal(f.state().agents[0].status,'waiting');assert.equal(f.state().agents[1].status,'discovering');
  assert.throws(()=>f.discover('scout'),/no discovery entry point/);
  f.dispatch('owner','stop_run',{});
  assert.throws(()=>f.start({scout:'',finch:' '},'empty'),/At least one/);
  assert.throws(()=>f.start({scout:'file:///tmp/a',finch:''},'invalid'),/HTTP/);
  assert.throws(()=>f.start({scout:`${base}/forum`,wren:`${base}/forum`},'unknown'),/Unknown entry/);
  f.start({scout:'https://example.com/public-forum',finch:''},'external');
  assert.equal(f.state().run?.entryPoints?.scout,'https://example.com/public-forum');
  assert.equal(f.state().run?.seedUrl,`${base}/forum`);
});

test('run mode survives activity retention even when continuous scans find no sites',()=>{
  const f=fixture();assert.equal(f.state().run?.mode,'rehearsal');f.dispatch('owner','stop_run',{});
  assert.throws(()=>f.dispatch('owner','start_run',{runId:'invalid-mode',seedUrl:`${base}/forum`,entryPoints:entries,mode:'automatic'}),/discovery mode/);
  f.dispatch('owner','start_run',{runId:'model-run',seedUrl:`${base}/forum`,entryPoints:entries,mode:'live'});
  for(let index=0;index<501;index++) f.dispatch('scout','event',{runId:'model-run',agentId:'scout',kind:'inspect',message:`Inspected page ${index}`});
  assert.equal(f.state().events.length,500);assert.equal(f.state().events.some(event=>event.kind==='run_started'),false);
  assert.equal(f.state().sites.length,0);assert.equal(f.state().run?.mode,'live');assert.equal(f.state().run?.status,'running');
});

test('either agent can discover and publish; original receipt creates one replay-stable delayed peer job',()=>{
  for(const who of ['scout','finch']) {
    const other=who==='scout'?'finch':'scout';const f=fixture();f.discover(who);
    assert.equal(f.state().sites[0].discoveredBy,who);assert.equal(f.state().jobs[0].agentId,who);
    assert.throws(()=>f.publish(other),/original discoverer/);assert.throws(()=>f.publish(who),/accepted before broadcasting/);
    assert.throws(()=>f.accept(who),/Claim the job/);f.claim(who);f.accept(who);f.publish(who);
    const jobs=structuredClone(f.state().jobs);assert.equal(jobs.length,2);assert.equal(jobs.find(j=>j.agentId===other)!.dueAt,8500);assert.equal(jobs.find(j=>j.agentId===other)!.status,'scheduled');
    f.time(40_000);f.publish(who);assert.deepEqual(f.state().jobs,jobs);
    assert.equal('marker' in f.state().submissions[0],false);
  }
});

test('canonical duplicate discovery races keep the first owner, recipe and job without duplicates',()=>{
  const f=fixture();const url=`${base}/claim?b=2&a=1`;
  f.discover('finch',f.site('winner',url));
  f.discover('scout',{...f.site('loser',`${base}/claim?a=1&agentId=scout&b=2#form`),title:'Stale title'});
  assert.equal(f.state().sites.length,1);assert.equal(f.state().sites[0].id,'winner');assert.equal(f.state().sites[0].discoveredBy,'finch');
  assert.equal(f.state().sites[0].title,'Demo credit');assert.equal(f.state().jobs.length,1);
  assert.equal(f.state().sites[0].url,`${base}/claim?a=1&b=2`);
  assert.throws(()=>f.discover('scout',f.site('winner',`${base}/other`)),/different URL/);
  assert.equal(canonicalDemoUrl('HTTP://Example.com:80/a/?z=2&runId=x&a=one%20two#x'),'http://example.com/a/?a=one+two&z=2');
  assert.notEqual(canonicalDemoUrl(`${base}/claim`),canonicalDemoUrl(`${base}/claim/`));
});

test('public query keys remain meaningful for entry points and distinct discovered URLs',()=>{
  const f=fixture({scout:'https://example.com/forum?site=one&agent=board&run=latest',finch:''});
  assert.equal(f.state().run?.entryPoints?.scout,'https://example.com/forum?agent=board&run=latest&site=one');
  f.discover('scout',{...f.site('public-one','https://example.com/form?site=one'),recipe:null});
  f.discover('scout',{...f.site('public-two','https://example.com/form?site=two'),recipe:null});
  f.discover('scout',{...f.site('duplicate','https://example.com/form?site=one#top'),recipe:null});
  assert.deepEqual(f.state().sites.map(site=>site.url),['https://example.com/form?site=one','https://example.com/form?site=two']);
  assert.equal(f.state().jobs.length,0);
  assert.equal(canonicalDemoUrl('https://example.com/?runId=one&siteId=two&agentId=three',false),'https://example.com/?agentId=three&runId=one&siteId=two');
});

test('owned recipes require exactly name and phone; unsafe origins can never create submission jobs',()=>{
  const f=fixture();const site=f.site();
  assert.throws(()=>f.discover('scout',{...site,recipe:{...site.recipe!,fields:[...site.recipe!.fields,{label:'Reference',valueFrom:'marker'}] as any}}),/two-field/);
  assert.throws(()=>f.discover('scout',{...site,recipe:{...site.recipe!,fields:[{label:'Name',valueFrom:'name'},{label:'Other name',valueFrom:'name'}]}}),/recipe field/);
  assert.throws(()=>f.discover('scout',{...site,recipe:{...site.recipe!,url:'https://elsewhere.example/submit'}}),/two-field/);
  assert.throws(()=>f.discover('scout',f.site('credentials','http://127.0.0.1:3210@evil.example/form')),/without credentials/);
  const external={...f.site('external','https://example.com/offer'),submissionAllowed:true,observedFields:['Email','Password']};f.discover('scout',external);
  const saved=f.state().sites[0];assert.equal(saved.status,'observed');assert.equal(saved.submissionAllowed,false);assert.equal(saved.recipe,null);assert.deepEqual(saved.observedFields,['Email','Password']);assert.equal(f.state().jobs.length,0);
  assert.throws(()=>f.publish('scout','external'),/Observation-only/);assert.throws(()=>f.accept('scout','external'),/Observation-only/);
  f.scanned('scout');f.scanned('finch');assert.equal(f.state().run?.status,'running');
});

test('leases serialize races, expire for recovery, and preserve idempotent accepted receipts',()=>{
  const f=fixture();f.discover();f.claim('scout');
  assert.throws(()=>f.claim('scout'),/active lease/);
  assert.throws(()=>f.dispatch('finch','claim_job',{runId:'run-1',agentId:'scout',jobId:'run-1:site-1:scout'}),/worker identity/);
  f.accept('scout');f.time(1000+LEASE_MS+1);assert.throws(()=>f.claim('scout'),/database scheduler/);f.tick();f.claim('scout');f.accept('scout');
  assert.equal(f.state().jobs[0].leaseUntil,1000+LEASE_MS*2+1);assert.equal(f.state().submissions.length,1);
  f.complete('scout');f.publish();assert.equal(f.state().jobs[0].receiptId,'run-1:site-1:scout');
});

test('blank-entry peer receives delayed jobs and replay does not end the ongoing run',()=>{
  const f=fixture({scout:'',finch:`${base}/forum`});f.discover('finch');f.submit('finch');f.publish('finch');
  assert.throws(()=>f.claim('scout'),/not due/);assert.throws(()=>f.complete('scout'),/acceptance receipt/);
  f.scanned('finch');assert.equal(f.state().run?.status,'running');f.time(20_000);
  assert.throws(()=>f.claim('scout'),/database scheduler/);f.tick();f.submit('scout');
  assert.equal(f.state().run?.status,'running');assert.equal(f.state().submissions.length,2);
  f.accept('scout');f.complete('scout');f.publish('finch');f.scanned('finch');
  f.dispatch('owner','start_run',{runId:'run-1'});assert.equal(f.state().run?.status,'running');assert.equal(f.state().submissions.length,2);
  assert.equal(f.state().events.filter(e=>e.kind==='complete').length,0);
});

test('finished scans and all current receipts leave the run open for later sites',()=>{
  const f=fixture();f.discover('scout');f.submit('scout');f.publish('scout');f.time(20_000);f.tick();f.submit('finch');
  assert.equal(f.state().run?.status,'running');f.scanned('scout');assert.equal(f.state().run?.status,'running');
  f.discover('finch',f.site('site-2',`${base}/second`));f.submit('finch','site-2');f.publish('finch','site-2');f.scanned('finch');
  assert.equal(f.state().run?.status,'running');assert.equal(f.state().jobs.length,4);f.time(40_000);f.tick();f.submit('scout','site-2');
  assert.equal(f.state().run?.status,'running');assert.equal(f.state().submissions.length,4);
  assert.equal(f.state().events.some(e=>e.kind==='complete'),false);
  f.discover('scout',f.site('site-3',`${base}/third`));assert.equal(f.state().sites.length,3);assert.equal(f.state().run?.discoveryCompleteIds?.includes('scout'),false);
});

test('simultaneous distinct discoveries preserve every receipt without auto-stopping',()=>{
  const f=fixture();f.discover('scout');f.discover('finch',f.site('site-2',`${base}/second`));
  f.scanned('scout');f.scanned('finch');f.submit('scout');f.submit('finch','site-2');
  assert.equal(f.state().run?.status,'running');f.publish('scout');f.publish('finch','site-2');f.time(20_000);f.tick();
  f.submit('finch');assert.equal(f.state().run?.status,'running');f.submit('scout','site-2');assert.equal(f.state().run?.status,'running');
});

test('empty repeated scans do not stop or spam events; explicit stop and reset reject later effects',()=>{
  const empty=fixture();empty.scanned('scout');empty.scanned('finch');empty.scanned('scout');empty.scanned('finch');assert.equal(empty.state().run?.status,'running');
  assert.equal(empty.state().events.filter(e=>e.kind==='discovery_complete').length,2);empty.discover('scout');empty.scanned('scout');assert.equal(empty.state().events.filter(e=>e.kind==='discovery_complete').length,3);
  const f=fixture();f.discover();f.claim('scout');f.dispatch('owner','stop_run',{});assert.throws(()=>f.accept('scout'),/not active/);
  assert.throws(()=>f.scanned('scout'),/not active/);f.dispatch('owner','reset',{});assert.throws(()=>f.accept('scout'),/another run/);assert.equal(f.state().submissions.length,0);
});

test('backend readers require an owner or registered worker and collector rows expose only receipt phones',()=>{
  const f=fixture();
  assert.equal(backendReaderAllowed(f.auth(),'owner'),true);
  assert.equal(backendReaderAllowed(f.auth(),'scout'),true);
  assert.equal(backendReaderAllowed(f.auth(),'finch'),true);
  assert.equal(backendReaderAllowed(f.auth(),'visitor'),false);
  const auth={...f.auth(),workers:{}};assert.equal(backendReaderAllowed(auth,'scout'),false);
  const rows=[
    {data:JSON.stringify({phone:'+12025550101',name:'Mara',secret:'not public'})},
    {data:JSON.stringify({phone:'+12025550101'})},{data:JSON.stringify({phone:'+12025550102'})},
    {data:JSON.stringify({phone:'DEMO-SCOUT'})},{data:JSON.stringify({phone:'+1234567'})},
    {data:'null'},{data:'invalid json'},
  ];
  assert.deepEqual(collectorPhoneRows(rows),[{phone:'+12025550101'},{phone:'+12025550102'}]);
  assert.deepEqual(collectorPhoneRows([]),[]);
});

const openPhishFeed='https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt';
function report(f: ReturnType<typeof fixture>,urls: string[],sourceUrl=openPhishFeed,who='scout') {
  f.dispatch(who,'report_feed',{runId:'run-1',agentId:who,sourceUrl,urls});
}
function inspect(f: ReturnType<typeof fixture>,siteId: string,update: Record<string,unknown>,who='finch') {
  f.dispatch(who,'inspect_site',{runId:'run-1',agentId:who,siteId,...update});
}

test('feed batches create visible attributed reports without implying inspection or creating jobs',()=>{
  const f=fixture();const urls=Array.from({length:95},(_,index)=>`https://example.com/offer?site=${index}`);
  for(let offset=0;offset<urls.length;offset+=40) report(f,urls.slice(offset,offset+40));
  assert.equal(f.state().sites.length,95);assert.equal(new Set(f.state().sites.map(site=>site.id)).size,95);
  for(const site of f.state().sites) {
    assert.equal(site.sourceUrl,openPhishFeed);assert.equal(site.sourceLabel,'OpenPhish');assert.equal(site.inspectionStatus,'pending');
    assert.equal(site.analysisMode,'feed');assert.equal(site.confidence,'unassessed');assert.equal(site.status,'reported');
    assert.equal(site.verifiedAt,0);assert.equal(site.recipe,null);assert.equal(site.submissionAllowed,false);assert.deepEqual(site.evidence,[]);
  }
  assert.equal(f.state().jobs.length,0);assert.equal(f.state().submissions.length,0);assert.equal(f.state().run?.status,'running');
  const before=structuredClone(f.state().sites);report(f,urls.slice(0,40));assert.deepEqual(f.state().sites,before);
  report(f,['https://example.com/other'],'https://feeds.example/list.txt');assert.equal(f.state().sites.at(-1)?.sourceLabel,'URL feed');
});

test('feed reports reject unauthorized, private, credentialed, oversized and owned targets atomically',()=>{
  const f=fixture();
  assert.throws(()=>f.dispatch('visitor','report_feed',{runId:'run-1',agentId:'scout',sourceUrl:openPhishFeed,urls:['https://example.com/']}),/worker identity/);
  assert.throws(()=>report(f,Array.from({length:51},(_,i)=>`https://example.com/${i}`)),/1 to 50/);
  for(const invalid of [`${base}/phishing`,'http://127.0.0.1/','http://2130706433/','http://0x7f000001/','http://169.254.169.254/','http://[::1]/','http://[::ffff:127.0.0.1]/','http://a.internal/','https://user:pass@example.com/','javascript:alert(1)','https://example.com:8443/']) {
    assert.throws(()=>report(f,['https://example.com/valid',invalid]));assert.equal(f.state().sites.length,0);
  }
  assert.throws(()=>report(f,['https://example.com/'],'http://localhost/feed.txt'));assert.equal(f.state().sites.length,0);
});

test('feed attribution attaches to an existing candidate without overwriting its ID or model findings',()=>{
  const f=fixture();const site={...f.site('existing-model-site','https://example.com/review'),analysisMode:'model' as const,observedFields:['Contact number'],recipe:null};
  f.discover('scout',site);const original=structuredClone(f.state().sites[0]);report(f,[site.url]);
  const merged=f.state().sites[0];assert.equal(merged.id,original.id);assert.equal(merged.sourceUrl,openPhishFeed);assert.equal(merged.inspectionStatus,'inspected');
  for(const key of ['title','confidence','analysisMode','evidence','observedFields','status','discoveredBy'] as const) assert.deepEqual(merged[key],original[key]);
  const before=structuredClone(merged);report(f,[site.url],'https://feeds.example/another.txt','finch');assert.deepEqual(f.state().sites[0],before);
  assert.equal(f.state().run?.id,'run-1');assert.equal(f.state().jobs.length,0);
});

test('any authenticated peer can record fetch and analysis failures while preserving observed form data',()=>{
  const f=fixture();report(f,['https://example.com/form']);const id=f.state().sites[0].id;
  inspect(f,id,{inspectionStatus:'inspecting'});
  inspect(f,id,{inspectionStatus:'unavailable',inspectionMessage:'HTTP 503'});
  assert.equal(f.state().sites[0].inspectionStatus,'unavailable');assert.equal(f.state().sites[0].inspectionMessage,'HTTP 503');
  inspect(f,id,{inspectionStatus:'inspecting',title:'Observed login',observedFields:['Email','Password'],observedButtons:['Sign in'],observedFormAction:'javascript:void(0)'});
  inspect(f,id,{inspectionStatus:'analysis_failed',inspectionMessage:'Model evidence did not quote the fetched page.'});
  const saved=f.state().sites[0];assert.equal(saved.inspectionStatus,'analysis_failed');assert.deepEqual(saved.observedFields,['Email','Password']);assert.deepEqual(saved.observedButtons,['Sign in']);assert.equal(saved.observedFormAction,'javascript:void(0)');
  assert.equal(saved.analysisMode,'feed');assert.deepEqual(saved.evidence,[]);assert.equal(saved.sourceUrl,openPhishFeed);assert.equal(saved.verifiedAt,0);assert.equal(f.state().jobs.length,0);
  assert.throws(()=>inspect(f,id,{inspectionStatus:'unavailable',observedFields:['']}),/observed fields/);
  assert.throws(()=>inspect(f,id,{inspectionStatus:'verified'}),/inspection status/);
  assert.throws(()=>inspect(f,id,{inspectionStatus:'inspected',analysisMode:'model',confidence:'high',evidence:[]}),/requires evidence/);
  assert.throws(()=>inspect(f,id,{inspectionStatus:'unavailable',recipe:{url:saved.url}}),/Unsupported/);
});

test('successful inspection is distinct from a feed report and survives stale peers and repeated imports',()=>{
  const f=fixture();report(f,['https://example.com/candidate','https://example.com/ordinary']);const [candidate,ordinary]=f.state().sites;
  inspect(f,ordinary.id,{inspectionStatus:'not_flagged',analysisMode:'model',confidence:'medium',evidence:[],observedFields:['Name']});
  assert.equal(f.state().sites[1].inspectionStatus,'not_flagged');assert.equal(f.state().sites[1].analysisMode,'model');assert.equal(f.state().sites[1].verifiedAt,0);
  inspect(f,candidate.id,{inspectionStatus:'inspected',analysisMode:'model',confidence:'high',evidence:['Act today to claim your reward.'],observedFields:['Name','Phone']});
  const before=structuredClone(f.state().sites[0]);
  inspect(f,candidate.id,{inspectionStatus:'unavailable',inspectionMessage:'Late peer HTTP 503'},'scout');
  inspect(f,candidate.id,{inspectionStatus:'not_flagged',analysisMode:'fixture',confidence:'low',evidence:[]},'scout');
  report(f,[candidate.url]);assert.deepEqual(f.state().sites[0],before);
  assert.equal(before.status,'observed');assert.equal(before.verifiedAt,0);assert.equal(before.sourceUrl,openPhishFeed);assert.equal(before.submissionAllowed,false);assert.equal(before.recipe,null);
  assert.throws(()=>f.publish('scout',candidate.id),/Observation-only/);assert.throws(()=>f.accept('scout',candidate.id),/Observation-only/);
  f.discover('scout',f.site('owned'));assert.throws(()=>inspect(f,'owned',{inspectionStatus:'inspecting'}),/Only external/);
  f.dispatch('owner','stop_run',{});assert.throws(()=>inspect(f,candidate.id,{inspectionStatus:'inspecting'}),/not active/);assert.throws(()=>report(f,['https://example.com/later']),/not active/);
});
