import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createHosting, publicSnapshot, type HostingOptions } from '../server/hosting.js';
import { mountProductionFrontend } from '../server/static.js';
import { EMPTY_STATE, PERSONAS, type AppSnapshot } from '../shared/contracts.js';

const manager='https://manager.example';
const fixture='https://fixture.example';
const alias='https://bank.example';
const forum='https://forum.example';
const code='test-only-judge-code-123456';
const options:HostingOptions={port:3210,managerOrigin:manager,demoOrigin:fixture,judgeCode:code};
function snapshot(): AppSnapshot {
  return {...structuredClone(EMPTY_STATE),
    run:{id:'run',status:'running',startedAt:1,seedUrl:`${fixture}/forum`,entryPoints:{scout:'https://example.com/feed',finch:''},mode:'live'},
    agents:PERSONAS.map(persona=>({...persona,phone:'+12025550123',voiceAgentId:'PRIVATE_PROVIDER_ID',voiceReady:true,status:'running',heartbeatAt:1})),
    jobs:[{id:'PRIVATE_JOB',runId:'run',siteId:'site',agentId:'scout',dueAt:0,status:'claimed',leaseUntil:100,receiptId:''}],
    events:[{id:'PRIVATE_EVENT',runId:'run',agentId:'scout',kind:'error',message:'PRIVATE_LOG',timestamp:1}],
    submissions:[{id:'PRIVATE_RECEIPT',runId:'run',siteId:'site',agentId:'scout',name:'Mara Bell',phone:'+12025550123',receivedAt:1}],
    calls:[{id:'PRIVATE_CONVERSATION',runId:'run',agentId:'scout',status:'completed',startedAt:1,durationSeconds:2,matchStatus:'none',matchedSiteId:'',evidence:'PRIVATE_EVIDENCE',transcript:[{role:'user',message:'PRIVATE_TRANSCRIPT'}],summary:'PRIVATE_SUMMARY'}],
    sites:[{id:'site',runId:'run',url:'https://example.com/',title:'Observed site',evidence:['PRIVATE_EVIDENCE'],confidence:'high',recipe:null,status:'observed',discoveredBy:'scout',verifiedAt:0,analysisMode:'model',inspectionStatus:'analysis_failed',inspectionMessage:'PRIVATE_PROVIDER_ERROR',observedFields:['Phone'],sourceUrl:'https://example.com/feed',sourceLabel:'URL feed'}],
    setup:{database:{connected:true,host:'PRIVATE_DB_HOST',name:'PRIVATE_DB_NAME'},model:{configured:true,provider:'PRIVATE_PROVIDER'},voice:{configured:2,total:2,webhookReady:true},publicUrl:'PRIVATE_WEBHOOK_URL',mode:'live'},
  };
}
async function harness(config:HostingOptions=options,clock=Date.now,dist?:string) {
  const hosting=createHosting(config,clock);
  const app=express();
  app.use(hosting.guard,express.json());
  app.get('/api/state',(req,res)=>res.json(hosting.authenticated(req)?snapshot():publicSnapshot(snapshot())));
  app.get('/api/debug/state',(_req,res)=>res.json(snapshot()));
  app.get('/api/auth/status',(req,res)=>res.json({authenticated:hosting.authenticated(req),required:hosting.hosted}));
  app.get('/api/public-config',(req,res)=>res.json(hosting.publicConfig(req)));
  app.post('/api/auth/login',hosting.login);
  app.post('/api/auth/logout',hosting.logout);
  app.post('/api/demo/start',(_req,res)=>res.json({started:true}));
  app.post('/api/mock/submit',(_req,res)=>res.json({submitted:true}));
  app.get('/health',(_req,res)=>res.json({ok:true}));
  app.get('/admin',(_req,res)=>res.type('html').send('<pre>+12025550123</pre>'));
  app.get('/forum',(req,res,next)=>{
    const destination=hosting.forumRedirect(req);
    if(destination) {res.redirect(302,destination);return;}
    next();
  });
  if(dist) mountProductionFrontend(app,dist);
  else app.get('/{*path}',(_req,res)=>res.send('page'));
  const server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address(); assert.ok(address && typeof address!=='string');
  const port=address.port;
  async function request(route:string,init:RequestInit={},host='manager.example') {
    return new Promise<Response>((resolve,reject)=>{
      const req=httpRequest({hostname:'127.0.0.1',port,path:route,method:init.method || 'GET',headers:{Host:host,...init.headers as Record<string,string>}},res=>{
        const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));
        res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers as Record<string,string>})));
        res.on('error',reject);
      });
      req.on('error',reject);req.end(init.body as string|undefined);
    });
  }
  return {request,hosting,close:()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
function post(body:unknown={},origin=manager,cookie?:string):RequestInit {
  return {method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)};
}
async function login(h:Awaited<ReturnType<typeof harness>>) {
  const response=await h.request('/api/auth/login',post({code}));
  assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie')!;
  assert.match(cookie,/^__Host-judge=[0-9a-f]{64};/);
  assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);
  assert.ok(!cookie.includes('Domain='));
  return cookie.split(';')[0];
}

