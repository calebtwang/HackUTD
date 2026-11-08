import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedUrl, canonicalPageUrl, classifyFixture, classifyReadOnlyFixture, observedFormDetails, ownedPageLinks, publicInspectionNeeded, submissionUrl, validateAnalysis, validateReadOnlyAnalysis, validateRecipe, type PageDescription } from '../workers/safety.ts';
import { canonicalDemoUrl } from '../shared/contracts.ts';
import { analyzePublicPage } from '../workers/model.ts';
import { fetchPublicPage, isPublicAddress, PUBLIC_PAGE_BYTE_LIMIT, publicPageLinks, publicPageUrl, resolvePublicTarget, type PublicAddress, type PublicResponse } from '../workers/public-pages.ts';

const base = 'http://127.0.0.1:3210';
const page: PageDescription = {
  url: `${base}/demo/claim`, title: 'Prize center',
  text: 'You have been selected for a guaranteed prize.\nClaim today before this offer expires.\nEnter your phone number to request a callback.',
  fields: [{ label: 'Full name', type: 'text' }, { label: 'Phone number', type: 'tel' }],
  buttons: ['Request callback'], formAction: `${base}/api/demo/submit`,
};
const recipe = () => classifyFixture(page, base).recipe!;

test('exact origin guard rejects schemes, credentials, other ports and deceptive hosts', () => {
  assert.equal(allowedUrl('/demo/claim', base).origin, base);
  for (const url of ['https://127.0.0.1:3210/demo', 'http://127.0.0.1:3211/', 'http://127.0.0.1.evil.test:3210/', '//evil.test/', 'javascript:alert(1)', 'file:///tmp/a', 'http://user:pass@127.0.0.1:3210/']) {
    assert.throws(() => allowedUrl(url, base), Error, url);
  }
});

test('recipe validation rejects model-invented fields, actions, external form destinations and source duplication', () => {
  assert.deepEqual(validateRecipe(recipe(), page, base), recipe());
  assert.throws(() => validateRecipe({ ...recipe(), command: 'curl' }, page, base));
  assert.throws(() => validateRecipe({ ...recipe(), url: 'https://example.com' }, page, base));
  assert.throws(() => validateRecipe(recipe(), { ...page, formAction: 'https://example.com/submit' }, base));
  assert.throws(() => validateRecipe({ ...recipe(), fields: [{ label: 'Missing', valueFrom: 'name' }, ...recipe().fields.slice(1)] }, page, base));
  assert.throws(() => validateRecipe({ ...recipe(), fields: recipe().fields.map(f => ({ ...f, valueFrom: 'phone' })) }, page, base));
  assert.throws(() => validateRecipe({ ...recipe(), submitLabel: 'Buy now' }, page, base));
  assert.throws(() => validateRecipe({ ...recipe(), fields: [...recipe().fields, { label: 'Reference', valueFrom: 'marker' }] }, page, base));
  assert.throws(() => validateRecipe(recipe(), { ...page, fields: [...page.fields, { label: 'Reference', type: 'text' }] }, base));
});

test('owned crawl links include arbitrary paths and canonicalize only execution metadata', () => {
  assert.deepEqual(ownedPageLinks([
    `${base}/forum`, `${base}/bank/credit?b=2&a=1#form`,
    `${base}/bank/credit?a=1&b=2&runId=old&site=stale&agentId=finch`,
    `${base}/other-form`, `${base}/bank/credit/`, '//external.test/form',
  ], base), [`${base}/forum`, `${base}/bank/credit?a=1&b=2`, `${base}/other-form`, `${base}/bank/credit/`]);
  assert.equal(canonicalPageUrl(`${base}/claim?run=old&siteId=x&agent=y&offer=2#form`, base), `${base}/claim?offer=2`);
});

test('fixture classifier requires content evidence, not a simulation/phishing banner', () => {
  assert.equal(classifyFixture(page, base).isCandidate, true);
  assert.equal(classifyFixture({ ...page, text: 'DEMO phishing simulation. An ordinary community newsletter.' }, base).isCandidate, false);
  assert.equal(classifyFixture({ ...page, text: 'Call our community center for its opening hours.' }, base).isCandidate, false);
});

test('model evidence must actually occur in the supplied page content', () => {
  const good = { isCandidate: true, confidence: 'high', evidence: ['guaranteed prize'], recipe: recipe() };
  assert.equal(validateAnalysis(good, page, base).isCandidate, true);
  assert.throws(() => validateAnalysis({ ...good, evidence: ['The site steals passwords'] }, page, base));
  assert.throws(() => validateAnalysis({ ...good, evidence: [] }, page, base));
});

