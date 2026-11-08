import type { Agent, Call, DemoState, Persona, Site } from '../../shared/contracts';

export type PrivateState = { admin: string; workerSecret: string; workers: Record<string, string> };
export type Context = { sender: string; now: number; random: () => number; uuid: () => string };
export const LEASE_MS = 60_000;

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
  return /^https?:\/\/[^/?#]+/i.exec(url)?.[0].toLowerCase() ?? fail('Only HTTP demo URLs are accepted');
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
function maybeComplete(state: DemoState, ctx: Context) {
  if (state.jobs.length === 3 && state.jobs.every(j => j.status === 'succeeded') && state.run?.status === 'running') {
    state.run.status = 'complete';
    log(state, ctx, '', 'complete', 'All three agents have confirmed browser submissions.');
  }
}

/** All authoritative demo rules run inside one SpacetimeDB reducer transaction. */
export function transition(state: DemoState, auth: PrivateState, ctx: Context, action: string, input: unknown): void {
  const p = object(input);
  if (action === 'configure') {
    admin(auth, ctx);
    if (!Array.isArray(p.personas) || p.personas.length !== 3) fail('Exactly three personas required');
    const ids = new Set<string>();
    const personas: Persona[] = p.personas.map((raw: unknown) => {
      const x = object(raw); const id = str(x.id, 'agent ID', 40);
      if (!['scout', 'finch', 'wren'].includes(id) || ids.has(id)) fail('Use scout, finch and wren exactly once');
      ids.add(id);
      const phone = str(x.phone, 'phone', 24, true);
      if (phone && !/^\+[1-9]\d{6,14}$/.test(phone) && !/^DEMO-[A-Z0-9-]+$/.test(phone)) fail('Use E.164 or an explicitly marked DEMO number');
      return { id, name: str(x.name, 'name', 100), character: str(x.character, 'character', 1500), phone,
        marker: str(x.marker, 'marker', 100), voiceAgentId: str(x.voiceAgentId, 'voice agent', 150, true),
        voiceReady: x.voiceReady === true, color: str(x.color, 'color', 30) };
    });
    if (new Set(personas.map(a => a.marker.toLowerCase())).size !== 3) fail('Markers must be unique');
    const workerSecret = str(p.workerSecret, 'worker secret', 256);
    if (workerSecret.length < 24) fail('Worker secret must contain at least 24 characters');
    const unchanged = auth.workerSecret === workerSecret && state.agents.length === 3 && personas.every(p => {
      const previous = state.agents.find(a => a.id === p.id);
      return previous && Object.keys(p).every(key => previous[key as keyof Persona] === p[key as keyof Persona]);
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
    const runId = str(p.runId, 'run ID', 100); const seedUrl = str(p.seedUrl, 'seed URL', 2000); origin(seedUrl);
    if (state.run?.id === runId) return;
    if (state.run?.status === 'running') fail('A run is already active');
    if (state.agents.length !== 3) fail('Configure three agents first');
    state.run = { id: runId, status: 'running', seedUrl, startedAt: ctx.now };
    state.sites = []; state.jobs = []; state.submissions = []; state.calls = []; state.events = [];
    state.agents.forEach(a => { a.status = a.id === 'scout' ? 'scouting' : 'waiting'; });
    log(state, ctx, '', 'run_started', 'Demo started. Scout is reading the owned forum.');
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
    if (p.name !== a.name || p.phone !== a.phone || p.marker !== a.marker) fail('Submission must use this agent’s configured demo alias');
    if (state.submissions.some(s => s.id === id)) return;
    active(state, runId);
    const j = state.jobs.find(x => x.id === id) ?? fail('No submission job');
    if (j.status !== 'claimed' || j.leaseUntil < ctx.now) fail('Claim the job before submitting');
    state.submissions.push({ id, runId, siteId, agentId, name: a.name, phone: a.phone, marker: a.marker, receivedAt: ctx.now });
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
  if (action === 'discover_site') {
    active(state, runId);
    if (agentId !== 'scout') fail('Only the scout discovers sites');
    const x = object(p.site); const id = str(x.id, 'site ID', 100);
    if (state.sites.some(s => s.id === id)) return;
    if (state.sites.length) fail('This demo supports one discovered site per run');
    const url = str(x.url, 'site URL', 2000);
    if (origin(url) !== origin(state.run!.seedUrl)) fail('Discovered site must stay on the owned demo origin');
    const recipe = object(x.recipe);
    if (recipe.url !== url || !Array.isArray(recipe.fields) || recipe.fields.length !== 3) fail('Invalid form recipe');
    const values = new Set<string>();
    recipe.fields.forEach((raw: unknown) => { const f = object(raw); str(f.label, 'field label', 100); if (!['name','phone','marker'].includes(f.valueFrom) || values.has(f.valueFrom)) fail('Invalid recipe field'); values.add(f.valueFrom); });
    str(recipe.submitLabel, 'submit label', 100); str(recipe.successText, 'success text', 300);
    if (!Array.isArray(x.evidence) || x.evidence.length > 10) fail('Invalid evidence');
    x.evidence.forEach((v: unknown) => str(v, 'evidence', 1000));
    const site: Site = { id, runId, url, title: str(x.title, 'site title', 200), evidence: x.evidence,
      confidence: str(x.confidence, 'confidence', 100), recipe: recipe as Site['recipe'], status: 'discovered',
      discoveredBy: agentId, verifiedAt: 0, analysisMode: x.analysisMode === 'model' ? 'model' : 'fixture' };
    state.sites.push(site);
    state.jobs.push({ id: `${runId}:${id}:scout`, runId, siteId: id, agentId, dueAt: ctx.now, status: 'pending', leaseUntil: 0, receiptId: '' });
    log(state, ctx, agentId, 'site_discovered', `Scout discovered ${site.title} and a three-field submission form.`);
    return;
  }
  if (action === 'publish_site') {
    const siteId = str(p.siteId, 'site ID', 100);
    if (agentId !== 'scout') fail('Only the scout publishes a site');
    const s = state.sites.find(x => x.id === siteId && x.runId === runId) ?? fail('Unknown site');
    if (s.status === 'verified') return;
    active(state, runId);
    const receiptId = `${runId}:${siteId}:scout`;
    if (!state.submissions.some(x => x.id === receiptId)) fail('Scout submission must be accepted before broadcasting');
    s.status = 'verified'; s.verifiedAt = ctx.now;
    const scoutJob = state.jobs.find(x => x.id === receiptId)!;
    scoutJob.status = 'succeeded'; scoutJob.receiptId = receiptId; scoutJob.leaseUntil = 0;
    for (const [index, follower] of state.agents.filter(x => x.id !== 'scout').entries()) {
      const min = index === 0 ? 5000 : 12000; const max = index === 0 ? 10000 : 18000;
      const dueAt = ctx.now + min + Math.floor(ctx.random() * (max - min + 1));
      state.jobs.push({ id: `${runId}:${siteId}:${follower.id}`, runId, siteId, agentId: follower.id, dueAt, status: 'pending', leaseUntil: 0, receiptId: '' });
    }
    log(state, ctx, agentId, 'recipe_shared', 'Verified form recipe shared through SpacetimeDB; follower submissions scheduled.');
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
      j.status = 'claimed'; j.leaseUntil = ctx.now + LEASE_MS;
    } else {
      if (p.receiptId !== j.id || !state.submissions.some(x => x.id === p.receiptId)) fail('A verified acceptance receipt is required');
      j.status = 'succeeded'; j.receiptId = p.receiptId; j.leaseUntil = 0; a.status = 'ready';
      maybeComplete(state, ctx);
    }
    return;
  }
  fail(`Unknown action: ${action}`);
}
