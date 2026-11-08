import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { openDemoBrowser, inspectDemoPage } from '../workers/browser.ts';
import { inspectPublicPage, PUBLIC_PAGE_BYTE_LIMIT } from '../workers/public-pages.ts';

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
    res.end(`<title>Owned fixture</title><aside>DEMO banner is excluded</aside><main data-crawl-content><h1>Your household could receive<br>$750.</h1><p>Selected for a prize today; request a callback.</p><form action="/submit" method="post"><label>Full name<input name="name"></label><label>Phone number<input name="phone"></label><button type="submit">Request callback</button></form><img src="${otherOrigin}/pixel"></main>`);
  });
  const base = await listen(inside);
  let session: Awaited<ReturnType<typeof openDemoBrowser>> | undefined;
  try {
    session = await openDemoBrowser(base);
    await session.page.goto(base, { waitUntil: 'domcontentloaded' });
    const observed = await inspectDemoPage(session.page, base);
    assert.equal(observed.title, 'Your household could receive $750.');
    assert.equal(observed.text.includes('DEMO banner'), false);
    assert.deepEqual(observed.fields.map(field => field.label), ['Full name', 'Phone number']);
    await session.page.getByLabel('Full name').fill('Demo Person');
    await session.page.getByLabel('Phone number').fill('DEMO-SCOUT');
    await session.page.getByRole('button', { name: 'Request callback' }).click();
    await session.page.getByText('Your request has been received').waitFor();
    assert.match(accepted, /name=Demo\+Person/);
    assert.match(accepted, /phone=DEMO-SCOUT/);
    assert.equal(new URLSearchParams(accepted).has('marker'), false);
    await assert.rejects(session.page.goto(`${base}/bounce`, { waitUntil: 'domcontentloaded' }));
    assert.equal(outsideRequests, 0, 'Neither an external resource nor a redirect should reach the other server');
  } finally {
    await session?.browser.close();
    await close(inside);
    await close(outside);
  }
});

test('public HTML is parsed offline without scripts, resources or form submissions', async () => {
  let requests = 0;
  const outside = createServer((_req, res) => { requests++; res.end('unexpected'); });
  const destination = await listen(outside);
  try {
    const observed = await inspectPublicPage({
      url: 'https://example.com/forum/start?site=bank', contentType: 'text/html',
      html: `<head><base href="${destination}/"><script>document.body.innerHTML='executed';fetch('${destination}/script')</script></head><main><h1>Public offer</h1><p>Verify account today.</p><form method="post" action="${destination}/capture"><label>Email<input name="email"></label><label>Password<input type="password" name="password"></label><input type="hidden" name="csrf" value="secret"><button>Verify</button></form><img src="${destination}/pixel"><iframe src="${destination}/frame"></iframe><link rel="preconnect" href="${destination}"><a href="../next?site=bank&agent=alpha">Next</a><a href="https://another.example/form">Other site</a><a href="${destination}/private">Private</a><a href="javascript:alert(1)">Script link</a></main>`,
    });
    assert.equal(observed.title, 'Public offer');
    assert.equal(observed.isUrlFeed, false);
    assert.match(observed.text, /Verify account today/);
    assert.equal(observed.text.includes('executed'), false);
    assert.deepEqual(observed.fields, [{ label: 'Email', type: 'text' }, { label: 'Password', type: 'password' }]);
    assert.deepEqual(observed.links, ['https://example.com/next?agent=alpha&site=bank', 'https://another.example/form']);
    assert.equal(observed.formAction, `${destination}/capture`, 'Form destination is only observed metadata');
    assert.equal(requests, 0);
  } finally { await close(outside); }
});

test('plain URL feeds supply bounded public links without treating the feed as a candidate page', async () => {
  const rows = [
    '# URLs reported by a feed; this header is not target evidence',
    'https://example.com/offer?site=bank&agent=a',
    'https://example.com/offer?agent=a&site=bank#form',
    'http://127.0.0.1/private', 'http://[::ffff:127.0.0.1]/',
    'https://localhost/secret', 'https://example.com:8080/',
    'https://user:pass@example.com/', 'https://example.com/broken?q=%', 'http://',
    ...Array.from({ length: 520 }, (_, index) => `https://target.example/${index}?site=${'a'.repeat(35)}`),
  ];
  const observed = await inspectPublicPage({ url: 'https://feeds.example/list.txt', contentType: 'text/plain', html: rows.join('\r\n') });
  assert.equal(observed.isUrlFeed, true);
  assert.equal(observed.links.length, 500);
  assert.equal(observed.links[0], 'https://example.com/offer?agent=a&site=bank');
  assert.equal(observed.links.at(-1), `https://target.example/498?site=${'a'.repeat(35)}`, 'Extraction must examine beyond the 12,000-character model text limit');
  assert.deepEqual(observed.fields, []);
  assert.ok(observed.text.length <= 12_000);
  await assert.rejects(inspectPublicPage({ url: 'https://feeds.example/list.txt', contentType: 'text/plain', html: 'x'.repeat(PUBLIC_PAGE_BYTE_LIMIT + 1) }), /2 MB/);
});

test('bare HTML URL lists are recognized, while ordinary prose is not a feed', async () => {
  const list = await inspectPublicPage({ url: 'https://feeds.example/list', contentType: 'text/html', html: '<main><pre>https://example.com/one\nhttps://example.com/two\nhttp://127.0.0.1/private</pre></main>' });
  assert.equal(list.isUrlFeed, true);
  assert.deepEqual(list.links, ['https://example.com/one', 'https://example.com/two']);
  const prose = await inspectPublicPage({ url: 'https://feeds.example/page.txt', contentType: 'text/plain', html: 'An ordinary explanation.\nhttps://example.com/offer' });
  assert.equal(prose.isUrlFeed, false);
  assert.deepEqual(prose.links, []);
});
