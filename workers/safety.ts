import { canonicalDemoUrl, type Recipe } from '../shared/contracts.ts';

export type PageDescription = {
  url: string;
  title: string;
  text: string;
  fields: { label: string; type: string }[];
  buttons: string[];
  formAction: string;
};

export type Analysis = {
  isCandidate: boolean;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  recipe: Recipe | null;
};
export type ReadOnlyAnalysis = Omit<Analysis, 'recipe'>;

/** Feed membership is not a completed inspection, even after a failed attempt. */
export function publicInspectionNeeded(site?: { inspectionStatus?: string; sourceUrl?: string }): boolean {
  return !site || site.inspectionStatus !== 'inspected' && (!!site.sourceUrl || !!site.inspectionStatus);
}

export function observedFormDetails(page: PageDescription): { title: string; observedFields: string[]; observedButtons: string[]; observedFormAction?: string } {
  return {
    title: page.title.trim().slice(0, 200) || new URL(page.url).hostname,
    observedFields: page.fields.slice(0, 40).map(field => field.label.trim().slice(0, 100)).filter(Boolean),
    observedButtons: page.buttons.slice(0, 20).map(button => button.trim().slice(0, 100)).filter(Boolean),
    ...(page.formAction && page.formAction.length <= 2000 ? { observedFormAction: page.formAction } : {}),
  };
}

/** URL.origin handles ports, deceptive subdomains, and protocol-relative links. */
export function allowedUrl(input: string, base: string): URL {
  const origin = new URL(base);
  const url = new URL(input, origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin.origin || url.username || url.password) {
    throw new Error('The worker can only visit the configured demo origin.');
  }
  return url;
}

/** Only deployment configuration, never a page or model, grants another read origin. */
export function configuredReadOrigins(forumOrigin?: string): string[] {
  if (!forumOrigin?.trim()) return [];
  const url = new URL(forumOrigin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('FORUM_PUBLIC_ORIGIN must be an exact HTTP(S) origin.');
  }
  return [url.origin];
}

export function allowedDiscoveryUrl(input: string, base: string, readOrigins: readonly string[] = [], method = 'GET'): URL {
  const url = new URL(input, base);
  if (url.origin === new URL(base).origin) return allowedUrl(url.href, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !readOrigins.includes(url.origin) || !['GET', 'HEAD'].includes(method.toUpperCase())) {
    throw new Error('The worker may only read configured forum origins and submit to the demo origin.');
  }
  return url;
}

export function canonicalDiscoveryUrl(input: string, base: string, readOrigins: readonly string[] = []): string {
  const url = allowedDiscoveryUrl(input, base, readOrigins);
  return canonicalDemoUrl(url.href, url.origin === new URL(base).origin);
}

/** Keep worker navigation and transactional database URL de-duplication aligned. */
export function canonicalPageUrl(input: string, base: string): string {
  return canonicalDemoUrl(allowedUrl(input, base).href);
}

/** Any owned path can be an entry or link; external links never enter the queue. */
export function ownedPageLinks(links: string[], base: string, readOrigins: readonly string[] = []): string[] {
  const result = new Set<string>();
  for (const link of links) {
    try { result.add(canonicalDiscoveryUrl(link, base, readOrigins)); }
    catch { /* A page may link outside the owned demonstration. */ }
  }
  return [...result];
}

export function validateRecipe(value: unknown, page: PageDescription, base: string): Recipe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing form recipe.');
  const recipe = value as Record<string, unknown>;
  if (Object.keys(recipe).some(key => !['url', 'fields', 'submitLabel', 'successText'].includes(key))) {
    throw new Error('Recipe contains unsupported actions.');
  }
  if (typeof recipe.url !== 'string' || typeof recipe.submitLabel !== 'string' || typeof recipe.successText !== 'string') {
    throw new Error('Recipe text is invalid.');
  }
  const url = allowedUrl(recipe.url, base);
  const actual = allowedUrl(page.url, base);
  if (url.href !== actual.href) throw new Error('Recipe must refer to the inspected page.');
  allowedUrl(page.formAction, base);
  if (!Array.isArray(recipe.fields) || recipe.fields.length !== 2 || page.fields.length !== 2) throw new Error('Recipe requires only the two observed name and phone fields.');
  const sources = new Set<string>();
  const labels = new Set<string>();
  const fields: Recipe['fields'] = recipe.fields.map((field: unknown) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) throw new Error('Invalid field mapping.');
    const item = field as Record<string, unknown>;
    if (Object.keys(item).some(key => !['label', 'valueFrom'].includes(key))) throw new Error('Unsupported field action.');
    if (typeof item.label !== 'string' || typeof item.valueFrom !== 'string' || !['name', 'phone'].includes(item.valueFrom)) {
      throw new Error('Invalid field source.');
    }
    if (!page.fields.some(f => f.label === item.label) || labels.has(item.label) || sources.has(item.valueFrom)) {
      throw new Error('Recipe field is absent or duplicated.');
    }
    sources.add(item.valueFrom);
    labels.add(item.label);
    return { label: item.label, valueFrom: item.valueFrom as 'name' | 'phone' };
  });
  if (!page.buttons.includes(recipe.submitLabel)) throw new Error('Submit button was not observed.');
  if (recipe.successText !== 'Your request has been received') throw new Error('Unknown demo receipt confirmation.');
  return { url: url.href, fields, submitLabel: recipe.submitLabel, successText: recipe.successText };
}