test('hosted startup fails closed for incomplete, insecure, or ambiguous configuration',()=>{
  for(const changes of [{judgeCode:''},{judgeCode:'short'},{demoOrigin:''},{managerOrigin:'http://manager.example'},{demoOrigin:manager},{demoOrigin:`${fixture}/path`},{managerOrigin:'https://user:pass@manager.example'}]) {
    assert.throws(()=>createHosting({...options,...changes}));
  }
  const h=createHosting(options);
  assert.equal(h.production,true);
  assert.equal(h.canResume('http://127.0.0.1:3210/forum'),false);
  assert.equal(h.canResume(`${fixture}/forum`),true);
  assert.equal(createHosting({port:3210}).canResume('http://127.0.0.1:3210/forum'),true);
  for(const value of [manager,'http://bank.example','https://*.example','https://bank.example/path','https://user:pass@bank.example','https://bank.example:8443']) {
    assert.throws(()=>createHosting({...options,demoAliases:[value]}));
  }
  assert.throws(()=>createHosting({port:3210,demoAliases:[alias]}));
  for(const forumOrigin of [manager,fixture,alias,'http://forum.example','https://*.example','https://forum.example/path','https://user:pass@forum.example']) {
    assert.throws(()=>createHosting({...options,demoAliases:[alias],forumOrigin}));
  }
  assert.throws(()=>createHosting({port:3210,forumOrigin:forum}));
});

test('public manager snapshot omits diagnostics and provider identifiers while preserving tested phone readiness',()=>{
  const privateState=snapshot();
  const publicState=publicSnapshot(privateState);
  assert.ok(!JSON.stringify(publicState).includes('PRIVATE_'));
  assert.equal(publicState.run?.entryPoints?.scout,'https://example.com/feed');
  assert.equal(publicState.sites[0].observedFields?.[0],'Phone');
  assert.equal(publicState.agents[0].voiceReady,true);
  assert.equal(publicState.agents[0].voiceAgentId,'');
  privateState.agents[0].voiceAgentId='';
  assert.equal(publicSnapshot(privateState).agents[0].voiceReady,false);
  privateState.agents[1].phone='DEMO-FINCH';
  assert.equal(publicSnapshot(privateState).agents[1].voiceReady,false);
  assert.equal(privateState.calls[0].transcript[0].message,'PRIVATE_TRANSCRIPT');
});

test('untrusted visitors cannot control runs or bypass exact hosts and origins',async()=>{
  const h=await harness();
  try {
    assert.equal((await h.request('/api/state')).status,200);
    assert.equal((await h.request('/api/demo/start',post())).status,401);
    assert.equal((await h.request('/api/debug/state')).status,401);
    assert.equal((await h.request('/api/state',{headers:{'X-Forwarded-Host':'manager.example'}},'attacker.example')).status,403);
    assert.equal((await h.request('/api/state',{},'127.0.0.1:3210')).status,403);
    for(const origin of ['https://attacker.example','https://manager.example.attacker.example',fixture,'null']) assert.equal((await h.request('/api/auth/login',post({code},origin))).status,403);
    assert.equal((await h.request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})})).status,403);
    assert.equal((await h.request('/api/auth/login',post({code}), 'fixture.example')).status,404);
  } finally {await h.close();}
});

