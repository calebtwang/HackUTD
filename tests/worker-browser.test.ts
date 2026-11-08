import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { openDemoBrowser, inspectDemoPage } from '../workers/browser.ts';
import { inspectPublicPage, PUBLIC_PAGE_BYTE_LIMIT } from '../workers/public-pages.ts';
import { classifyFixture, ownedPageLinks, submissionUrl, validateRecipe } from '../workers/safety.ts';

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

test('owned redirects record their final URL and preserve relative forms and receipt identity', async () => {
  let accepted: { path: string; query: string; body: string } | undefined;
  const inside = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture.invalid');
    if (url.pathname === '/') { res.writeHead(302, { Location: `/hop${url.search}` }); res.end(); return; }
    if (url.pathname === '/hop') { res.writeHead(307, { Location: `/offers/phishing${url.search}` }); res.end(); return; }
    if (url.pathname === '/offers/submit') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        accepted = { path: url.pathname, query: url.search, body };
        res.setHeader('Content-Type', 'text/html');
        res.end('<p data-receipt-id="run:site:scout">Your request has been received</p>');
      });
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    if (url.pathname === '/plain') { res.end('<main data-crawl-content><h1>Another page</h1></main>'); return; }
    res.end(`<main data-crawl-content><h1>Owned offer</h1><a href="details">Details</a><form action="submit${url.search}" method="post"><label>Full name<input name="name"></label><label>Phone number<input name="phone"></label><button>Request callback</button></form></main>`);
  });
  const base = await listen(inside);
  let session: Awaited<ReturnType<typeof openDemoBrowser>> | undefined;
  try {
    session = await openDemoBrowser(base);
    const query = '?runId=run&siteId=site&agentId=scout';
    await session.page.goto(`${base}/${query}`, { waitUntil: 'domcontentloaded' });
    const observed = await inspectDemoPage(session.page, base);
    assert.equal(observed.url, `${base}/offers/phishing${query}`);
    assert.equal(session.page.url(), observed.url, 'The browser address must agree with the recorded destination');
    assert.equal(observed.formAction, `${base}/offers/submit${query}`);
    assert.equal(await session.page.getByRole('link', { name: 'Details' }).evaluate(element => (element as HTMLAnchorElement).href), `${base}/offers/details`);
    const recipe = validateRecipe({ url: observed.url, fields: [{ label: 'Full name', valueFrom: 'name' }, { label: 'Phone number', valueFrom: 'phone' }], submitLabel: 'Request callback', successText: 'Your request has been received' }, observed, base);
    assert.equal(submissionUrl(recipe, base, 'run', 'site', 'scout'), observed.url);
    await session.page.getByLabel('Full name').fill('Demo Person');
    await session.page.getByLabel('Phone number').fill('DEMO-SCOUT');
    await session.page.getByRole('button', { name: 'Request callback' }).click();
    await session.page.getByText('Your request has been received').waitFor();
    assert.equal(await session.page.locator('[data-receipt-id]').getAttribute('data-receipt-id'), 'run:site:scout');
    assert.equal(accepted?.path, '/offers/submit');
    assert.equal(accepted?.query, query);
    assert.equal(new URLSearchParams(accepted?.body).get('name'), 'Demo Person');
    assert.equal(new URLSearchParams(accepted?.body).get('phone'), 'DEMO-SCOUT');
    await session.page.goto(`${base}/plain`, { waitUntil: 'domcontentloaded' });
    assert.equal((await inspectDemoPage(session.page, base)).url, `${base}/plain`, 'A later navigation must not reuse an old redirect');
  } finally {
    await session?.browser.close();
    await close(inside);
  }
});