test('submission metadata is encoded and replaces stale run identifiers', () => {
  const r = { ...recipe(), url: `${base}/demo/claim?runId=old` };
  const result = new URL(submissionUrl(r, base, 'run&1', 'site demo', 'scout'));
  assert.equal(result.searchParams.get('runId'), 'run&1');
  assert.equal(result.searchParams.getAll('runId').length, 1);
  assert.equal(result.searchParams.get('siteId'), 'site demo');
});

test('model evidence tolerates layout whitespace but rejects changed wording and punctuation', () => {
  const wrapped = { ...page, text: 'Your household could receive\n$750.\n\nAct\ttoday.\u00a0Request a callback.' };
  const good = { isCandidate: true, confidence: 'high', evidence: ['Your household could receive $750.', 'Act today. Request a callback.'], recipe: recipe() };
  assert.deepEqual(validateAnalysis(good, wrapped, base).evidence, good.evidence);
  assert.throws(() => validateAnalysis({ ...good, evidence: ['Your household will receive $750.'] }, wrapped, base));
  assert.throws(() => validateAnalysis({ ...good, evidence: ['Your household could receive $750!'] }, wrapped, base));
  assert.throws(() => validateAnalysis({ ...good, evidence: ['Your household could receive Act today.'] }, wrapped, base));
});

test('read-only classification accepts arbitrary observed fields and rejects executable recipes', () => {
  const external = { ...page, url: 'https://offers.example/form?site=bank', formAction: 'https://other.example/capture', fields: [{ label: 'Account password', type: 'password' }], text: 'Claim your guaranteed prize today.\nVerify your account password now.' };
  const decision = classifyReadOnlyFixture(external);
  assert.equal(decision.isCandidate, true);
  assert.equal('recipe' in decision, false);
  assert.deepEqual(validateReadOnlyAnalysis(decision, external), decision);
  assert.throws(() => validateReadOnlyAnalysis({ ...decision, recipe: recipe() }, external));
  assert.throws(() => validateReadOnlyAnalysis({ ...decision, evidence: ['invented evidence'] }, external));
  assert.equal(canonicalDemoUrl('https://offers.example/form?site=bank&agent=x&run=2#form', false), 'https://offers.example/form?agent=x&run=2&site=bank');
});

test('feed membership and failed inspection never suppress a later public page inspection', () => {
  assert.equal(publicInspectionNeeded(undefined), true);
  assert.equal(publicInspectionNeeded({}), false, 'An already-recorded ordinary candidate remains deduplicated');
  for (const inspectionStatus of ['pending', 'inspecting', 'unavailable', 'analysis_failed', 'not_flagged']) {
    assert.equal(publicInspectionNeeded({ sourceUrl: 'https://feeds.example/list.txt', inspectionStatus }), true, inspectionStatus);
  }
  assert.equal(publicInspectionNeeded({ sourceUrl: 'https://feeds.example/list.txt', inspectionStatus: 'inspected' }), false);
});

test('observed form metadata retains only actual bounded labels, buttons and destination', () => {
  const details = observedFormDetails({ ...page, fields: [{ label: '', type: 'hidden' }, { label: 'Account password', type: 'password' }, { label: 'x'.repeat(150), type: 'text' }], buttons: [' Verify ', ''], formAction: 'javascript:void(0)' });
  assert.deepEqual(details.observedFields, ['Account password', 'x'.repeat(100)]);
  assert.deepEqual(details.observedButtons, ['Verify']);
  assert.equal(details.observedFormAction, 'javascript:void(0)', 'An observed destination is text metadata, not an executable recipe');
  assert.equal('recipe' in details, false);
});

