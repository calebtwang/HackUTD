import { publicPageUrl } from '../workers/public-pages.js';

/** Local forms stay on the owned origin; public entry points are discovery-only. */
export function normalizeEntryPoints(input: unknown, agentIds: string[], base: string): Record<string,string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter a starting page for at least one agent.');
  const values = input as Record<string,unknown>;
  if (Object.keys(values).some(id => !agentIds.includes(id))) throw new Error('Unknown agent entry point.');
  const origin = new URL(base);
  const entries: Record<string,string> = {};
  for (const id of agentIds) {
    const value = values[id] ?? '';
    if (typeof value !== 'string' || value.length > 2000) throw new Error('Entry points must be page addresses.');
    const raw = value.trim();
    if (!raw) { entries[id] = ''; continue; }
    let url: URL;
    try { url = new URL(raw.startsWith('/') ? raw : /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`, origin); }
    catch { throw new Error('Enter a valid page address.'); }
    if (['localhost','127.0.0.1'].includes(url.hostname)) {
      if (url.protocol !== origin.protocol || url.username || url.password || (url.port && url.port !== origin.port)) throw new Error('Local entries must use this demo’s address and port.');
      url.hostname = origin.hostname; url.port = origin.port; url.hash = '';
      entries[id] = url.href;
    } else {
      entries[id] = publicPageUrl(url.href).href;
    }
  }
  if (!Object.values(entries).some(Boolean)) throw new Error('Enter a starting page for at least one agent.');
  return entries;
}
