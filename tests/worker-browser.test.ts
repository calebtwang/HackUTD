import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { openDemoBrowser, inspectDemoPage } from '../workers/browser.ts';

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('browser can submit owned forms but prevents network access across an external redirect', async () => {
  let outsideRequests = 0;
  let accepted = '';
  const outside = createServer((_req, res) => { outsideRequests++; res.end('outside'); });
  const otherOrigin = await listen(outside);
  const inside = createServer((req, res) => {
    if (req.url === '/bounce') { res.writeHead(302, { Location: '/leave' }); res.end(); return; }
    if (req.url === '/leave') { res.writeHead(302, { Location: `${otherOrigin}/capture` }); res.end(); return; }
    if (req.url === '/submit') {
      req.on('data', chunk => { accepted += chunk.toString(); });
      req.on('end', () => { res.setHeader('Content-Type', 'text/html'); res.end('<p>Your request has been received</p>'); });
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Owned fixture</title><aside>DEMO banner is excluded</aside><main data-crawl-content><h1>Your household could receive<br>$750.</h1><p>Selected for a prize today; request a callback.</p><form action="/submit" method="post"><label>Full name<input name="name"></label><label>Phone number<input name="phone"></label><label>Reference<input name="marker"></label><button type="submit">Request callback</button></form><img src="${otherOrigin}/pixel"></main>`);
  });
  const base = await listen(inside);
  let session: Awaited<ReturnType<typeof openDemoBrowser>> | undefined;
  try {
    session = await openDemoBrowser(base);
    await session.page.goto(base, { waitUntil: 'domcontentloaded' });
    const observed = await inspectDemoPage(session.page, base);
    assert.equal(observed.title, 'Your household could receive $750.');
    assert.equal(observed.text.includes('DEMO banner'), false);
    assert.deepEqual(observed.fields.map(field => field.label), ['Full name', 'Phone number', 'Reference']);
    await session.page.getByLabel('Full name').fill('Demo Person');
    await session.page.getByLabel('Phone number').fill('DEMO-SCOUT');
    await session.page.getByLabel('Reference').fill('Cedar Finch 47');
    await session.page.getByRole('button', { name: 'Request callback' }).click();
    await session.page.getByText('Your request has been received').waitFor();
    assert.match(accepted, /name=Demo\+Person/);
    await assert.rejects(session.page.goto(`${base}/bounce`, { waitUntil: 'domcontentloaded' }));
    assert.equal(outsideRequests, 0, 'Neither an external resource nor a redirect should reach the other server');
  } finally {
    await session?.browser.close();
    await close(inside);
    await close(outside);
  }
});
