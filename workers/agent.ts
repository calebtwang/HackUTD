import 'dotenv/config';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { connectStore } from '../server/store.ts';
import { canonicalDemoUrl, type Agent, type DemoState, type Job, type Site, type Submission } from '../shared/contracts.ts';
import { analyzePage, analyzePublicPage } from './model.ts';
import { inspectDemoPage, openDemoBrowser } from './browser.ts';
import { allowedUrl, canonicalPageUrl, ownedPageLinks, submissionUrl, validateRecipe, publicInspectionNeeded, observedFormDetails, type Analysis, type ReadOnlyAnalysis, type PageDescription } from './safety.ts';
import { fetchPublicPage, inspectPublicPage, publicPageUrl } from './public-pages.ts';

type WorkerId = 'scout' | 'finch';
const MAX_PAGES_PER_PASS = 12;
const MAX_CRAWL_URLS = 500;
const SCAN_INTERVAL_MS = 60_000;
type Mode = 'live' | 'rehearsal';
type Options = { agentId: WorkerId; runId: string; base: string; mode: Mode };

function options(): Options {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!['--agent', '--run', '--base', '--mode'].includes(key) || !value || args.has(key)) throw new Error('Use --agent scout|finch --run RUN_ID --base DEMO_URL --mode live|rehearsal.');
    args.set(key, value);
  }
  const agentId = args.get('--agent');
  const runId = args.get('--run');
  const mode = args.get('--mode');
  if (!['scout', 'finch'].includes(agentId ?? '') || !runId || runId.length > 160 || !['live', 'rehearsal'].includes(mode ?? '')) {
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
  const publicAbort = new AbortController();
  const stop = () => { stopping = true; publicAbort.abort(); wake(); void browserSession?.browser.close(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const attempts = new Map<string, number>();
  let lastStatus = '';
  const initialRun = store.snapshot().run;
  const entryPoint = initialRun?.entryPoints?.[agentId]?.trim() || '';
  let discoveryDone = false;
  let publicScan = false;
  let entryUrl = '';
  let nextPassAt = 0;
  const queue: string[] = [];
  const pendingUrls = new Set<string>();
  const knownUrls = new Set<string>();
  const refreshable = new Set<string>();
  const passVisited = new Set<string>();
  let crawlLimitReached = false;
  let scanErrors = 0;


  function active(state = store.snapshot()): boolean {
    return !stopping && state.run?.id === runId && state.run.status === 'running';
  }
  function checkActive(): void {
    if (!active()) throw new Error('Demo run stopped or changed.');
  }
  function persona(): Agent {
    const person = store.snapshot().agents.find((p: Agent) => p.id === agentId);
    if (!person || !person.phone || !person.name) throw new Error('This worker needs a configured demo name and phone number.');
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
  function enqueuePage(url: string, refresh = false, first = false): void {
    if (pendingUrls.has(url)) {
      if (first) { queue.splice(queue.indexOf(url), 1); queue.unshift(url); }
      return;
    }
    if (passVisited.has(url) || (knownUrls.has(url) && !refresh)) return;
    if (!knownUrls.has(url) && knownUrls.size >= MAX_CRAWL_URLS) { crawlLimitReached = true; return; }
    knownUrls.add(url); pendingUrls.add(url);
    if (first) queue.unshift(url); else queue.push(url);
  }
  function startScanPass(): void {
    passVisited.clear(); scanErrors = 0; discoveryDone = false;
    nextPassAt = Date.now() + SCAN_INTERVAL_MS;
    enqueuePage(entryUrl, true, true);
    for (const url of refreshable) enqueuePage(url, true);
  }
  async function finishDiscovery(): Promise<void> {
    if (discoveryDone) return;
    await log('scan_finished', entryPoint
      ? `Inspected ${passVisited.size} page${passVisited.size === 1 ? '' : 's'} this pass; ${queue.length} queued. The starting page will refresh after about a minute.${crawlLimitReached ? ` Run URL limit: ${MAX_CRAWL_URLS}.` : ''}${scanErrors ? ` ${scanErrors} page inspection${scanErrors === 1 ? '' : 's'} failed.` : ''}`
      : 'No starting page assigned; listening for shared sites and jobs.');
    await dispatch('discovery_complete', {});
    discoveryDone = true;
  }
  function canonicalObservedUrl(url: string): string {
    return canonicalDemoUrl(url, new URL(url).origin === new URL(base).origin);
  }
  function sharedSite(url: string): Site | undefined {
    return store.snapshot().sites.find(site => site.runId === runId && canonicalObservedUrl(site.url) === url);
  }
  async function recordDiscovery(description: PageDescription, analysis: Analysis | ReadOnlyAnalysis, submissionAllowed: boolean): Promise<void> {
    if (!analysis.isCandidate) return;
    const canonicalUrl = canonicalObservedUrl(description.url);
    const recipe = submissionAllowed && 'recipe' in analysis ? analysis.recipe : null;
    if (submissionAllowed && !recipe) throw new Error('Owned candidate has no validated form instructions.');
    const site: Site = {
      id: `site-${randomUUID()}`, runId, url: canonicalUrl, title: description.title,
      evidence: analysis.evidence, confidence: analysis.confidence,
      recipe: recipe ? { ...recipe, url: canonicalUrl } : null,
      submissionAllowed, observedFields: description.fields.map(field => field.label.trim().slice(0, 100)).filter(Boolean),
      status: submissionAllowed ? 'discovered' : 'observed', discoveredBy: agentId, verifiedAt: 0,
      analysisMode: mode === 'live' ? 'model' : 'fixture',
    };
    await dispatch('discover_site', { site });
    // The other peer may win the transaction. Always re-read its durable ID.
    const canonical = sharedSite(canonicalUrl);
    if (!canonical) throw new Error('Discovery completed without a canonical database site.');
    if (!canonical.submissionAllowed) {
      await log('observed', 'Recorded a public review candidate. No external form was submitted.');
    } else await log(canonical.discoveredBy === agentId ? 'discovered' : 'shared_site', canonical.discoveredBy === agentId
      ? 'Saved the observed form instructions. An accepted browser receipt is required before sharing submission jobs.'
      : 'The other agent already recorded this URL; its existing shared job controls submission.');
  }
  async function inspectNextPage(): Promise<void> {
    const candidate = queue.shift();
    if (!candidate) { await finishDiscovery(); return; }
    pendingUrls.delete(candidate); passVisited.add(candidate);
    await status('scanning');
    await log('visit', `Inspecting ${new URL(candidate).hostname}${new URL(candidate).pathname}${publicScan ? ' (read-only)' : ''}`);
    // Keep the original reported row through redirects; its source remains the
    // fetched feed, while the final page supplies the observation and evidence.
    let reported = publicScan ? sharedSite(candidate) : undefined;
    let observed: ReturnType<typeof observedFormDetails> | undefined;
    let stage: 'fetch' | 'analysis' = 'fetch';
    try {
      let description: PageDescription;
      let links: string[];
      let isUrlFeed = false;
      if (publicScan) {
        if (reported && publicInspectionNeeded(reported)) await dispatch('inspect_site', { siteId: reported.id, inspectionStatus: 'inspecting', inspectionMessage: 'Fetching the reported page read-only.' });
        const fetched = await fetchPublicPage(candidate, { signal: publicAbort.signal });
        checkActive();
        const inspected = await inspectPublicPage(fetched);
        checkActive();
        description = inspected;
        isUrlFeed = inspected.isUrlFeed;
        const preferredOrigin = new URL(entryUrl).origin;
        links = inspected.links.sort((a, b) => Number(new URL(b).origin === preferredOrigin) - Number(new URL(a).origin === preferredOrigin));
      } else {
        const page = await browser();
        await page.goto(candidate, { waitUntil: 'domcontentloaded' });
        checkActive();
        description = await inspectDemoPage(page, base);
        const observedLinks = await page.locator('[data-crawl-content] a[href]').evaluateAll(elements => elements.slice(0, 500).map(element => (element as HTMLAnchorElement).href));
        links = ownedPageLinks(observedLinks, base);
      }
      if (links.length) refreshable.add(candidate);
      if (isUrlFeed) {
        // Report only URLs actually present in the fetched feed. These rows are
        // pending leads, not model decisions or verified phishing findings.
        for (let offset = 0; offset < links.length; offset += 40) {
          await dispatch('report_feed', { sourceUrl: description.url, urls: links.slice(offset, offset + 40) });
        }
        await log('feed_reported', `Recorded ${links.length} feed-reported URLs with their source. Page inspection is still pending.`);
      }
      const before = queue.length;
      for (const link of links) enqueuePage(link);
      if (queue.length > before) await log('links', `Queued ${queue.length - before} newly observed page links.`);
      if (isUrlFeed) {
        if (reported && publicInspectionNeeded(reported)) await dispatch('inspect_site', { siteId: reported.id, inspectionStatus: 'analysis_failed', inspectionMessage: 'The reported destination was another URL feed; it was not classified as a target page.' });
        await log('inspect', 'Read a URL feed. Listed destinations will be inspected separately; the feed itself is not classified as a candidate.');
        return;
      }
      const canonicalUrl = canonicalObservedUrl(description.url);
      const existing = reported || sharedSite(canonicalUrl);
      if (existing && (!publicScan || !publicInspectionNeeded(existing))) {
        await log('shared_site', 'This URL already has a completed inspection; skipping repeat analysis and duplicate submissions.');
        return;
      }
      if (!publicScan && !description.fields.length) {
        await log('inspect', 'No contact form found on this owned page.');
        return;
      }
      if (publicScan && existing) {
        reported = existing;
        observed = observedFormDetails(description);
        await dispatch('inspect_site', { siteId: reported.id, inspectionStatus: 'inspecting', inspectionMessage: 'Page fetched; observed form details saved. Analyzing the page content.', ...observed });
      }
      await log('inspect', `Observed ${description.fields.length} form field${description.fields.length === 1 ? '' : 's'}.`);
      stage = 'analysis';
      const analysis = publicScan ? await analyzePublicPage(description, mode) : await analyzePage(description, base, mode);
      checkActive();
      await log('classification', `${mode === 'live' ? 'Model decision' : 'Explicit rule decision'}: ${analysis.isCandidate ? 'review candidate found' : 'not selected'}; ${analysis.confidence} confidence.`);
      if (publicScan && reported) {
        await dispatch('inspect_site', {
          siteId: reported.id, inspectionStatus: analysis.isCandidate ? 'inspected' : 'not_flagged',
          inspectionMessage: analysis.isCandidate ? 'Page content was inspected and warrants review; this is not a verified fraud finding.' : 'This inspection did not flag the page. The original feed report remains attached.',
          ...observed, analysisMode: mode === 'live' ? 'model' : 'fixture', confidence: analysis.confidence, evidence: analysis.evidence,
        });
        if (!analysis.isCandidate) refreshable.add(candidate);
      } else await recordDiscovery(description, analysis, !publicScan);
    } catch (error) {
      if (!active()) throw error;
      scanErrors++;
      refreshable.add(candidate); // Retry a transient fetch/model failure on a later bounded pass.
      if (publicScan && reported && publicInspectionNeeded(reported)) {
        await dispatch('inspect_site', { siteId: reported.id, inspectionStatus: stage === 'analysis' ? 'analysis_failed' : 'unavailable', inspectionMessage: safeError(error), ...observed });
      }
      await log('error', `Page inspection failed: ${safeError(error)}`);
    }
  }
  async function executeJob(job: Job, site: Site): Promise<void> {
    const storedRecipe = site.recipe;
    if (!storedRecipe || site.submissionAllowed === false) throw new Error('Read-only sites cannot receive browser submissions.');
    await dispatch('claim_job', { jobId: job.id });
    leaseValid(job.id);
    await status('submitting');
    const person = persona();
    let receipt = await receiptFor(site.id);
    if (!receipt) {
      const page = await browser();
      const target = submissionUrl(storedRecipe, base, runId, site.id, agentId);
      await log('submit_start', `Claimed a database job; opening ${new URL(target).pathname} with this worker's identity.`);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      leaseValid(job.id);
      const current = await inspectDemoPage(page, base);
      if (canonicalPageUrl(current.url, base) !== canonicalPageUrl(site.url, base)) throw new Error('Submission navigation no longer matches the verified site.');
      // Query parameters carry the run identity; the form itself must still match the published recipe.
      const recipe = validateRecipe({ ...storedRecipe, url: current.url }, current, base);
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
    if (receipt.name !== person.name || receipt.phone !== person.phone) {
      throw new Error('Receipt details do not match this worker identity.');
    }
    await dispatch('complete_job', { jobId: job.id, receiptId: receipt.id });
    await log('receipt', 'Confirmed the actual form submission in the database.');
    if (site.discoveredBy === agentId && site.status !== 'verified') {
      await dispatch('publish_site', { siteId: site.id });
      await log('published', 'Published the verified form instructions; the other agent now has a delayed job.');
    }
    await status(discoveryDone ? 'waiting' : 'scanning');
  }

  const heartbeat = setInterval(() => {
    if (active()) void store.dispatch('agent_status', { runId, agentId, status: lastStatus || 'waiting' }).catch(() => {});
  }, 15_000);

  try {
    if (!active()) throw new Error('The requested run is not active.');
    persona();
    if (entryPoint) {
      publicScan = new URL(entryPoint, base).origin !== new URL(base).origin;
      entryUrl = publicScan ? canonicalDemoUrl(publicPageUrl(entryPoint).href, false) : canonicalPageUrl(entryPoint, base);
      startScanPass();
    }
    await log('connected', `${persona().name} connected to SpacetimeDB (${mode === 'rehearsal' ? 'explicit fixture rehearsal' : 'model discovery'}).`);
    await status(entryPoint && !discoveryDone ? 'scanning' : 'waiting');
    if (!entryPoint) await finishDiscovery();
    while (active()) {
      const state: DemoState = store.snapshot();
      const sites = state.sites.filter(site => site.runId === runId);
      // Recover a crash after the discoverer's accepted receipt but before its
      // publish action. Either peer can own discoveries; ownership is per site.
      const unannounced = sites.find(site => site.discoveredBy === agentId && site.status !== 'verified' && state.submissions.some(receipt => receipt.runId === runId && receipt.siteId === site.id && receipt.agentId === agentId));
      if (unannounced) {
        await dispatch('publish_site', { siteId: unannounced.id });
        await log('published', 'Recovered an accepted receipt and shared the verified form instructions.');
        continue;
      }
      const jobs = state.jobs.filter(job => job.runId === runId && job.agentId === agentId);
      const job = jobs.filter(job => (attempts.get(job.id) ?? 0) < 2 && job.dueAt <= Date.now() && (job.status === 'pending' || (job.status === 'claimed' && job.leaseUntil <= Date.now()))).sort((a, b) => a.dueAt - b.dueAt)[0];
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
        continue;
      }
      // Interleave one page at a time with due jobs from the shared subscription.
      if (entryPoint && discoveryDone && Date.now() >= nextPassAt) startScanPass();
      if (!discoveryDone) {
        if (queue.length && passVisited.size < MAX_PAGES_PER_PASS) await inspectNextPage();
        else await finishDiscovery();
        continue;
      }
      const pending = jobs.filter(job => job.status !== 'succeeded');
      if (!pending.length || pending.some(job => (attempts.get(job.id) ?? 0) < 2)) await status('waiting');
      await waitForUpdate(500);
    }
  } catch (error) {
    if (active()) {
      await status('needs attention');
      await log('error', safeError(error));
    } else if (!stopping) console.error(JSON.stringify({ agentId, kind: 'stopped', message: safeError(error) }));
    process.exitCode = active() ? 1 : 0;
  } finally {
    stopping = true;
    publicAbort.abort();
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
