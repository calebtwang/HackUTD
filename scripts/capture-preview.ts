import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDemoBrowser } from '../workers/browser.ts';

// Uses the product's isolated test browser, never a user's browser session.
// Captures actual API state; this script performs no form submissions or demo actions.
const base = `http://127.0.0.1:${process.env.PORT || '3210'}`;
// Actual previews can include live numbers and transcripts; keep them outside Git.
const output = resolve(process.env.DEMO_PREVIEW_DIR || process.env.HONEYLINE_PREVIEW_DIR || '.local/previews');
await mkdir(output, { recursive: true });
const session = await openDemoBrowser(base);
try {
  // Preview keeps the same-origin live feed enabled; crawler workers omit it.
  await session.context.route(`${base}/api/events`, route => route.continue());
  await session.page.setViewportSize({ width: 1280, height: 900 });
  for (const [route, name] of [['/', 'dashboard'], ['/phishing', 'bank'], ['/forum', 'forum'], ['/admin', 'collected-numbers'], ['/debug', 'debug']] as const) {
    await session.page.goto(base + route, { waitUntil: 'networkidle' });
    await session.page.locator('body').waitFor();
    await session.page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
  }
  await session.page.setViewportSize({ width: 390, height: 844 });
  await session.page.goto(base, { waitUntil: 'networkidle' });
  await session.page.locator('body').waitFor();
  await session.page.screenshot({ path: resolve(output, 'dashboard-mobile.png'), fullPage: true });
  console.log(`Saved actual demo screenshots in ${output}.`);
} finally { await session.browser.close(); }
