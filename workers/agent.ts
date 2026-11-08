import 'dotenv/config';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { connectStore } from '../server/store.ts';
import type { Agent, DemoState, Job, Site, Submission } from '../shared/contracts.ts';
import { analyzePage } from './model.ts';
import { inspectDemoPage, openDemoBrowser } from './browser.ts';
import { allowedUrl, submissionUrl, validateRecipe } from './safety.ts';

type WorkerId = 'scout' | 'finch' | 'wren';
type Mode = 'live' | 'rehearsal';
type Options = { agentId: WorkerId; runId: string; base: string; mode: Mode };

function options(): Options {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!['--agent', '--run', '--base', '--mode'].includes(key) || !value || args.has(key)) throw new Error('Use --agent scout|finch|wren --run RUN_ID --base DEMO_URL --mode live|rehearsal.');
    args.set(key, value);
  }
  const agentId = args.get('--agent');
  const runId = args.get('--run');
  const mode = args.get('--mode');
  if (!['scout', 'finch', 'wren'].includes(agentId ?? '') || !runId || runId.length > 160 || !['live', 'rehearsal'].includes(mode ?? '')) {
    throw new Error('An agent, run ID, and explicit live or rehearsal mode are required.');
  }
  const input = args.get('--base') ?? 'http://127.0.0.1:3210';
  const base = allowedUrl(input, input).origin;
  return { agentId: agentId as WorkerId, runId, base, mode: mode as Mode };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Worker action failed.';
  // Browser errors can include source snippets. Keep credentials and long page text out of the activity feed.
  const secrets = [process.env.MODEL_API_KEY, process.env.WORKER_SECRET].filter((v): v is string => !!v);
  let safe = message.split('\n')[0].slice(0, 300);
  for (const secret of secrets) safe = safe.replaceAll(secret, '[redacted]');
  return safe.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

