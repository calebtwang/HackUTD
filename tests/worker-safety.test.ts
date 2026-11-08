import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedUrl, classifyFixture, submissionUrl, validateAnalysis, validateRecipe, type PageDescription } from '../workers/safety.ts';

const base = 'http://127.0.0.1:3210';
const page: PageDescription = {
  url: `${base}/demo/claim`, title: 'Prize center',
  text: 'You have been selected for a guaranteed prize.\nClaim today before this offer expires.\nEnter your phone number to request a callback.',
  fields: [{ label: 'Full name', type: 'text' }, { label: 'Phone number', type: 'tel' }, { label: 'Reference', type: 'text' }],
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