test('judge sessions expire, cannot be forged, and logout immediately revokes previously authenticated requests',async()=>{
  let now=100;
  const h=await harness(options,()=>now);
  try {
    const cookie=await login(h);
    assert.equal((await h.request('/api/demo/start',post({},manager,cookie))).status,200);
    assert.equal((await h.request('/api/debug/state',{headers:{Cookie:cookie}})).status,200);
    assert.ok((await (await h.request('/api/state',{headers:{Cookie:cookie}})).text()).includes('PRIVATE_TRANSCRIPT'));
    assert.equal((await h.request('/api/demo/start',post({},fixture,cookie))).status,403);
    assert.equal((await h.request('/api/demo/start',post({},manager,'__Host-judge=forged'))).status,401);
    assert.equal((await h.request('/api/auth/logout',post({},manager,cookie))).status,200);
    assert.equal((await h.request('/api/debug/state',{headers:{Cookie:cookie}})).status,401);
    assert.ok(!(await (await h.request('/api/state',{headers:{Cookie:cookie}})).text()).includes('PRIVATE_'));
    const nextCookie=await login(h); now+=12*60*60*1000+1;
    assert.equal((await h.request('/api/debug/state',{headers:{Cookie:nextCookie}})).status,401);
  } finally {await h.close();}
});

test('a six-character judge code unlocks controls only through a protected session cookie',async()=>{
  const h=await harness({...options,judgeCode:'demo42'});
  try {
    assert.equal((await h.request('/api/auth/login',post({code:'demo43'}))).status,401);
    assert.equal((await h.request('/api/demo/start',post())).status,401);
    const response=await h.request('/api/auth/login',post({code:'demo42'}));
    assert.equal(response.status,200);
    const cookieHeader=response.headers.get('set-cookie')!;
    assert.match(cookieHeader,/^__Host-judge=[0-9a-f]{64};/);
    assert.match(cookieHeader,/HttpOnly; Secure; SameSite=Strict/);
    assert.ok(!cookieHeader.includes('demo42'));
    const cookie=cookieHeader.split(';')[0];
    assert.equal((await h.request('/api/demo/start',post({},manager,cookie))).status,200);
    assert.equal((await h.request('/api/debug/state',{headers:{Cookie:cookie}})).status,200);
    assert.equal((await h.request('/api/demo/start',post({},fixture,cookie))).status,403);
    assert.equal((await h.request('/api/demo/start',post({},manager,'__Host-judge=demo42'))).status,401);
    await h.request('/api/auth/logout',post({},manager,cookie));
    assert.equal((await h.request('/api/debug/state',{headers:{Cookie:cookie}})).status,401);
  } finally {await h.close();}
});

test('access-code guessing is limited and resumes after the bounded window',async()=>{
  let now=100;
  const h=await harness(options,()=>now);
  try {
    for(let i=0;i<8;i++) assert.equal((await h.request('/api/auth/login',post({code:'wrong'}))).status,401);
    const blocked=await h.request('/api/auth/login',post({code}));
    assert.equal(blocked.status,429);assert.ok(Number(blocked.headers.get('retry-after'))>0);
    now+=15*60*1000+1;await login(h);
  } finally {await h.close();}
});

test('fixture hostname exposes only demonstration pages and origin-bound submission',async()=>{
  const h=await harness();
  try {
    for(const route of ['/','/forum','/phishing','/admin','/demo/benign-event']) assert.equal((await h.request(route,{},'fixture.example')).status,200);
    for(const route of ['/debug','/api/state','/api/events','/api/debug/state','/api/auth/status','/health']) assert.equal((await h.request(route,{},'fixture.example')).status,404);
    const cookie=await login(h);
    assert.equal((await h.request('/api/demo/start',post({},fixture,cookie),'fixture.example')).status,404);
    assert.equal((await h.request('/api/mock/submit',post({},fixture),'fixture.example')).status,200);
    assert.equal((await h.request('/api/mock/submit',post({},manager),'fixture.example')).status,403);
    assert.equal((await h.request('/api/mock/submit',post({},manager,cookie))).status,404);
  } finally {await h.close();}
});

