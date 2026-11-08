import 'dotenv/config';
import assert from 'node:assert/strict';
import { analyzePage } from '../workers/model.ts';
import { inspectDemoPage, openDemoBrowser } from '../workers/browser.ts';

// Makes one paid-or-trial model request using the configured API key.
// It only reads the owned fixture and never submits a form or changes the demo run.
const base = `http://127.0.0.1:${process.env.PORT || '3210'}`;
const originalFetch = globalThis.fetch;
let modelContent = '';
let usage: unknown;
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  const response = await originalFetch(...args);
  if (String(args[0]).includes('/chat/completions')) {
    const result = await response.clone().json() as any;
    modelContent = result.choices?.[0]?.message?.content || '';
    usage = result.usage;
  }
  return response;
};
const session = await openDemoBrowser(base);
try {
  await session.page.goto(`${base}/demo/claim`, { waitUntil: 'domcontentloaded' });
  const page = await inspectDemoPage(session.page, base);
  assert.equal(page.fields.length, 3, 'Expected the actual three-field fixture');
  assert(!page.text.includes('Demo phishing site'), 'Simulation banner must not influence classification');
  let analysis;
  try { analysis = await analyzePage(page, base, 'live'); }
  catch (error) {
    console.log(JSON.stringify({ modelResponse: modelContent, usage, observedText: page.text }, null, 2));
    throw error;
  }
  console.log(JSON.stringify({ usage }));
  assert.equal(analysis.isCandidate, true);
  assert(analysis.recipe);
  assert.equal(analysis.recipe.fields.length, 3);
  assert.deepEqual(new Set(analysis.recipe.fields.map(field => field.valueFrom)), new Set(['name', 'phone', 'marker']));
  console.log(JSON.stringify({ model: process.env.MODEL_NAME, mode: 'live', page: page.url, ...analysis }, null, 2));
  console.log('PASS: live model returned a validated recipe from the actual owned fixture DOM.');
} finally {
  await session.browser.close();
}
