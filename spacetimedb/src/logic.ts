import { canonicalDemoUrl, type Agent, type Call, type DemoRun, type DemoState, type Persona, type Recipe, type Site } from '../../shared/contracts';
import ipaddr from 'ipaddr.js';

export type PrivateState = { admin: string; workerSecret: string; workers: Record<string, string> };
export type Context = { sender: string; now: number; random: () => number; uuid: () => string };
export const LEASE_MS = 60_000;

export function backendReaderAllowed(auth: PrivateState, sender: string): boolean {
  return sender===auth.admin || Object.values(auth.workers).includes(sender);
}

/** Projection of accepted receipts only; fixture starter numbers stay outside the DB. */
export function collectorPhoneRows(rows: Iterable<{data:string}>): {phone:string}[] {
  const phones=new Set<string>();
  for(const row of rows) {
    try {
      const phone=(JSON.parse(row.data) as {phone?:unknown}).phone;
      if(typeof phone==='string' && /^\+[1-9]\d{7,14}$/.test(phone)) phones.add(phone);
    } catch { /* A malformed legacy record must not break the collector view. */ }
  }
  return [...phones].sort().map(phone=>({phone}));
}

function fail(message: string): never { throw new Error(message); }
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object');
  return value as Record<string, any>;
}
function str(value: unknown, label: string, max = 500, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) fail(`Invalid ${label}`);
  return value;
}
function origin(url: string): string {
  return /^https?:\/\/[^/?#]+/.exec(canonicalDemoUrl(url, false))![0];
}
function siteUrl(url: string, run: DemoRun): string {
  return canonicalDemoUrl(url, origin(url) === origin(run.seedUrl));
}
function admin(auth: PrivateState, ctx: Context) { if (ctx.sender !== auth.admin) fail('Admin identity required'); }
function worker(auth: PrivateState, ctx: Context, agentId: string) {
  if (auth.workers[agentId] !== ctx.sender) fail('Registered worker identity required');
}
function active(state: DemoState, runId: string) {
  if (!state.run || state.run.id !== runId || state.run.status !== 'running') fail('This demo run is not active');
}
function log(state: DemoState, ctx: Context, agentId: string, kind: string, message: string) {
  state.events.push({ id: ctx.uuid(), runId: state.run?.id ?? '', agentId, kind, message, timestamp: ctx.now });
  if (state.events.length > 500) state.events.splice(0, state.events.length - 500);
}
function agent(state: DemoState, agentId: string): Agent {
  return state.agents.find(a => a.id === agentId) ?? fail('Unknown agent');
}
function entryPoints(run: DemoRun): Record<string, string> {
  return run.entryPoints ?? { scout: run.seedUrl, finch: '' };
}
/** Syntax/literal guard only; workers still validate and pin DNS for every actual GET. */
function publicUrl(value: unknown, label: string): string {
  const raw = str(value, label, 2000);
  if (/[\u0000-\u0020\u007f\\]/u.test(raw)) fail('Invalid public URL');
  const url = canonicalDemoUrl(raw, false);
  const match = /^https?:\/\/(\[[^\]]+\]|[^/?#:]+)(?::([0-9]+))?/.exec(url)!;
  const host = match[1].replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (match[2]) fail('Feed URLs require the standard HTTP or HTTPS port');
  if (host === 'localhost' || /\.(?:localhost|local|internal|lan|home)$/i.test(host)) fail('Feed URLs must use public hosts');
  if (ipaddr.isValid(host)) {
    const address = ipaddr.parse(host);
    if (address.range() !== 'unicast') fail('Feed URLs cannot use private or special-use addresses');
    if (address.kind() === 'ipv4') {
      if ((address as ipaddr.IPv4).match(ipaddr.IPv4.parseCIDR('198.18.0.0/15'))) fail('Feed URLs cannot use special-use addresses');
    } else {
      const v6 = address as ipaddr.IPv6;
      if (!v6.match(ipaddr.IPv6.parseCIDR('2000::/3')) || ['2001::/23','2001:db8::/32','2002::/16','3fff::/20'].some(cidr => v6.match(ipaddr.IPv6.parseCIDR(cidr)))) fail('Feed URLs cannot use special-use addresses');
    }
  } else if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) fail('Feed URLs require a public DNS hostname');
  return url;
}
function feedLabel(sourceUrl: string): string {
  return sourceUrl === 'https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt' ? 'OpenPhish' : 'URL feed';
}
function boundedStrings(value: unknown, label: string, count: number, length: number): string[] {
  if (!Array.isArray(value) || value.length > count) fail(`Invalid ${label}`);
  return value.map(item => str(item, label, length));
}

/** All authoritative demo rules run inside one SpacetimeDB reducer transaction. */
export function transition(state: DemoState, auth: PrivateState, ctx: Context, action: string, input: unknown): void {
  const p = object(input);
  if (action === 'configure') {
    admin(auth, ctx);
    if (!Array.isArray(p.personas) || p.personas.length !== 2) fail('Exactly two personas required');
    const ids = new Set<string>();
    const personas: Persona[] = p.personas.map((raw: unknown) => {
      const x = object(raw); const id = str(x.id, 'agent ID', 40);
      if (!['scout', 'finch'].includes(id) || ids.has(id)) fail('Use scout and finch exactly once');
      ids.add(id);
      const phone = str(x.phone, 'phone', 24, true);
      if (phone && !/^\+[1-9]\d{6,14}$/.test(phone) && !/^DEMO-[A-Z0-9-]+$/.test(phone)) fail('Use E.164 or an explicitly marked DEMO number');
      return { id, name: str(x.name, 'name', 100), character: str(x.character, 'character', 1500), phone,
        voiceAgentId: str(x.voiceAgentId, 'voice agent', 150, true),
        voiceReady: x.voiceReady === true, color: str(x.color, 'color', 30) };
    });
    const workerSecret = str(p.workerSecret, 'worker secret', 256);
    if (workerSecret.length < 24) fail('Worker secret must contain at least 24 characters');
    for (const id of Object.keys(auth.workers)) if (!ids.has(id)) delete auth.workers[id];
    const unchanged = auth.workerSecret === workerSecret && state.agents.length === 2 && personas.every(p => {
      const previous = state.agents.find(a => a.id === p.id);
      return previous && !('marker' in previous) && Object.keys(p).every(key => previous[key as keyof Persona] === p[key as keyof Persona]);
    });
    if (unchanged) return;
    if (state.run?.status === 'running') fail('Stop the run before changing personas');
    auth.workerSecret = workerSecret;
    state.agents = personas.map(a => ({ ...a, status: 'idle', heartbeatAt: ctx.now }));
    return;
  }
  if (action === 'register_worker') {
    const agentId = str(p.agentId, 'agent ID', 40); agent(state, agentId);
    if (!auth.workerSecret || p.workerSecret !== auth.workerSecret) fail('Invalid worker credential');
    if (auth.workers[agentId] && auth.workers[agentId] !== ctx.sender) fail('Worker ID already belongs to another identity');
    auth.workers[agentId] = ctx.sender;
    return;
  }
  if (action === 'start_run') {
    admin(auth, ctx);
    const runId = str(p.runId, 'run ID', 100);
    if (state.run?.id === runId) return;
    const seedUrl = canonicalDemoUrl(str(p.seedUrl, 'seed URL', 2000));
    const mode = p.mode ?? 'rehearsal';
    if (!['live', 'rehearsal'].includes(mode)) fail('Invalid discovery mode');
    if (state.run?.status === 'running') fail('A run is already active');
    if (state.agents.length !== 2) fail('Configure two agents first');
    const requested = object(p.entryPoints); const points: Record<string, string> = {};
    if (Object.keys(requested).some(id => !state.agents.some(a => a.id === id))) fail('Unknown entry-point agent');
    for (const a of state.agents) {
      const value = str(requested[a.id] ?? '', 'entry point', 2000, true).trim();
      points[a.id] = value ? canonicalDemoUrl(value, origin(value) === origin(seedUrl)) : '';
    }
    if (!Object.values(points).some(Boolean)) fail('At least one entry point is required');
    state.run = { id: runId, status: 'running', seedUrl, startedAt: ctx.now, entryPoints: points, discoveryCompleteIds: [], mode };
    state.sites = []; state.jobs = []; state.submissions = []; state.calls = []; state.events = [];
    state.agents.forEach(a => { a.status = points[a.id] ? 'discovering' : 'waiting'; });
    log(state, ctx, '', 'run_started', 'Demo started. Agents with entry points are scanning; other agents wait for shared jobs.');
    return;
  }
  if (action === 'stop_run' || action === 'reset') {
    admin(auth, ctx);
    if (action === 'reset') {
      state.run = null; state.sites = []; state.jobs = []; state.submissions = []; state.calls = []; state.events = [];
    } else if (state.run) { state.run.status = 'stopped'; log(state, ctx, '', 'stopped', 'Demo stopped. No further submissions will be accepted.'); }
    state.agents.forEach(a => { a.status = 'idle'; });
    return;
  }
  if (action === 'call_event') {
    admin(auth, ctx);
    const c = object(p.call);
    if (!state.run || c.runId !== state.run.id) fail('Call belongs to another demo run');
    const a = agent(state, str(c.agentId, 'agent ID', 40));
    str(c.id, 'call ID', 150); str(c.status, 'call status', 50);
    if (!['none', 'possible', 'verified'].includes(c.matchStatus)) fail('Invalid match status');
    if (!Array.isArray(c.transcript) || c.transcript.length > 200) fail('Invalid transcript');
    c.transcript.forEach((t: unknown) => { const v = object(t); str(v.role, 'transcript role', 30); str(v.message, 'transcript message', 5000, true); });
    if (!Number.isFinite(c.startedAt) || !Number.isFinite(c.durationSeconds) || c.durationSeconds < 0) fail('Invalid call timestamps');
    str(c.summary, 'summary', 5000, true); str(c.evidence, 'evidence', 2000, true); str(c.matchedSiteId, 'matched site', 100, true);
    if (c.matchedSiteId && !state.sites.some(s => s.id === c.matchedSiteId)) fail('Unknown matched site');
    const existing = state.calls.findIndex(x => x.id === c.id);
    // Concurrent live-tool delivery may have read state before the signed final webhook.
    // A late provisional write must never downgrade completed or verified evidence.
    if (existing >= 0) {
      const previous = state.calls[existing];
      if (previous.status === 'completed' && c.status !== 'completed') return;
      if (c.status !== 'completed' && previous.matchStatus !== 'none' && c.matchStatus === 'none') return;
    }
    if (existing >= 0) state.calls[existing] = c as Call; else state.calls.push(c as Call);
    a.status = ['ended', 'completed', 'failed'].includes(c.status) ? 'ready' : 'in call';
    return;
  }
  const runId = str(p.runId, 'run ID', 100);
  const agentId = str(p.agentId, 'agent ID', 40);
  const a = agent(state, agentId);
  if (action === 'accept_submission') {
    admin(auth, ctx);
    const siteId = str(p.siteId, 'site ID', 100);
    const id = `${runId}:${siteId}:${agentId}`;
    if (!state.run || state.run.id !== runId) fail('Submission belongs to another run');
    if (p.name !== a.name || p.phone !== a.phone) fail('Submission must use this agent’s configured demo alias');
    if (state.submissions.some(s => s.id === id)) return;
    active(state, runId);
    const site = state.sites.find(site => site.id === siteId && site.runId === runId) ?? fail('Unknown site');
    if (site.submissionAllowed === false || origin(site.url) !== origin(state.run!.seedUrl)) fail('Observation-only sites do not accept submissions');
    const j = state.jobs.find(x => x.id === id) ?? fail('No submission job');
    if (j.status !== 'claimed' || j.leaseUntil < ctx.now) fail('Claim the job before submitting');
    state.submissions.push({ id, runId, siteId, agentId, name: a.name, phone: a.phone, receivedAt: ctx.now });
    j.receiptId = id;
    log(state, ctx, agentId, 'form_accepted', `${a.name} appeared in the demonstration site's admin panel.`);
    return;
  }
  // Late logging and heartbeats after a completed run are harmless; previous runs are not.
  if (action === 'agent_status' || action === 'event') {
    if (ctx.sender !== auth.admin) worker(auth, ctx, agentId);
    if (!state.run || state.run.id !== runId) fail('This demo run is no longer current');
    if (action === 'agent_status') { a.status = str(p.status, 'status', 100); a.heartbeatAt = ctx.now; }
    else log(state, ctx, agentId, str(p.kind, 'event kind', 60), str(p.message, 'event message', 3000));
    return;
  }
  worker(auth, ctx, agentId);
  if (action === 'report_feed') {
    active(state, runId);
    const suppliedSource = str(p.sourceUrl, 'feed source URL', 2000);
    const source = publicUrl(suppliedSource, 'feed source URL');
    if (origin(source) === origin(state.run!.seedUrl)) fail('Feed sources must be external');
    if (!Array.isArray(p.urls) || p.urls.length === 0 || p.urls.length > 50) fail('Feed reports require 1 to 50 URLs');
    const urls = [...new Set<string>(p.urls.map((value: unknown) => publicUrl(value, 'reported URL')))];
    if (urls.some(url => origin(url) === origin(state.run!.seedUrl))) fail('Feed targets must be external');
    let added = 0; let attached = 0;
    for (const url of urls) {
      const existing = state.sites.find(site => site.runId === runId && canonicalDemoUrl(site.url, false) === url);
      if (existing) {
        if (!existing.sourceUrl) {
          existing.sourceUrl = suppliedSource; existing.sourceLabel = feedLabel(suppliedSource);
          if (!existing.inspectionStatus) existing.inspectionStatus = existing.analysisMode !== 'feed' && existing.status === 'observed' ? 'inspected' : 'pending';
          attached++;
        }
        continue;
      }
      state.sites.push({id:`feed-${ctx.uuid()}`,runId,url,title:'Feed-reported URL',evidence:[],confidence:'unassessed',recipe:null,status:'reported',discoveredBy:agentId,verifiedAt:0,analysisMode:'feed',submissionAllowed:false,observedFields:[],sourceUrl:suppliedSource,sourceLabel:feedLabel(suppliedSource),inspectionStatus:'pending',inspectionMessage:'Listed in a source feed; the destination has not been inspected.'});
      added++;
    }
    if (added || attached) log(state,ctx,agentId,'feed_reported',`Recorded ${added} new feed-reported URLs and attached feed attribution to ${attached} existing findings. Destinations require separate inspection.`);
    return;
  }
  if (action === 'inspect_site') {
    active(state, runId);
    const allowed = new Set(['runId','agentId','siteId','inspectionStatus','inspectionMessage','title','observedFields','observedButtons','observedFormAction','analysisMode','confidence','evidence']);
    if (Object.keys(p).some(key => !allowed.has(key))) fail('Unsupported inspection fields');
    const siteId = str(p.siteId,'site ID',100);
    const site = state.sites.find(site => site.id === siteId && site.runId === runId) ?? fail('Unknown site');
    if (origin(site.url) === origin(state.run!.seedUrl)) fail('Only external observation-only sites can be inspected');
    const inspection = str(p.inspectionStatus,'inspection status',40);
    if (!['inspecting','inspected','unavailable','analysis_failed','not_flagged'].includes(inspection)) fail('Invalid inspection status');
    const finalAnalysis = inspection === 'inspected' || inspection === 'not_flagged';
    if (finalAnalysis && (!['model','fixture'].includes(p.analysisMode) || !['high','medium','low'].includes(p.confidence))) fail('Completed inspection requires a model or rule decision and confidence');
    if (!finalAnalysis && (p.analysisMode !== undefined || p.confidence !== undefined || p.evidence !== undefined)) fail('Incomplete inspections cannot claim analysis results');
    const evidence = finalAnalysis ? boundedStrings(p.evidence ?? [],'inspection evidence',10,1000) : [];
    if (inspection === 'inspected' && !evidence.length) fail('An inspected review candidate requires evidence');
    const fields = p.observedFields === undefined ? undefined : boundedStrings(p.observedFields,'observed fields',40,100);
    const buttons = p.observedButtons === undefined ? undefined : boundedStrings(p.observedButtons,'observed buttons',20,100);
    const title = p.title === undefined ? undefined : str(p.title,'site title',200);
    const formAction = p.observedFormAction === undefined ? undefined : str(p.observedFormAction,'observed form action',2000,true);
    const message = p.inspectionMessage === undefined ? undefined : str(p.inspectionMessage,'inspection message',1000);
    const previous = site.inspectionStatus ?? (site.analysisMode !== 'feed' && site.status === 'observed' ? 'inspected' : 'pending');
    // Two peers may race. A late error must not erase a successful inspection.
    if ((['inspected','not_flagged'].includes(previous) && !finalAnalysis) || (previous === 'inspected' && inspection === 'not_flagged')) return;
    site.recipe = null; site.submissionAllowed = false; site.verifiedAt = 0;
    site.inspectionStatus = inspection as NonNullable<Site['inspectionStatus']>;
    const messages: Record<string,string> = {inspecting:'Inspecting the reported destination.',inspected:'The inspected page is a candidate for review.',unavailable:'The destination could not be fetched.',analysis_failed:'The page was fetched, but analysis did not complete.',not_flagged:'The inspected page was not flagged by analysis.'};
    site.inspectionMessage = message ?? messages[inspection];
    if (title !== undefined) site.title = title;
    if (fields !== undefined) site.observedFields = fields;
    if (buttons !== undefined) site.observedButtons = buttons;
    if (formAction !== undefined) site.observedFormAction = formAction;
    if (finalAnalysis) {
      site.analysisMode = p.analysisMode; site.confidence = p.confidence; site.evidence = evidence;
      site.status = inspection === 'inspected' ? 'observed' : 'reported';
    }
    return;
  }
  if (action === 'discovery_complete') {
    if (!state.run || state.run.id !== runId) fail('This demo run is no longer current');
    if (state.run.discoveryCompleteIds?.includes(agentId)) return;
    active(state, runId);
    state.run.discoveryCompleteIds = [...state.run.discoveryCompleteIds ?? [], agentId];
    log(state, ctx, agentId, 'discovery_complete', entryPoints(state.run!)[agentId] ? `${a.name} finished scanning the assigned entry point.` : `${a.name} is waiting for shared submission jobs.`);
    return;
  }
  if (action === 'discover_site') {
    const x = object(p.site); const id = str(x.id, 'site ID', 100);
    if (!state.run || state.run.id !== runId) fail('This demo run is no longer current');
    const url = siteUrl(str(x.url, 'site URL', 2000), state.run);
    if (state.sites.some(site => site.id === id && (site.runId !== runId || siteUrl(site.url, state.run!) !== url))) fail('Site ID already belongs to a different URL');
    // Reducer transactions serialize races. The first discovered URL retains its owner and recipe.
    if (state.sites.some(site => site.runId === runId && siteUrl(site.url, state.run!) === url)) return;
    active(state, runId);
    if (!entryPoints(state.run!)[agentId]) fail('This agent has no discovery entry point');
    const submissionAllowed = origin(url) === origin(state.run!.seedUrl) && x.submissionAllowed !== false;
    let recipe: Recipe|null = null;
    if (submissionAllowed) {
      const supplied = object(x.recipe);
      if (canonicalDemoUrl(str(supplied.url, 'recipe URL', 2000)) !== url || !Array.isArray(supplied.fields) || supplied.fields.length !== 2) fail('Invalid two-field form recipe');
      const values = new Set<string>(); const labels = new Set<string>();
      const fields: Recipe['fields'] = supplied.fields.map((raw: unknown) => {
        const field = object(raw); const label = str(field.label, 'field label', 100);
        if (!['name','phone'].includes(field.valueFrom) || values.has(field.valueFrom) || labels.has(label)) fail('Invalid recipe field');
        values.add(field.valueFrom); labels.add(label); return { label, valueFrom: field.valueFrom };
      });
      recipe = { url, fields, submitLabel: str(supplied.submitLabel, 'submit label', 100), successText: str(supplied.successText, 'success text', 300) };
    }
    if (x.observedFields !== undefined && (!Array.isArray(x.observedFields) || x.observedFields.length > 40)) fail('Invalid observed fields');
    const observedFields = (x.observedFields ?? []).map((field: unknown) => str(field, 'observed field', 100));
    if (!Array.isArray(x.evidence) || x.evidence.length > 10) fail('Invalid evidence');
    x.evidence.forEach((v: unknown) => str(v, 'evidence', 1000));
    const site: Site = { id, runId, url, title: str(x.title, 'site title', 200), evidence: x.evidence,
      confidence: str(x.confidence, 'confidence', 100), recipe, status: submissionAllowed ? 'discovered' : 'observed',
      discoveredBy: agentId, verifiedAt: 0, analysisMode: x.analysisMode === 'model' ? 'model' : 'fixture', submissionAllowed, observedFields };
    state.sites.push(site);
    // A scan report is telemetry, not an end to this agent's ongoing discovery.
    state.run!.discoveryCompleteIds = state.run!.discoveryCompleteIds?.filter(id => id !== agentId) ?? [];
    if (submissionAllowed) state.jobs.push({ id: `${runId}:${id}:${agentId}`, runId, siteId: id, agentId, dueAt: ctx.now, status: 'pending', leaseUntil: 0, receiptId: '' });
    log(state, ctx, agentId, 'site_discovered', submissionAllowed ? `${a.name} discovered ${site.title} and a name-and-phone submission form.` : `${a.name} observed ${site.title}. No submission is permitted for this site.`);
    return;
  }
  if (action === 'publish_site') {
    const siteId = str(p.siteId, 'site ID', 100);
    if (!state.run || state.run.id !== runId) fail('This demo run is no longer current');
    const s = state.sites.find(x => x.id === siteId && x.runId === runId) ?? fail('Unknown site');
    if (s.submissionAllowed === false || origin(s.url) !== origin(state.run.seedUrl)) fail('Observation-only sites cannot be published for submission');
    if (s.discoveredBy !== agentId) fail('Only the original discoverer can publish this site');
    if (s.status === 'verified') return;
    active(state, runId);
    const receiptId = `${runId}:${siteId}:${agentId}`;
    if (!state.submissions.some(x => x.id === receiptId)) fail('Discoverer submission must be accepted before broadcasting');
    s.status = 'verified'; s.verifiedAt = ctx.now;
    const originalJob = state.jobs.find(x => x.id === receiptId) ?? fail('Discoverer job is missing');
    originalJob.status = 'succeeded'; originalJob.receiptId = receiptId; originalJob.leaseUntil = 0;
    for (const peer of state.agents.filter(x => x.id !== agentId)) {
      const id = `${runId}:${siteId}:${peer.id}`;
      if (state.jobs.some(job => job.id === id)) continue;
      const dueAt = ctx.now + 5000 + Math.floor(ctx.random() * 5001);
      state.jobs.push({ id, runId, siteId, agentId: peer.id, dueAt, status: 'scheduled', leaseUntil: 0, receiptId: '' });
    }
    log(state, ctx, agentId, 'recipe_shared', 'Verified form recipe shared through SpacetimeDB; other agents’ submissions scheduled.');
    return;
  }
  if (action === 'claim_job' || action === 'complete_job') {
    const jobId = str(p.jobId, 'job ID', 250);
    const j = state.jobs.find(x => x.id === jobId && x.runId === runId && x.agentId === agentId) ?? fail('Unknown job for this worker');
    if (j.status === 'succeeded') return;
    active(state, runId);
    if (action === 'claim_job') {
      if (ctx.now < j.dueAt) fail('Job is not due yet');
      if (j.status === 'claimed' && j.leaseUntil > ctx.now) fail('Job has an active lease');
      if (j.status !== 'pending') fail('Wait for the database scheduler to release this job');
      j.status = 'claimed'; j.leaseUntil = ctx.now + LEASE_MS;
    } else {
      if (p.receiptId !== j.id || !state.submissions.some(x => x.id === p.receiptId)) fail('A verified acceptance receipt is required');
      j.status = 'succeeded'; j.receiptId = p.receiptId; j.leaseUntil = 0; a.status = 'ready';
    }
    return;
  }
  fail(`Unknown action: ${action}`);
}