test('explicit fixture aliases retain strict host isolation and require their own mutation origin',async()=>{
  const h=await harness({...options,demoAliases:[alias]});
  try {
    for(const route of ['/','/forum','/phishing','/admin']) assert.equal((await h.request(route,{},'bank.example')).status,200);
    const cookie=await login(h);
    for(const route of ['/debug','/api/state','/api/events','/api/debug/state','/api/auth/status']) assert.equal((await h.request(route,{headers:{Cookie:cookie}},'bank.example')).status,404);
    assert.equal((await h.request('/api/demo/start',post({},alias,cookie),'bank.example')).status,404);
    assert.equal((await h.request('/api/mock/submit',post({},alias),'bank.example')).status,200);
    for(const origin of [fixture,manager,'https://bank.example.attacker.example','null']) assert.equal((await h.request('/api/mock/submit',post({},origin),'bank.example')).status,403);
    assert.equal((await h.request('/api/mock/submit',post({},alias),'fixture.example')).status,403);
    for(const host of ['other.example','bank.example.attacker.example','sub.bank.example']) assert.equal((await h.request('/phishing',{headers:{'X-Forwarded-Host':'bank.example'}},host)).status,403);
    const aliasConfig=await (await h.request('/api/public-config',{},'bank.example')).json();
    assert.equal(aliasConfig.siteMode,'phishing');assert.equal(aliasConfig.demoOrigin,alias);
    const primaryConfig=await (await h.request('/api/public-config',{},'fixture.example')).json();
    assert.equal(primaryConfig.demoOrigin,fixture);
    const managerConfig=await (await h.request('/api/public-config')).json();
    assert.equal(managerConfig.siteMode,'manager');assert.equal(managerConfig.demoOrigin,fixture);
    assert.equal(h.hosting.canResume(`${alias}/forum`),true);
    assert.equal(h.hosting.canResume(`${fixture}/forum`),true);
    assert.equal(h.hosting.canResume('https://other.example/forum'),false);
  } finally {await h.close();}
});

test('run ownership follows the first explicit configured fixture entry while public scans remain read-only',()=>{
  const h=createHosting({...options,demoAliases:[alias]});
  const ids=['scout','finch'];
  assert.deepEqual(h.prepareRun({scout:`${alias}/`,finch:'/forum'},ids),{
    seedUrl:`${alias}/forum`,entryPoints:{scout:`${alias}/`,finch:`${alias}/forum`},
  });
  assert.deepEqual(h.prepareRun({scout:'',finch:`${alias}/phishing`},ids),{
    seedUrl:`${alias}/forum`,entryPoints:{scout:'',finch:`${alias}/phishing`},
  });
  assert.deepEqual(h.prepareRun({scout:'https://example.com/feed?site=bank',finch:`${alias}/forum`},ids),{
    seedUrl:`${alias}/forum`,entryPoints:{scout:'https://example.com/feed?site=bank',finch:`${alias}/forum`},
  });
  assert.equal(h.prepareRun({scout:`${fixture}/forum`,finch:`${alias}/forum`},ids).seedUrl,`${fixture}/forum`);
  assert.equal(h.prepareRun({scout:'https://external.example/',finch:''},ids).seedUrl,`${fixture}/forum`);
  assert.equal(h.prepareRun({scout:'/forum',finch:''},ids).seedUrl,`${fixture}/forum`);
  assert.throws(()=>h.prepareRun({scout:'http://127.0.0.1:3210/forum',finch:''},ids));
  assert.throws(()=>h.prepareRun({scout:'',finch:''},ids));
  const local=createHosting({port:3210});
  assert.deepEqual(local.prepareRun({scout:'http://localhost:3210/forum',finch:''},ids),{
    seedUrl:'http://127.0.0.1:3210/forum',entryPoints:{scout:'http://127.0.0.1:3210/forum',finch:''},
  });
});

test('dedicated forum is read-only, links to the canonical bank, and redirects legacy forum URLs',async()=>{
  const h=await harness({...options,demoAliases:[alias],forumOrigin:forum});
  try {
    const cookie=await login(h);
    for(const route of ['/','/demo/benign-event','/demo/benign-news','/assets/index-a.js']) assert.equal((await h.request(route,{},'forum.example')).status,200);
    for(const route of ['/phishing','/admin','/debug','/api/state','/api/events','/api/debug/state','/api/auth/status','/health']) {
      assert.equal((await h.request(route,{headers:{Cookie:cookie}},'forum.example')).status,404,route);
    }
    for(const route of ['/api/mock/submit','/api/auth/login','/api/demo/start','/api/demo/stop','/api/demo/reset']) {
      assert.equal((await h.request(route,post({code},forum,cookie),'forum.example')).status,404,route);
    }
    const config=await (await h.request('/api/public-config',{},'forum.example')).json();
    assert.equal(config.siteMode,'forum');assert.equal(config.demoOrigin,fixture);
    assert.equal(config.forumOrigin,forum);assert.equal(config.forumUrl,`${forum}/`);
    const managerConfig=await (await h.request('/api/public-config')).json();
    assert.equal(managerConfig.forumUrl,`${forum}/`);assert.equal(managerConfig.demoOrigin,fixture);
    for(const host of ['fixture.example','bank.example','forum.example']) {
      const response=await h.request('/forum?topic=credit',{},host);
      assert.equal(response.status,302);assert.equal(response.headers.get('location'),`${forum}/?topic=credit`);
    }
    assert.equal((await h.request('/',{headers:{'X-Forwarded-Host':'forum.example'}},'other.example')).status,403);
    assert.equal(h.hosting.canResume(`${forum}/`),false);
  } finally {await h.close();}
});

