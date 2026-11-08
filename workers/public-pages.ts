import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { chromium } from 'playwright';
import { canonicalDemoUrl } from '../shared/contracts.ts';
import type { PageDescription } from './safety.ts';

export const PUBLIC_PAGE_BYTE_LIMIT = 2 * 1024 * 1024;
export type PublicAddress = { address: string; family: 4 | 6 };
type Resolver = (hostname: string) => Promise<PublicAddress[]>;
export type PublicResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
};
export type PublicFetchOptions = {
  signal?: AbortSignal;
  lookup?: Resolver;
  request?: (url: URL, address: PublicAddress, signal: AbortSignal) => Promise<PublicResponse>;
};
export type FetchedPublicPage = { url: string; html: string; contentType: string };
export type InspectedPublicPage = PageDescription & { links: string[]; isUrlFeed: boolean };

/** Conservative public-unicast allowlist, including older ipaddr.js omissions. */
export function isPublicAddress(input: string): boolean {
  if (!isIP(input) || input.includes('%')) return false;
  const address = ipaddr.parse(input);
  if (address.range() !== 'unicast') return false;
  if (address.kind() === 'ipv4') {
    return !(address as ipaddr.IPv4).match(ipaddr.IPv4.parseCIDR('198.18.0.0/15'));
  }
  const v6 = address as ipaddr.IPv6;
  return v6.match(ipaddr.IPv6.parseCIDR('2000::/3')) &&
    !['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].some(cidr => v6.match(ipaddr.IPv6.parseCIDR(cidr)));
}

/** Syntax/literal-address guard. DNS validation happens again for every fetch. */
export function publicPageUrl(input: string, base?: string): URL {
  if (input.length > 2000 || /[\u0000-\u0020\\]/u.test(input)) throw new Error('Invalid public page URL.');
  const url = base ? new URL(input, base) : new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Public pages require HTTP or HTTPS without credentials.');
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw new Error('Public pages require the standard HTTP or HTTPS port.');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || host === 'localhost' || /\.(?:localhost|local|internal|lan|home)$/i.test(host)) throw new Error('Private hosts are not allowed.');
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new Error('Private or special-use addresses are not allowed.');
  } else if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) throw new Error('A public DNS hostname is required.');
  url.hostname = isIP(host) === 6 ? `[${host}]` : host;
  url.hash = '';
  return url;
}

export function publicPageLinks(links: string[], base: string): string[] {
  const normalized = new Set<string>();
  for (const link of links) {
    try { normalized.add(canonicalDemoUrl(publicPageUrl(link, base).href, false)); }
    catch { /* One invalid link must not discard the rest of an inspected page. */ }
    if (normalized.size === 500) break;
  }
  return [...normalized];
}

/** A URL feed is a starting list, not evidence about the listed destinations. */
function urlFeedLinks(text: string, base: string): string[] | null {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!lines.length || lines.some(line => !/^https?:\/\//i.test(line))) return null;
  return publicPageLinks(lines, base);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Public page operation timed out or was cancelled.'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Public page operation timed out or was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

const systemLookup: Resolver = async hostname => (await dnsLookup(hostname, { all: true, verbatim: true })).map(item => ({ address: item.address, family: item.family as 4 | 6 }));

export async function resolvePublicTarget(input: URL, options: { lookup?: Resolver; signal?: AbortSignal } = {}): Promise<PublicAddress> {
  const url = publicPageUrl(input.href);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(host);
  const answers = literalFamily ? [{ address: host, family: literalFamily as 4 | 6 }]
    : await abortable((options.lookup || systemLookup)(host), options.signal || AbortSignal.timeout(10_000));
  if (!answers.length || answers.length > 64 || answers.some(item => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) {
    throw new Error('DNS returned a private, special-use, or invalid address.');
  }
  // Pin one inspected address; the HTTP client must not perform another lookup.
  return answers.find(item => item.family === 4) || answers[0];
}

async function requestPinned(url: URL, address: PublicAddress, signal: AbortSignal): Promise<PublicResponse> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      protocol: url.protocol, hostname: host, port: url.port || undefined,
      path: url.pathname + url.search, method: 'GET', agent: false,
      family: address.family, autoSelectFamily: false, signal, timeout: 10_000,
      maxHeaderSize: 16 * 1024,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      headers: { 'User-Agent': 'HackUTD-ReadOnly-Demo/1.0', Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', 'Accept-Encoding': 'identity' },
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(options, (response: IncomingMessage) => resolve({
      status: response.statusCode || 0, headers: response.headers,
      body: response, close: () => response.destroy(),
    }));
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('Public page request timed out.')));
    request.on('socket', socket => socket.once('connect', () => {
      const remote = socket.remoteAddress;
      if (!remote || !isPublicAddress(remote) || ipaddr.parse(remote).toNormalizedString() !== ipaddr.parse(address.address).toNormalizedString()) {
        request.destroy(new Error('The connected address did not match the approved DNS address.'));
      }
    }));
    request.end();
  });
}

