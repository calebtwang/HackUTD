import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { allowedUrl, type PageDescription } from './safety.ts';

/** Fetch redirects ourselves: route.continue alone does not guard a redirect chain. */
async function routeWithinOrigin(route: Route, context: BrowserContext, base: string): Promise<void> {
  const request = route.request();
  let url = allowedUrl(request.url(), base).href;
  let method = request.method();
  let data = request.postDataBuffer() ?? undefined;
  const headers = await request.allHeaders();
  delete headers.host;
  delete headers['content-length'];
  for (let count = 0; count <= 5; count++) {
    allowedUrl(url, base);
    const response = await context.request.fetch(url, { method, headers, data, maxRedirects: 0, timeout: 15_000, failOnStatusCode: false });
    const location = response.headers().location;
    if ([301, 302, 303, 307, 308].includes(response.status()) && location) {
      url = allowedUrl(new URL(location, url).href, base).href;
      if (response.status() === 303 || ([301, 302].includes(response.status()) && method === 'POST')) {
        method = 'GET';
        data = undefined;
        delete headers['content-type'];
      }
      await response.dispose();
      continue;
    }
    await route.fulfill({ response });
    await response.dispose();
    return;
  }
  throw new Error('Demo redirect limit exceeded.');
}

export async function openDemoBrowser(base: string, onBlocked?: () => void): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  await context.route('**/*', async route => {
    // The worker reads its own DB subscription; a page's endless dashboard feed is unnecessary.
    if (route.request().resourceType() === 'eventsource') { await route.abort('blockedbyclient'); return; }
    try { await routeWithinOrigin(route, context, base); }
    catch { onBlocked?.(); await route.abort('blockedbyclient').catch(() => {}); }
  });
  // The mock forms use HTTP only. Block WebSockets, including cross-origin ones.
  await context.routeWebSocket('**/*', socket => socket.close());
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.setDefaultNavigationTimeout(20_000);
  page.on('dialog', dialog => { void dialog.dismiss(); });
  context.on('page', popup => { if (popup !== page) void popup.close(); });
  return { browser, context, page };
}

export async function inspectDemoPage(page: Page, base: string): Promise<PageDescription> {
  const url = allowedUrl(page.url(), base).href;
  const content = page.locator('[data-crawl-content]').first();
  await content.waitFor({ state: 'visible' });
  const text = (await content.innerText()).trim().slice(0, 12_000);
  const heading = content.locator('h1').first();
  const title = ((await heading.count()) ? await heading.innerText() : await page.title()).replace(/\s+/gu, ' ').trim().slice(0, 200);
  const form = content.locator('form').first();
  if (await form.count() === 0) return { url, title, text, fields: [], buttons: [], formAction: url };
  const description = await form.evaluate(element => {
    const form = element as HTMLFormElement;
    return {
      fields: Array.from(form.querySelectorAll('input,textarea,select')).filter(el => (el as HTMLInputElement).type !== 'hidden' && (el as HTMLInputElement).type !== 'submit').map(el => ({
        label: ((el as HTMLInputElement).labels?.[0]?.textContent ?? el.getAttribute('aria-label') ?? '').trim(),
        type: (el as HTMLInputElement).type || el.tagName.toLowerCase(),
      })),
      buttons: Array.from(form.querySelectorAll('button[type="submit"],button:not([type]),input[type="submit"]')).map(el => (el.textContent || (el as HTMLInputElement).value).trim()),
      formAction: form.action || location.href,
    };
  });
  allowedUrl(description.formAction, base);
  return { url, title, text, ...description };
}
