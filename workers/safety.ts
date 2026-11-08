import type { Recipe } from '../shared/contracts.ts';

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

/** URL.origin handles ports, deceptive subdomains, and protocol-relative links. */
export function allowedUrl(input: string, base: string): URL {
  const origin = new URL(base);
  const url = new URL(input, origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin.origin || url.username || url.password) {
    throw new Error('The worker can only visit the configured demo origin.');
  }
  return url;
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
  if (!Array.isArray(recipe.fields) || recipe.fields.length !== 3) throw new Error('Recipe requires the three demo fields.');
  const sources = new Set<string>();
  const labels = new Set<string>();
  const fields: Recipe['fields'] = recipe.fields.map((field: unknown) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) throw new Error('Invalid field mapping.');
    const item = field as Record<string, unknown>;
    if (Object.keys(item).some(key => !['label', 'valueFrom'].includes(key))) throw new Error('Unsupported field action.');
    if (typeof item.label !== 'string' || typeof item.valueFrom !== 'string' || !['name', 'phone', 'marker'].includes(item.valueFrom)) {
      throw new Error('Invalid field source.');
    }
    if (!page.fields.some(f => f.label === item.label) || labels.has(item.label) || sources.has(item.valueFrom)) {
      throw new Error('Recipe field is absent or duplicated.');
    }
    sources.add(item.valueFrom);
    labels.add(item.label);
    return { label: item.label, valueFrom: item.valueFrom as 'name' | 'phone' | 'marker' };
  });
  if (!page.buttons.includes(recipe.submitLabel)) throw new Error('Submit button was not observed.');
  if (recipe.successText !== 'Your request has been received') throw new Error('Unknown demo receipt confirmation.');
  return { url: url.href, fields, submitLabel: recipe.submitLabel, successText: recipe.successText };
}

export function validateAnalysis(value: unknown, page: PageDescription, base: string): Analysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Model did not return a decision object.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !['isCandidate', 'confidence', 'evidence', 'recipe'].includes(key))) {
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
    recipe: result.isCandidate ? validateRecipe(result.recipe, page, base) : null,
  };
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
      { label: 'Reference', valueFrom: 'marker' },
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