export async function fetchPublicPage(input: string, options: PublicFetchOptions = {}): Promise<FetchedPublicPage> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  let url = publicPageUrl(input);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const address = await resolvePublicTarget(url, { lookup: options.lookup, signal });
    const response = await abortable((options.request || requestPinned)(url, address, signal), signal);
    try {
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.status) && typeof location === 'string') {
        if (redirects === 3) throw new Error('Public page redirect limit exceeded.');
        url = publicPageUrl(location, url.href);
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`Public page returned HTTP ${response.status}.`);
      const contentType = String(response.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
      if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(contentType)) throw new Error('Skipping a non-HTML/text response.');
      const encoding = response.headers['content-encoding'];
      if (encoding && encoding !== 'identity') throw new Error('Compressed responses are not accepted by the bounded reader.');
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > PUBLIC_PAGE_BYTE_LIMIT) throw new Error('Public page exceeds the 2 MB limit.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      const iterator = response.body[Symbol.asyncIterator]();
      while (true) {
        const next = await abortable(iterator.next(), signal);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > PUBLIC_PAGE_BYTE_LIMIT) throw new Error('Public page exceeds the 2 MB limit.');
        chunks.push(next.value);
      }
      const body = Buffer.concat(chunks);
      return { url: url.href, html: body.toString('utf8'), contentType };
    } finally { response.close(); }
  }
  throw new Error('Public page redirect limit exceeded.');
}

/** Parse fetched bytes without navigating to the site or running any page script. */
export async function inspectPublicPage(fetched: FetchedPublicPage): Promise<InspectedPublicPage> {
  if (Buffer.byteLength(fetched.html, 'utf8') > PUBLIC_PAGE_BYTE_LIMIT) throw new Error('Public page exceeds the 2 MB limit.');
  const plainFeed = fetched.contentType === 'text/plain' ? urlFeedLinks(fetched.html, fetched.url) : null;
  if (plainFeed !== null) {
    return { url: fetched.url, title: new URL(fetched.url).hostname, text: fetched.html.slice(0, 12_000), fields: [], buttons: [], formAction: fetched.url, links: plainFeed, isUrlFeed: true };
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
    await context.setOffline(true);
    await context.route('**/*', route => route.abort('blockedbyclient'));
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    await page.setContent(fetched.contentType === 'text/plain' ? `<main><pre>${escape(fetched.html)}</pre></main>` : fetched.html, { waitUntil: 'domcontentloaded', timeout: 5_000 });
    const observed = await page.evaluate(() => {
      const content = document.querySelector('[data-crawl-content]') || document.querySelector('main') || document.body;
      return {
        title: (content.querySelector('h1')?.textContent || document.title || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        text: (content as HTMLElement).innerText.trim(),
        fields: Array.from(content.querySelectorAll('form input,form textarea,form select')).filter(el => !['hidden', 'submit', 'button'].includes((el as HTMLInputElement).type)).slice(0, 40).map(el => ({ label: ((el as HTMLInputElement).labels?.[0]?.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 150), type: (el as HTMLInputElement).type || el.tagName.toLowerCase() })),
        buttons: Array.from(content.querySelectorAll('form button,form input[type="submit"]')).slice(0, 20).map(el => (el.textContent || (el as HTMLInputElement).value || '').trim().slice(0, 150)),
        action: content.querySelector('form')?.getAttribute('action') || '',
        links: Array.from(content.querySelectorAll('a[href]')).slice(0, 500).map(el => el.getAttribute('href') || ''),
      };
    });
    const htmlFeed = observed.fields.length ? null : urlFeedLinks(observed.text, fetched.url);
    const links = publicPageLinks([...observed.links, ...(htmlFeed || [])], fetched.url);
    let formAction = fetched.url;
    try { formAction = new URL(observed.action, fetched.url).href; } catch { /* Observation only; never followed. */ }
    return { url: fetched.url, title: observed.title || new URL(fetched.url).hostname, text: observed.text.slice(0, 12_000), fields: observed.fields, buttons: observed.buttons, formAction, links, isUrlFeed: htmlFeed !== null };
  } finally { await browser.close(); }
}
