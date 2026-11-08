import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WebhooksClient } from '@elevenlabs/elevenlabs-js/wrapper/webhooks.js';
import { EMPTY_STATE, type AppSnapshot, type DemoState } from '../shared/contracts.js';
import { modelDemoReady, modelDemoStartMessage } from '../shared/readiness.js';
import { adminToken, baseUrl, databaseHost, databaseName, localDir, personas, port, publicUrl, root, voiceToolSecret, webhookPort, workerSecret } from './config.js';
import { buildCall, callRunStatus, findAgent, observedCallStart, parseTranscript, possibleMatch, verifiedMatch } from './calls.js';
import { connectStore } from './store.js';
import { setupRouter } from './setup.js';
import { demoMode } from './demo-mode.js';

type Store = Awaited<ReturnType<typeof connectStore>>;
let store: Store|undefined;
let mode: 'live'|'rehearsal' = 'rehearsal';
let connecting = false;
const children = new Map<string,ChildProcess>();
const listeners = new Set<Response>();

function state(): DemoState { return store?.snapshot() || EMPTY_STATE; }
function snapshot(): AppSnapshot {
  const current = state();
  const profiles = current.agents.length ? current.agents : personas().map(item=>({...item,status:'idle',heartbeatAt:0}));
  return {...current,agents:profiles,setup:{
    database:{connected:Boolean(store?.connected),host:databaseHost,name:databaseName},
    model:{configured:Boolean(process.env.MODEL_API_KEY && process.env.MODEL_NAME && process.env.MODEL_BASE_URL),provider:process.env.MODEL_NAME || 'Not connected'},
    voice:{configured:profiles.filter(item=>item.voiceReady).length,total:3,webhookReady:Boolean(publicUrl() && process.env.ELEVENLABS_WEBHOOK_SECRET)},
    publicUrl:publicUrl(),mode:demoMode(current,mode)
  }};
}
function broadcast() {
  const message = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const response of listeners) response.write(message);
}
async function connectDatabase() {
  if (connecting || store) return;
  connecting = true;
  let connection: Store|undefined;
  try {
    connection = await connectStore({host:databaseHost,database:databaseName,token:adminToken()});
    await connection.dispatch('configure',{personas:personas(),workerSecret});
    store = connection;
    if (connection.token && !adminToken()) writeFileSync(path.join(localDir,'admin-token'),connection.token,{mode:0o600});
    store.subscribe(()=>broadcast());
    console.log(`Connected to SpacetimeDB: ${databaseName}`);
    broadcast();
  } catch (error) {
    connection?.close();
    console.warn(`Database not ready: ${error instanceof Error ? error.message : 'connection failed'}`);
  } finally { connecting = false; }
}
function requireStore(): Store {
  if (!store?.connected) throw new Error('SpacetimeDB is not connected yet.');
  return store;
}
function stopWorkers() {
  for (const child of children.values()) child.kill('SIGTERM');
  children.clear();
}
function startWorkers(runId:string) {
  for (const agentId of ['scout','finch','wren']) {
    const child=spawn(process.execPath,['--import','tsx','workers/agent.ts','--agent',agentId,'--run',runId,'--base',baseUrl,'--mode',mode],{
      cwd:root,env:{...process.env,WORKER_SECRET:workerSecret,SPACETIMEDB_HOST:databaseHost,SPACETIMEDB_DATABASE:databaseName},stdio:['ignore','pipe','pipe']
    });
    children.set(agentId,child);
    for (const stream of [child.stdout,child.stderr]) stream?.on('data',(chunk:Buffer)=>process.stdout.write(`[${agentId}] ${chunk.toString()}`));
    child.on('exit',(code)=>{
      if (children.get(agentId)===child) children.delete(agentId);
      if (code && store && state().run?.id===runId && state().run?.status==='running') {
        void store.dispatch('event',{runId,agentId,kind:'error',message:`Worker stopped with an error. Check its activity log.`}).catch(()=>{});
      }
    });
  }
}
function localOnly(req:Request,res:Response,next:NextFunction) {
  const ip=req.socket.remoteAddress;
  const host=req.headers.host;
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip || '') || ![`127.0.0.1:${port}`,`localhost:${port}`].includes(host || '')) {
    res.status(403).json({error:'Demo controls are available on this laptop only.'}); return;
  }
  if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
    const origin=req.headers.origin;
    if (origin && ![baseUrl,`http://localhost:${port}`].includes(origin)) {res.status(403).json({error:'Origin is not allowed.'});return;}
  }
  next();
}
const app=express();
app.disable('x-powered-by');
app.use(localOnly);
app.use(express.json({limit:'32kb'}));
app.use(express.urlencoded({extended:false,limit:'32kb'}));
app.use(setupRouter);
app.get('/api/state',(_req,res)=>res.json(snapshot()));
app.get('/api/events',(req,res)=>{
  res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
  res.flushHeaders(); listeners.add(res);
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  const keepAlive=setInterval(()=>res.write(': keepalive\n\n'),20000);
  req.on('close',()=>{clearInterval(keepAlive);listeners.delete(res);});
});
app.post('/api/demo/start',async(req,res)=>{
  const db=requireStore();
  if (state().run?.status==='running') {res.status(409).json({error:'A demo is already running.'});return;}
  const requested=req.body?.mode;
  if (!['live','rehearsal'].includes(requested)) {res.status(400).json({error:'Choose live or rehearsal mode.'});return;}
  const readiness=snapshot().setup;
  if (requested==='live' && !modelDemoReady(readiness)) {
    res.status(409).json({error:'The model demo requires a connected database and configured discovery model. Rehearsal uses fixed rules.'});return;
  }
  stopWorkers(); mode=requested;
  const runId=randomUUID();
  await db.dispatch('start_run',{runId,seedUrl:`${baseUrl}/forum`});
  await db.dispatch('event',{runId,agentId:'scout',kind:'system',message:mode==='rehearsal'?'Rehearsal started. Detection uses explicit fixture rules; unprovisioned phone fields stay marked as demo data.':modelDemoStartMessage(readiness)});
  startWorkers(runId); broadcast(); res.json({ok:true,runId});
});
app.post('/api/demo/stop',async(_req,res)=>{
  await requireStore().dispatch('stop_run',{});stopWorkers();broadcast();res.json({ok:true});
});
app.post('/api/demo/reset',async(_req,res)=>{
  stopWorkers();await requireStore().dispatch('reset',{});broadcast();res.json({ok:true});
});
app.post('/api/sim/start',async(req,res)=>{
  const db=requireStore();
  const body=req.body || {};
  const seed=Number(body.seed);
  const personaCount=Number(body.personaCount);
  const siteCount=Number(body.siteCount);
  const ringCount=Number(body.ringCount);
  if (!Number.isInteger(seed) || seed<0 || seed>Number.MAX_SAFE_INTEGER) {res.status(400).json({error:'Seed must be a whole number between 0 and 2^53.'});return;}
  for (const [label,value,min,max] of [['Persona count',personaCount,1,400],['Site count',siteCount,1,60],['Ring count',ringCount,1,12]] as const) {
    if (!Number.isInteger(value) || value<min || value>max) {res.status(400).json({error:`${label} must be a whole number between ${min} and ${max}.`});return;}
  }
  try {await db.startSimulation({seed,personaCount,siteCount,ringCount});broadcast();res.json({ok:true});}
  catch(error) {res.status(400).json({error:error instanceof Error ? error.message : 'The simulation could not be started.'});}
});
app.post('/api/sim/stop',async(_req,res)=>{
  try {await requireStore().stopSimulation();broadcast();res.json({ok:true});}
  catch(error) {res.status(400).json({error:error instanceof Error ? error.message : 'The simulation could not be stopped.'});}
});
app.post('/api/mock/submit',async(req,res)=>{
  const body=req.body || {};
  for (const key of ['runId','siteId','agentId','name','phone','marker']) {
    if (typeof body[key]!=='string' || body[key].length>500 || !body[key].trim()) {res.status(400).json({error:`Missing or invalid ${key}.`});return;}
  }
  const db=requireStore();
  await db.dispatch('accept_submission',{runId:body.runId,siteId:body.siteId,agentId:body.agentId,name:body.name,phone:body.phone,marker:body.marker});
  const receipt=db.snapshot().submissions.find(item=>item.runId===body.runId && item.siteId===body.siteId && item.agentId===body.agentId);
  res.json({ok:true,message:'Your request has been received',receiptId:receipt?.id || `${body.runId}:${body.siteId}:${body.agentId}`});
});
app.post('/api/setup/reload',async(_req,res)=>{
  await requireStore().dispatch('configure',{personas:personas(),workerSecret});broadcast();res.json({ok:true});
});