test('forum discovery never changes the run submission origin or existing local forum behavior',async()=>{
  const hosted=createHosting({...options,demoAliases:[alias],forumOrigin:forum});
  assert.deepEqual(hosted.prepareRun({scout:`${forum}/`,finch:''},['scout','finch']),{
    seedUrl:`${fixture}/forum`,entryPoints:{scout:`${forum}/`,finch:''},
  });
  for(const legacy of [`${fixture}/forum?topic=credit`,`${alias}/forum?topic=credit`,'/forum?topic=credit']) {
    assert.deepEqual(hosted.prepareRun({scout:legacy,finch:''},['scout','finch']),{
      seedUrl:`${fixture}/forum`,entryPoints:{scout:`${forum}/?topic=credit`,finch:''},
    });
  }
  assert.deepEqual(hosted.prepareRun({scout:`${alias}/forum`,finch:`${alias}/phishing`},['scout','finch']),{
    seedUrl:`${alias}/forum`,entryPoints:{scout:`${forum}/`,finch:`${alias}/phishing`},
  });
  assert.deepEqual(hosted.prepareRun({scout:'https://external.example/forum?topic=credit',finch:''},['scout','finch']),{
    seedUrl:`${fixture}/forum`,entryPoints:{scout:'https://external.example/forum?topic=credit',finch:''},
  });
  assert.equal(hosted.prepareRun({scout:`${forum}/`,finch:`${alias}/phishing`},['scout','finch']).seedUrl,`${alias}/forum`);
  const local=await harness({port:3210});
  try {
    const response=await local.request('/forum',{},'127.0.0.1:3210');
    assert.equal(response.status,200);assert.equal(response.headers.get('location'),null);
    const config=await (await local.request('/api/public-config',{},'127.0.0.1:3210')).json();
    assert.equal(config.forumOrigin,'');assert.equal(config.forumUrl,'http://127.0.0.1:3210/forum');
  } finally {await local.close();}
});

test('production serves built pages/assets without exposing source, dotfiles, source maps, or arbitrary files',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'demo-static-'));
  const dist=path.join(temp,'dist');
  await mkdir(path.join(dist,'assets'),{recursive:true});
  await writeFile(path.join(dist,'index.html'),'<html>BUILT_PAGE</html>');
  await writeFile(path.join(dist,'assets','index-Ab12.js'),'BUILT_SCRIPT');
  await writeFile(path.join(dist,'assets','index-Ab12.js.map'),'PRIVATE_SOURCE_MAP');
  await writeFile(path.join(dist,'.env'),'PRIVATE_ENV');
  const h=await harness(options,Date.now,dist);
  try {
    assert.match(await (await h.request('/')).text(),/BUILT_PAGE/);
    assert.match(await (await h.request('/assets/index-Ab12.js')).text(),/BUILT_SCRIPT/);
    for(const route of ['/.env','/.local/admin-token','/server/config.ts','/src/main.tsx','/@vite/client','/@fs/etc/passwd','/assets/index-Ab12.js.map','/assets/%2e%2e%2f.env','/index.html','/package.json']) {
      const response=await h.request(route);assert.equal(response.status,404,route);assert.ok(!(await response.text()).includes('PRIVATE_'));
    }
    assert.equal((await h.request('/assets/index-Ab12.js',{},'fixture.example')).status,200);
    assert.equal((await h.request('/debug',{},'fixture.example')).status,404);
  } finally {await h.close();await rm(temp,{recursive:true,force:true});}
});

test('local development remains trusted while rejecting foreign hosts and cross-origin writes',async()=>{
  const h=await harness({port:3210});
  try {
    assert.equal((await h.request('/api/debug/state',{},'127.0.0.1:3210')).status,200);
    assert.equal((await h.request('/api/demo/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},'localhost:3210')).status,200);
    assert.equal((await h.request('/api/demo/start',post(), 'localhost:3210')).status,403);
    assert.equal((await h.request('/api/debug/state')).status,403);
  } finally {await h.close();}
});