function validateDecision(value: unknown, page: PageDescription, keys: string[]): ReadOnlyAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Model did not return a decision object.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) {
    throw new Error('Unexpected model decision fields.');
  }
  if (typeof result.isCandidate !== 'boolean' || !['high', 'medium', 'low'].includes(String(result.confidence))) {
    throw new Error('Invalid model classification.');
  }
  // A heading split across visual lines can be quoted as one sentence. Only
  // whitespace may differ; every word and punctuation mark must still occur.
  const normalizeWhitespace = (text: string) => text.replace(/\s+/gu, ' ').trim();
  const observedText = normalizeWhitespace(page.text);
  if (!Array.isArray(result.evidence) || result.evidence.length > 4 || result.evidence.some(e => typeof e !== 'string' || !e.trim() || e.length > 300 || !observedText.includes(normalizeWhitespace(e)))) {
    throw new Error('Evidence must quote text from the inspected content.');
  }
  if (result.isCandidate && result.evidence.length === 0) throw new Error('Candidate classification requires observed evidence.');
  return {
    isCandidate: result.isCandidate,
    confidence: result.confidence as Analysis['confidence'],
    evidence: (result.evidence as string[]).map(normalizeWhitespace),
  };
}

export function validateAnalysis(value: unknown, page: PageDescription, base: string): Analysis {
  const result = validateDecision(value, page, ['isCandidate', 'confidence', 'evidence', 'recipe']);
  return { ...result, recipe: result.isCandidate ? validateRecipe((value as Record<string, unknown>).recipe, page, base) : null };
}

export function validateReadOnlyAnalysis(value: unknown, page: PageDescription): ReadOnlyAnalysis {
  return validateDecision(value, page, ['isCandidate', 'confidence', 'evidence']);
}

/** Explicit rule-based rehearsal can observe arbitrary fields but cannot submit. */
export function classifyReadOnlyFixture(page: PageDescription): ReadOnlyAnalysis {
  const signals = [
    /guaranteed|selected|winner|reward|prize|refund|grant|gift|claim/i,
    /expire|minutes|urgent|limited|act now|today|verify|verification/i,
    /phone|callback|call|password|login|account/i,
  ];
  const paragraphs = page.text.split(/\n+/).map(text => text.trim()).filter(Boolean);
  const evidence = [...new Set(signals.map(signal => paragraphs.find(text => signal.test(text))?.slice(0, 300)).filter((text): text is string => !!text))];
  return { isCandidate: signals.every(signal => signal.test(page.text)), confidence: signals.every(signal => signal.test(page.text)) ? 'medium' : 'low', evidence };
}

/** An explicitly selected fixture rehearsal, never an automatic model fallback. */
export function classifyFixture(page: PageDescription, base: string): Analysis {
  const signals = [
    /guaranteed|selected|winner|reward|prize|refund|grant|gift|claim/i,
    /expire|minutes|urgent|limited|act now|today|verify|verification/i,
    /phone|callback|call/i,
  ];
  const paragraphs = page.text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const evidence = [...new Set(signals.map(signal => paragraphs.find(s => signal.test(s))?.slice(0, 300)).filter((s): s is string => !!s))];
  const isCandidate = signals.every(signal => signal.test(page.text));
  if (!isCandidate) return { isCandidate: false, confidence: 'low', evidence, recipe: null };
  const recipe = validateRecipe({
    url: page.url,
    fields: [
      { label: 'Full name', valueFrom: 'name' },
      { label: 'Phone number', valueFrom: 'phone' },
    ],
    submitLabel: 'Request callback',
    successText: 'Your request has been received',
  }, page, base);
  return { isCandidate: true, confidence: 'high', evidence, recipe };
}

export function submissionUrl(recipe: Recipe, base: string, runId: string, siteId: string, agentId: string): string {
  const url = allowedUrl(recipe.url, base);
  url.searchParams.set('runId', runId);
  url.searchParams.set('siteId', siteId);
  url.searchParams.set('agentId', agentId);
  return url.href;
}