test('public model rejects fabricated quotes without retry and excludes crawl queues from its payload', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnvironment = { MODEL_BASE_URL: process.env.MODEL_BASE_URL, MODEL_API_KEY: process.env.MODEL_API_KEY, MODEL_NAME: process.env.MODEL_NAME };
  let calls = 0;
  try {
    process.env.MODEL_BASE_URL = 'https://model.example/v1'; process.env.MODEL_API_KEY = 'test-only'; process.env.MODEL_NAME = 'test-model';
    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      const supplied = JSON.parse(body.messages[1].content);
      assert.equal('links' in supplied, false);
      assert.equal('isUrlFeed' in supplied, false);
      assert.equal(supplied.text, page.text);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isCandidate: true, confidence: 'high', evidence: ['Invented translated claim'] }) } }] }), { status: 200 });
    };
    await assert.rejects(analyzePublicPage(Object.assign({}, page, { links: ['https://queued.example/'], isUrlFeed: false }), 'live'), /Evidence must quote/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('public addresses exclude private, mapped, documentation and special-use ranges', () => {
  for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  for (const address of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '::', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', 'ff02::1', '64:ff9b::808:808', '2001:db8::1', '2001:2::1', '2002:0808:0808::1', '3fff::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test('public URL guard rejects private spellings, credentials, unusual ports and non-web schemes', () => {
  assert.equal(publicPageUrl('/form?site=bank#section', 'https://example.com/forum').href, 'https://example.com/form?site=bank');
  assert.equal(publicPageUrl('https://example.com.:443/').href, 'https://example.com/');
  for (const url of ['http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://localhost/', 'https://host.local/', 'http://internal/', 'https://example.com:80/', 'http://example.com:443/', 'https://example.com:8080/', 'https://user:pass@example.com/', 'file:///tmp/a', 'javascript:alert(1)', 'https://example.com/ bad', 'https://example.com\\@127.0.0.1/']) {
    assert.throws(() => publicPageUrl(url), Error, url);
  }
});

test('public links preserve meaningful queries while independently discarding malformed links', () => {
  assert.deepEqual(publicPageLinks(['/offer?site=bank&agent=a', '/broken?q=%', '/offer?agent=a&site=bank#form', '/other?run=2', 'http://127.0.0.1/private'], 'https://example.com/forum'), ['https://example.com/offer?agent=a&site=bank', 'https://example.com/other?run=2']);
});

const publicAddress: PublicAddress = { address: '93.184.216.34', family: 4 };
const publicLookup = async () => [publicAddress];
function response(status = 200, headers: PublicResponse['headers'] = { 'content-type': 'text/html' }, chunks: Uint8Array[] = [Buffer.from('<h1>Example</h1>')], onClose = () => {}): PublicResponse {
  return { status, headers, body: (async function* () { yield* chunks; })(), close: onClose };
}

test('DNS checks all answers before choosing and pinning a public address', async () => {
  const target = publicPageUrl('https://example.com/');
  assert.deepEqual(await resolvePublicTarget(target, { lookup: publicLookup }), publicAddress);
  await assert.rejects(resolvePublicTarget(target, { lookup: async () => [publicAddress, { address: '127.0.0.1', family: 4 }] }), /DNS/);
  await assert.rejects(resolvePublicTarget(target, { lookup: async () => [] }), /DNS/);
  await assert.rejects(resolvePublicTarget(target, { lookup: async () => [{ address: '8.8.8.8', family: 6 }] }), /DNS/);
  let calls = 0;
  const result = await fetchPublicPage(target.href, { lookup: publicLookup, request: async (url, pinned) => {
    calls++; assert.equal(url.href, target.href); assert.deepEqual(pinned, publicAddress); return response();
  } });
  assert.equal(calls, 1);
  assert.match(result.html, /Example/);
});

test('redirects recheck DNS and cannot reach a private target', async () => {
  let requests = 0;
  let closed = 0;
  await assert.rejects(fetchPublicPage('https://example.com/', {
    lookup: publicLookup,
    request: async () => { requests++; return response(302, { location: 'http://127.0.0.1/secret' }, [], () => closed++); },
  }), /Private|special-use/);
  assert.equal(requests, 1); assert.equal(closed, 1);
  const lookedUp: string[] = [];
  requests = 0;
  await assert.rejects(fetchPublicPage('https://example.com/', {
    lookup: async host => { lookedUp.push(host); return host === 'example.com' ? [publicAddress] : [{ address: '10.0.0.1', family: 4 }]; },
    request: async () => { requests++; return response(302, { location: 'https://changed.example/' }); },
  }), /DNS/);
  assert.deepEqual(lookedUp, ['example.com', 'changed.example']); assert.equal(requests, 1);
  requests = 0;
  await assert.rejects(fetchPublicPage('https://example.com/', {
    lookup: publicLookup,
    request: async () => { requests++; return response(302, { location: '/another' }); },
  }), /redirect limit/);
  assert.equal(requests, 4);
});

test('public response reader caps actual bytes, content type and compressed bodies', async () => {
  let closed = 0;
  for (const mocked of [
    response(200, { 'content-type': 'text/html', 'content-length': String(PUBLIC_PAGE_BYTE_LIMIT + 1) }, [], () => closed++),
    response(200, { 'content-type': 'text/html' }, [Buffer.alloc(PUBLIC_PAGE_BYTE_LIMIT), Buffer.from('x')], () => closed++),
    response(200, { 'content-type': 'application/pdf' }, [], () => closed++),
    response(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }, [], () => closed++),
  ]) await assert.rejects(fetchPublicPage('https://example.com/', { lookup: publicLookup, request: async () => mocked }), /2 MB|non-HTML|Compressed/);
  assert.equal(closed, 4);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(fetchPublicPage('https://example.com/', { signal: aborted.signal, lookup: publicLookup, request: async () => { throw new Error('Request should not start'); } }), /cancelled/);
});