const hooks=express();hooks.disable('x-powered-by');
hooks.get('/health',(_req,res)=>res.json({service:'Honeyline call events',ready:Boolean(store?.connected)}));
const webhookVerifier=new WebhooksClient({apiKey:process.env.ELEVENLABS_API_KEY});
hooks.post('/webhooks/elevenlabs/post-call',express.raw({type:'application/json',limit:'2mb'}),async(req,res)=>{
  const secret=process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) {res.status(503).json({error:'Post-call verification is not configured.'});return;}
  let event:any;
  try {event=await webhookVerifier.constructEvent(req.body.toString('utf8'),req.get('ElevenLabs-Signature') || '',secret);}
  catch {res.status(401).json({error:'Invalid webhook signature.'});return;}
  if (event.type!=='post_call_transcription') {res.json({received:true});return;}
  const db=requireStore();const current=db.snapshot();const data=event.data || {};
  const agent=findAgent(current,String(data.agent_id || ''));
  if (!agent || !data.conversation_id) {res.status(400).json({error:'Unknown demo agent or conversation.'});return;}
  const runStatus=callRunStatus(current,String(data.conversation_id),data.metadata?.start_time_unix_secs);
  if (runStatus==='old') {res.json({received:true,ignored:'Call predates the current demo run.'});return;}
  if (runStatus==='unknown') {res.status(409).json({error:'A current run and call start timestamp are required.'});return;}
  const call=buildCall(current,agent,String(data.conversation_id));
  if (!call.runId) {res.status(409).json({error:'Start a demo run before calling.'});return;}
  call.transcript=parseTranscript(data.transcript);
  call.status='completed';
  call.durationSeconds=Math.max(0,Number(data.metadata?.call_duration_secs) || 0);
  if (data.metadata?.start_time_unix_secs) call.startedAt=Number(data.metadata.start_time_unix_secs)*1000;
  call.summary=typeof data.analysis?.transcript_summary==='string'?data.analysis.transcript_summary.slice(0,4000):'';
  const match=verifiedMatch(call.transcript,current.submissions.filter(row=>row.runId===call.runId && row.agentId===agent.id));
  call.matchStatus=match?'verified':'none';call.matchedSiteId=match?.submission.siteId || '';call.evidence=match?.evidence || '';
  await db.dispatch('call_event',{call});broadcast();res.json({received:true});
});
hooks.post('/webhooks/elevenlabs/observed',express.json({limit:'8kb'}),async(req,res)=>{
  const token=(req.get('Authorization') || '').replace(/^Bearer /,'');
  const provided=Buffer.from(token);const expected=Buffer.from(voiceToolSecret);
  if (provided.length!==expected.length || !timingSafeEqual(provided,expected)) {res.status(401).json({error:'Unauthorized.'});return;}
  const {conversation_id,agent_id,observed_text,observed_at,call_duration_seconds}=req.body || {};
  if (typeof conversation_id!=='string' || typeof agent_id!=='string' || typeof observed_text!=='string' || observed_text.length>1000) {res.status(400).json({error:'Invalid observation.'});return;}
  const startedAt=observedCallStart(observed_at,call_duration_seconds);
  if (startedAt===undefined) {res.status(400).json({error:'Valid platform observation time and call duration are required.'});return;}
  const db=requireStore();const current=db.snapshot();const agent=findAgent(current,agent_id);
  if (!agent || !current.run) {res.status(409).json({error:'No active demo profile.'});return;}
  if (callRunStatus(current,conversation_id,startedAt)==='old') {res.json({received:true,ignored:'Call predates the current demo run.'});return;}
  const call=buildCall(current,agent,conversation_id);
  if (call.status==='completed') {res.json({received:true});return;}
  if (!current.calls.some(item=>item.id===conversation_id)) call.startedAt=startedAt*1000;
  call.durationSeconds=Math.max(call.durationSeconds,call_duration_seconds);
  const match=possibleMatch(observed_text,current.submissions.filter(row=>row.runId===call.runId && row.agentId===agent.id));
  if (match) {call.matchStatus='possible';call.matchedSiteId=match.siteId;call.evidence=observed_text;}
  await db.dispatch('call_event',{call});broadcast();res.json({received:true,possible_match:Boolean(match),instruction:'Continue the conversation naturally. Do not disclose internal matching or reference markers.'});
});
function errorHandler(error:unknown,_req:Request,res:Response,_next:NextFunction) {
  res.status(400).json({error:error instanceof Error ? error.message : 'The request could not be completed.'});
}
hooks.use(errorHandler);

const vite=await createViteServer({server:{middlewareMode:true,host:'127.0.0.1'},appType:'custom'});
app.use(vite.middlewares);
app.get('/{*path}',async(req,res,next)=>{
  try {
    const filename=path.join(root,'index.html');
    if (!existsSync(filename)) {res.status(503).send('The demo is starting. Please refresh shortly.');return;}
    const html=await vite.transformIndexHtml(req.originalUrl,readFileSync(filename,'utf8'));
    res.status(200).type('html').send(html);
  } catch(error) {next(error);}
});
app.use(errorHandler);
const localServer=app.listen(port,'127.0.0.1',()=>console.log(`Agent manager: ${baseUrl}`));
const webhookServer=hooks.listen(webhookPort,'127.0.0.1',()=>console.log(`Call event adapter: http://127.0.0.1:${webhookPort}`));
void connectDatabase();
const reconnect=setInterval(()=>void connectDatabase(),5000);
const shutdown=async()=>{clearInterval(reconnect);stopWorkers();for(const res of listeners)res.end();store?.close();await vite.close();localServer.close();webhookServer.close();process.exit(0);};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
