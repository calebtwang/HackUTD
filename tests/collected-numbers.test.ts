import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { STARTER_NUMBERS, collectedNumbers, renderCollectedNumbers } from '../server/collected-numbers.ts';
import { EMPTY_STATE, PERSONAS, type Site } from '../shared/contracts.ts';
import { transition, type PrivateState } from '../spacetimedb/src/logic.ts';

// Reserved fictional 555-01xx range; never use a provisioned project number.
const RECEIPT_PHONE = '+12025550199';

test('starter numbers are stable fictional display fixtures, not submission records', () => {
  const state = structuredClone(EMPTY_STATE);
  const before = structuredClone(state);
  assert.ok(STARTER_NUMBERS.length > 0);
  assert.ok(Object.isFrozen(STARTER_NUMBERS));
  assert.equal(new Set(STARTER_NUMBERS).size, STARTER_NUMBERS.length);
  assert.ok(STARTER_NUMBERS.every(phone => /^\+1\d{3}55501\d{2}$/.test(phone)));
  assert.deepEqual(collectedNumbers(state.submissions), [...STARTER_NUMBERS]);
  assert.equal(renderCollectedNumbers(state.submissions), renderCollectedNumbers([]));
  assert.deepEqual(state, before, 'Rendering must not add fake receipts to the database state');
});

test('only unique valid receipt numbers are rendered, with no injected markup or private details', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const rows = [
    { phone: RECEIPT_PHONE, name: 'Private name should not appear' },
    { phone: RECEIPT_PHONE }, { phone: STARTER_NUMBERS[0] },
    { phone: malicious }, { phone: `${RECEIPT_PHONE}${malicious}` },
    { phone: 'DEMO-SCOUT' }, { phone: '' }, { phone: 'not a number' },
  ];
  assert.deepEqual(collectedNumbers(rows), [...STARTER_NUMBERS, RECEIPT_PHONE]);
  const html = renderCollectedNumbers(rows);
  assert.equal(html.includes(malicious), false);
  assert.equal(html.includes('Private name should not appear'), false);
  assert.equal(html.includes('DEMO-SCOUT'), false);
  assert.equal(html.split(RECEIPT_PHONE).length - 1, 1);
});

test('open admin page automatically shows accepted receipts and clears them after the real reset transition', { timeout: 15_000 }, async () => {
  const state = structuredClone(EMPTY_STATE);
  const auth: PrivateState = { admin: 'owner', workerSecret: '', workers: {} };
  let sequence = 0;
  function dispatch(sender: string, action: string, input: unknown) {
    transition(state, auth, { sender, now: 1_000, random: () => 0.5, uuid: () => `event-${++sequence}` }, action, input);
  }
  const personas = PERSONAS.map((persona, index) => ({ ...persona, phone: index ? '+12025550198' : RECEIPT_PHONE }));
  const workerSecret = 'synthetic-test-worker-secret';
  dispatch('owner', 'configure', { personas, workerSecret });
  for (const persona of personas) dispatch(persona.id, 'register_worker', { agentId: persona.id, workerSecret });
  const server = createServer((req, res) => {
    if (req.url !== '/admin') { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderCollectedNumbers(state.submissions));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const site: Site = {
    id: 'bank-site', runId: 'run', url: `${base}/phishing`, title: 'Synthetic bank form',
    evidence: ['Claim a guaranteed prize today.'], confidence: 'high', discoveredBy: 'scout',
    status: 'discovered', verifiedAt: 0, analysisMode: 'fixture', submissionAllowed: true,
    recipe: { url: `${base}/phishing`, fields: [{ label: 'Full name', valueFrom: 'name' }, { label: 'Phone number', valueFrom: 'phone' }], submitLabel: 'Request callback', successText: 'Your request has been received' },
  };
  dispatch('owner', 'start_run', { runId: 'run', seedUrl: `${base}/forum`, entryPoints: { scout: `${base}/forum`, finch: '' } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    await page.goto(`${base}/admin`, { waitUntil: 'domcontentloaded' });
    const baseline = STARTER_NUMBERS.join('\n');
    assert.equal(await page.locator('pre').textContent(), baseline);
    assert.equal((await page.locator('pre').textContent())!.includes(RECEIPT_PHONE), false);
    assert.deepEqual(state.submissions, [], 'Configured agent phone numbers are not collected until a receipt is accepted');
    await page.locator('body').evaluate(element => { (element as HTMLElement).dataset.documentSentinel = 'same-document'; });

    dispatch('scout', 'discover_site', { runId: 'run', agentId: 'scout', site });
    dispatch('scout', 'claim_job', { runId: 'run', agentId: 'scout', jobId: 'run:bank-site:scout' });
    dispatch('owner', 'accept_submission', { runId: 'run', siteId: 'bank-site', agentId: 'scout', name: personas[0].name, phone: RECEIPT_PHONE });
    assert.equal(state.submissions.length, 1);
    await page.waitForFunction(expected => document.querySelector('pre')?.textContent === expected,
      [...STARTER_NUMBERS, RECEIPT_PHONE].join('\n'), { timeout: 5_000 });

    dispatch('owner', 'reset', {});
    assert.deepEqual(state.submissions, []);
    assert.equal(state.run, null);
    await page.waitForFunction(expected => document.querySelector('pre')?.textContent === expected, baseline, { timeout: 5_000 });
    assert.equal(navigations, 1, 'Receipt and reset updates must arrive without a page refresh');
    assert.equal(await page.locator('body').getAttribute('data-document-sentinel'), 'same-document');
    assert.equal(await page.locator('body').innerText(), baseline, 'The page must remain a numbers-only list');
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