test('configured forum discovery reaches bank forms for both agents without permitting forum writes', async () => {
  const receipts: { agentId: string; name: string; phone: string }[] = [];
  let forumWrites = 0;
  let bank = '';
  let forum = '';
  const forumServer = createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method!)) { forumWrites++; res.end('unexpected write'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<main data-crawl-content><h1>Community forum</h1><a href="${bank}/phishing">Offer</a><a href="/article">News</a></main>`);
  });
  forum = await listen(forumServer);
  const bankServer = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture.invalid');
    if (url.pathname === '/forum') { res.writeHead(302, { Location: `${forum}/` }); res.end(); return; }
    if (url.pathname === '/forward') { res.writeHead(307, { Location: `${forum}/submit` }); res.end(); return; }
    if (url.pathname === '/submit') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        const fields = new URLSearchParams(body);
        const agentId = url.searchParams.get('agentId')!;
        assert.equal(url.searchParams.get('runId'), 'run');
        assert.equal(url.searchParams.get('siteId'), 'bank-site');
        receipts.push({ agentId, name: fields.get('name')!, phone: fields.get('phone')! });
        res.setHeader('Content-Type', 'text/html');
        res.end(`<p data-receipt-id="run:bank-site:${agentId}">Your request has been received</p>`);
      });
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<main data-crawl-content><h1>Claim your guaranteed prize today</h1><form action="/submit${url.search}" method="post"><label>Full name<input name="name"></label><label>Phone number<input name="phone"></label><button>Request callback</button></form></main>`);
  });
  bank = await listen(bankServer);
  const sessions: Awaited<ReturnType<typeof openDemoBrowser>>[] = [];
  try {
    for (const agentId of ['scout', 'finch']) {
      const session = await openDemoBrowser(bank, undefined, [forum]);
      sessions.push(session);
      // Cover both the explicit forum root and the legacy bank /forum redirect.
      await session.page.goto(agentId === 'scout' ? `${bank}/forum` : `${forum}/`, { waitUntil: 'domcontentloaded' });
      const listing = await inspectDemoPage(session.page, bank, [forum]);
      assert.equal(listing.url, `${forum}/`);
      assert.deepEqual(listing.fields, []);
      const hrefs = await session.page.locator('[data-crawl-content] a').evaluateAll(elements => elements.map(element => (element as HTMLAnchorElement).href));
      const links = ownedPageLinks(hrefs, bank, [forum]);
      assert.deepEqual(links, [`${bank}/phishing`, `${forum}/article`]);
      await session.page.goto(links[0], { waitUntil: 'domcontentloaded' });
      const observed = await inspectDemoPage(session.page, bank);
      const analysis = classifyFixture(observed, bank);
      assert.equal(analysis.isCandidate, true);
      assert.ok(analysis.recipe);
      await session.page.goto(submissionUrl(analysis.recipe, bank, 'run', 'bank-site', agentId), { waitUntil: 'domcontentloaded' });
      const submissionPage = await inspectDemoPage(session.page, bank);
      validateRecipe({ ...analysis.recipe, url: submissionPage.url }, submissionPage, bank);
      await session.page.getByLabel('Full name').fill(`Demo ${agentId}`);
      await session.page.getByLabel('Phone number').fill(`DEMO-${agentId.toUpperCase()}`);
      await session.page.getByRole('button', { name: 'Request callback' }).click();
      await session.page.getByText('Your request has been received').waitFor();
      assert.equal(await session.page.locator('[data-receipt-id]').getAttribute('data-receipt-id'), `run:bank-site:${agentId}`);
      const canWrite = await session.page.evaluate(async url => {
        try { await fetch(url, { method: 'POST', body: 'synthetic' }); return true; }
        catch { return false; }
      }, `${bank}/forward`);
      assert.equal(canWrite, false, 'A POST redirect cannot turn the read-only forum into a submission target');
    }
    assert.deepEqual(receipts, [
      { agentId: 'scout', name: 'Demo scout', phone: 'DEMO-SCOUT' },
      { agentId: 'finch', name: 'Demo finch', phone: 'DEMO-FINCH' },
    ]);
    assert.equal(forumWrites, 0);
  } finally {
    for (const session of sessions) await session.browser.close();
    await close(bankServer);
    await close(forumServer);
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