async function run(): Promise<void> {
  const config = options();
  const { agentId, runId, base, mode } = config;
  if (!process.env.WORKER_SECRET) throw new Error('WORKER_SECRET is required to register a worker.');
  const localDir = resolve('.local');
  const host = (process.env.SPACETIMEDB_HOST || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const database = process.env.SPACETIMEDB_DATABASE || 'honeyline-demo';
  const namespace = createHash('sha256').update(`${host}|${database}`).digest('hex').slice(0, 16);
  const tokenPath = resolve(localDir, `worker-${agentId}-${namespace}.json`);
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  let token: string | undefined;
  try {
    const saved = JSON.parse(await readFile(tokenPath, 'utf8')) as { token?: string };
    token = saved.token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Worker identity file is unreadable; restore its token. Deleting it alone cannot recover an already registered identity.');
    if (host === 'http://127.0.0.1:3000' && database === 'honeyline-demo') {
      try { token = (JSON.parse(await readFile(resolve(localDir, `worker-${agentId}.json`), 'utf8')) as { token?: string }).token; }
      catch (legacyError) { if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Legacy worker identity is unreadable.'); }
    }
  }
  const store = await connectStore({ host, database, token });
  await writeFile(`${tokenPath}.tmp`, JSON.stringify({ host, database, token: store.token }), { mode: 0o600 });
  await rename(`${tokenPath}.tmp`, tokenPath);
  await store.dispatch('register_worker', { agentId, workerSecret: process.env.WORKER_SECRET });

  let stopping = false;
  let browserSession: Awaited<ReturnType<typeof openDemoBrowser>> | undefined;
  const waiters = new Set<() => void>();
  const wake = () => { for (const resolve of [...waiters]) resolve(); };
  const unsubscribe = store.subscribe(() => wake());
  const stop = () => { stopping = true; wake(); void browserSession?.browser.close(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const attempts = new Map<string, number>();
  let lastStatus = '';
  let hasDiscovered = false;

  function active(state = store.snapshot()): boolean {
    return !stopping && state.run?.id === runId && state.run.status === 'running';
  }
  function checkActive(): void {
    if (!active()) throw new Error('Demo run stopped or changed.');
  }
  function persona(): Agent {
    const person = store.snapshot().agents.find((p: Agent) => p.id === agentId);
    if (!person || !person.phone || !person.name || !person.marker) throw new Error('This worker needs a configured demo name, phone number, and reference.');
    return person;
  }
  async function dispatch(action: string, payload: Record<string, unknown>): Promise<void> {
    checkActive();
    await store.dispatch(action, { runId, agentId, ...payload });
  }
  async function status(value: string): Promise<void> {
    if (!active()) return;
    if (value !== lastStatus) {
      lastStatus = value;
      await dispatch('agent_status', { status: value });
    }
  }
  async function log(kind: string, message: string): Promise<void> {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), agentId, runId, kind, message }));
    if (active()) await dispatch('event', { kind, message });
  }
  async function waitForUpdate(ms: number): Promise<void> {
    if (stopping) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); waiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, ms);
      waiters.add(finish);
    });
  }
  async function browser() {
    checkActive();
    if (!browserSession) browserSession = await openDemoBrowser(base);
    return browserSession.page;
  }
  async function receiptFor(siteId: string, timeout = 0): Promise<Submission | undefined> {
    const deadline = Date.now() + timeout;
    while (true) {
      checkActive();
      const receipt = store.snapshot().submissions.find((s: Submission) => s.runId === runId && s.siteId === siteId && s.agentId === agentId);
      if (receipt) return receipt;
      if (Date.now() >= deadline) return undefined;
      await waitForUpdate(Math.min(250, deadline - Date.now()));
    }
  }
  function leaseValid(jobId: string): void {
    checkActive();
    const job = store.snapshot().jobs.find((j: Job) => j.id === jobId);
    if (!job || job.status !== 'claimed' || job.leaseUntil - Date.now() < 3_000) throw new Error('Submission lease is no longer valid; waiting before retry.');
  }
  async function discover(): Promise<void> {
    await status('discovering');
    const page = await browser();
    const seed = allowedUrl(store.snapshot().run!.seedUrl || '/forum', base).href;
    await log('visit', `Opening demo forum ${new URL(seed).pathname}`);
    await page.goto(seed, { waitUntil: 'domcontentloaded' });
    checkActive();
    await page.locator('[data-crawl-content]').first().waitFor({ state: 'visible' });
    const links = await page.locator('[data-crawl-content] a[href]').evaluateAll(elements => elements.map(element => (element as HTMLAnchorElement).href));
    const candidates: string[] = [];
    for (const link of links) {
      try {
        const url = allowedUrl(link, base);
        url.hash = '';
        if (url.pathname.startsWith('/demo/') && !candidates.includes(url.href)) candidates.push(url.href);
      } catch { /* External links are excluded before navigation. */ }
      if (candidates.length >= 6) break;
    }
    await log('links', `Read forum links; ${candidates.length} owned demo candidate${candidates.length === 1 ? '' : 's'} found.`);
    for (const candidate of candidates) {
      checkActive();
      await log('visit', `Inspecting ${new URL(candidate).pathname}`);
      await page.goto(candidate, { waitUntil: 'domcontentloaded' });
      checkActive();
      const description = await inspectDemoPage(page, base);
      if (!description.fields.length) {
        await log('inspect', 'No contact form found on this page; continuing to the next owned link.');
        continue;
      }
      await log('inspect', `Observed form labels: ${description.fields.map(f => f.label).join(', ')}.`);
      const analysis = await analyzePage(description, base, mode);
      checkActive();
      await log('classification', `${mode === 'live' ? 'Model decision' : 'Fixture rehearsal decision'}: ${analysis.isCandidate ? 'candidate found' : 'not selected'}; ${analysis.confidence} confidence.`);
      if (!analysis.isCandidate || !analysis.recipe) continue;
      const site: Site = {
        id: `${runId}:demo`, runId, url: description.url, title: description.title,
        evidence: analysis.evidence, confidence: analysis.confidence, recipe: analysis.recipe,
        status: 'discovered', discoveredBy: agentId, verifiedAt: 0,
        analysisMode: mode === 'live' ? 'model' : 'fixture',
      };
      await dispatch('discover_site', { site });
      await log('discovered', 'Saved the observed site and typed form instructions. Followers will wait for a verified receipt.');
      hasDiscovered = true;
      return;
    }
    throw new Error('No supported candidate form was found on the owned demo links.');
  }
  async function executeJob(job: Job, site: Site): Promise<void> {
    await dispatch('claim_job', { jobId: job.id });
    leaseValid(job.id);
    await status('submitting');
    const person = persona();
    let receipt = await receiptFor(site.id);
    if (!receipt) {
      const page = await browser();
      const target = submissionUrl(site.recipe, base, runId, site.id, agentId);
      await log('submit_start', `Claimed a database job; opening ${new URL(target).pathname} with this worker's identity.`);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      leaseValid(job.id);
      const current = await inspectDemoPage(page, base);
      // Query parameters carry the run identity; the form itself must still match the published recipe.
      const recipe = validateRecipe({ ...site.recipe, url: current.url }, current, base);
      for (const field of recipe.fields) {
        leaseValid(job.id);
        await page.getByLabel(field.label, { exact: true }).fill(person[field.valueFrom], { timeout: 6_000 });
      }
      leaseValid(job.id);
      await page.getByRole('button', { name: recipe.submitLabel, exact: true }).click({ timeout: 6_000 });
      await page.getByText(recipe.successText, { exact: false }).first().waitFor({ state: 'visible', timeout: 10_000 });
      receipt = await receiptFor(site.id, 10_000);
      if (!receipt) throw new Error('The page showed confirmation, but no matching database receipt arrived.');
    }
    if (receipt.name !== person.name || receipt.phone !== person.phone || receipt.marker !== person.marker) {
      throw new Error('Receipt details do not match this worker identity.');
    }
    await dispatch('complete_job', { jobId: job.id, receiptId: receipt.id });
    await log('receipt', 'Confirmed the actual form submission in the database.');
    if (agentId === 'scout') {
      await dispatch('publish_site', { siteId: site.id });
      await log('published', 'Published the verified recipe; other workers now have delayed jobs.');
    }
    await status('complete');
  }

  const heartbeat = setInterval(() => {
    if (active()) void store.dispatch('agent_status', { runId, agentId, status: lastStatus || 'waiting' }).catch(() => {});
  }, 15_000);

  try {
    if (!active()) throw new Error('The requested run is not active.');
    persona();
    await log('connected', `Independent ${agentId} worker connected to SpacetimeDB (${mode === 'rehearsal' ? 'explicit fixture rehearsal' : 'live model discovery'}).`);
    await status(agentId === 'scout' ? 'discovering' : 'waiting');
    while (active()) {
      const state: DemoState = store.snapshot();
      const sites = state.sites.filter(site => site.runId === runId);
      if (agentId === 'scout' && !sites.length && !hasDiscovered) {
        await discover();
        continue;
      }
      // Recover the crash window between the durable scout receipt/completion and publication.
      if (agentId === 'scout') {
        const unannounced = sites.find(site => site.status !== 'verified' && state.submissions.some(receipt => receipt.runId === runId && receipt.siteId === site.id && receipt.agentId === agentId));
        if (unannounced) {
          await dispatch('publish_site', { siteId: unannounced.id });
          await log('published', 'Recovered the stored scout receipt and published the verified recipe.');
          await status('complete');
          continue;
        }
      }
      const jobs = state.jobs.filter(job => job.runId === runId && job.agentId === agentId);
      const job = jobs.find(job => (attempts.get(job.id) ?? 0) < 2 && job.dueAt <= Date.now() && (job.status === 'pending' || (job.status === 'claimed' && job.leaseUntil <= Date.now())));
      if (job) {
        const site = sites.find(site => site.id === job.siteId);
        if (!site) throw new Error('Database job refers to a missing site.');
        attempts.set(job.id, (attempts.get(job.id) ?? 0) + 1);
        try { await executeJob(job, site); }
        catch (error) {
          if (!active()) break;
          await status('retry waiting');
          await log('error', safeError(error));
          if ((attempts.get(job.id) ?? 0) >= 2) {
            await status('needs attention');
            await log('retry_limit', 'Two submission attempts failed. Correct the issue before restarting this worker.');
          }
        }
      } else {
        const pending = jobs.filter(job => job.status !== 'succeeded');
        if (!pending.length && jobs.length) await status('complete');
        else if (pending.some(job => (attempts.get(job.id) ?? 0) < 2)) await status('waiting');
        await waitForUpdate(500);
      }
    }
  } catch (error) {
    if (active()) {
      await status('needs attention');
      await log('error', safeError(error));
    } else if (!stopping) console.error(JSON.stringify({ agentId, kind: 'stopped', message: safeError(error) }));
    process.exitCode = active() ? 1 : 0;
  } finally {
    stopping = true;
    clearInterval(heartbeat);
    unsubscribe();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await browserSession?.browser.close().catch(() => {});
    await store.close();
  }
}

run().catch(error => {
  console.error(JSON.stringify({ kind: 'worker_error', message: safeError(error) }));
  process.exitCode = 1;
});
