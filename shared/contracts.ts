export type Persona = { id: string; name: string; character: string; phone: string; voiceAgentId: string; color: string; voiceReady: boolean };
export type DemoRun = { id: string; status: 'idle'|'running'|'stopped'|'complete'; seedUrl: string; startedAt: number; entryPoints?: Record<string, string>; discoveryCompleteIds?: string[]; mode?: 'live'|'rehearsal' };
export type Agent = Persona & { status: string; heartbeatAt: number };
export type Recipe = { url: string; fields: { label: string; valueFrom: 'name'|'phone' }[]; submitLabel: string; successText: string };
export type InspectionStatus = 'pending'|'inspecting'|'inspected'|'unavailable'|'analysis_failed'|'not_flagged';
export type Site = { id: string; runId: string; url: string; title: string; evidence: string[]; confidence: string; recipe: Recipe|null; status: string; discoveredBy: string; verifiedAt: number; analysisMode: 'model'|'fixture'|'feed'; submissionAllowed?: boolean; observedFields?: string[]; observedButtons?: string[]; observedFormAction?: string; sourceUrl?: string; sourceLabel?: string; inspectionStatus?: InspectionStatus; inspectionMessage?: string };
export type Job = { id: string; runId: string; siteId: string; agentId: string; dueAt: number; status: string; leaseUntil: number; receiptId: string };
export type Submission = { id: string; runId: string; siteId: string; agentId: string; name: string; phone: string; receivedAt: number };
export type DemoEvent = { id: string; runId: string; agentId: string; kind: string; message: string; timestamp: number };
export type Call = { id: string; runId: string; agentId: string; status: string; startedAt: number; durationSeconds: number; matchStatus: 'none'|'possible'|'verified'; matchedSiteId: string; evidence: string; transcript: { role: string; message: string }[]; summary: string };
export type DemoState = { run: DemoRun|null; agents: Agent[]; sites: Site[]; jobs: Job[]; submissions: Submission[]; events: DemoEvent[]; calls: Call[] };
export type SetupStatus = { database: { connected: boolean; host: string; name: string }; model: { configured: boolean; provider: string }; voice: { configured: number; total: number; webhookReady: boolean }; publicUrl: string; mode: 'live'|'rehearsal' };
export type AppSnapshot = DemoState & { setup: SetupStatus };
export const PERSONAS: Persona[] = [
  {id:'scout',name:'Mara Bell',character:'An enthusiastic gardener who always has one more question.',phone:'',voiceAgentId:'',color:'#b8e87b',voiceReady:false},
  {id:'finch',name:'Otis Vale',character:'A meticulous model-train hobbyist who checks every detail.',phone:'',voiceAgentId:'',color:'#e9b875',voiceReady:false},
];
export const EMPTY_STATE: DemoState = {run:null,agents:[],sites:[],jobs:[],submissions:[],events:[],calls:[]};

/** Shared URL identity without browser-only globals, also usable in a reducer. */
export function canonicalDemoUrl(value: string, stripExecutionMetadata = true): string {
  if (typeof value !== 'string' || /[\s\\]/u.test(value)) throw new Error('Invalid demo URL');
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(?:#.*)?$/i.exec(value);
  if (!match) throw new Error('Only HTTP demo URLs are accepted');
  const protocol = match[1].toLowerCase();
  const authority = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]+))?$/i.exec(match[2]);
  if (!authority) throw new Error('Demo URL must use an ordinary host without credentials');
  const host = authority[1].toLowerCase();
  const port = authority[2] ? Number(authority[2]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) throw new Error('Invalid demo URL port');
  const portText = port === undefined || (protocol === 'http' && port === 80) || (protocol === 'https' && port === 443) ? '' : `:${port}`;
  const encode = (part: string) => encodeURIComponent(part).replace(/[!'()~]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`).replaceAll('%20', '+');
  const metadata = new Set(['runId', 'siteId', 'agentId', 'run', 'site', 'agent']);
  const params: { key: string; value: string; index: number }[] = [];
  for (const [index, pair] of (match[4]?.slice(1).split('&') ?? []).entries()) {
    if (!pair) continue;
    const split = pair.indexOf('=');
    const key = decodeURIComponent((split < 0 ? pair : pair.slice(0, split)).replaceAll('+', ' '));
    const item = decodeURIComponent((split < 0 ? '' : pair.slice(split + 1)).replaceAll('+', ' '));
    if (!stripExecutionMetadata || !metadata.has(key)) params.push({ key, value: item, index });
  }
  params.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index);
  const query = params.map(item => `${encode(item.key)}=${encode(item.value)}`).join('&');
  return `${protocol}://${host}${portText}${match[3] || '/'}${query ? `?${query}` : ''}`;
}
/** Reducer contract: action + JSON payload. Backend owns validation and state transitions.
 * configure: { personas: Persona[], workerSecret: string } (admin only)
 * register_worker: { agentId, workerSecret } binds authenticated identity
 * start_run: { runId, seedUrl, entryPoints: { scout: string, finch: string }, mode?: 'live'|'rehearsal' } (admin)
 * New runs persist mode; omitted mode defaults to rehearsal. Legacy snapshots may omit it.
 * seedUrl anchors the owned submission origin. Entry points may be public HTTP(S); server/worker enforce public-host/DNS guards.
 * A blank entry point means wait for shared jobs; at least one must be nonblank.
 * stop_run: {}; reset: {} (admin)
 * agent_status: { runId, agentId, status }
 * event: { runId, agentId, kind, message }
 * discover_site: { runId, agentId, site: Site }; canonical URL is transactionally unique per run.
 * Duplicate discovery keeps the original ID/discoveredBy; workers read the canonical site from the next snapshot.
 * Non-owned sites are always observation-only: submissionAllowed:false, recipe:null, no submission jobs.
 * report_feed: {runId,agentId,sourceUrl,urls:string[]} imports at most50 external URLs per action.
 * Imports are unassessed feed reports, preserve prior inspections, and never create submission jobs.
 * inspect_site: {runId,agentId,siteId,inspectionStatus,inspectionMessage?,title?,observedFields?,observedButtons?,observedFormAction?,analysisMode?,confidence?,evidence?}
 * Only existing external sites can be enriched. inspected is a review candidate, not_flagged a negative decision.
 * Those two statuses require model/fixture analysisMode and confidence; inspected also requires nonempty evidence.
 * Observed form actions are inert untrusted text, never executable recipes or permitted navigation targets.
 * discovery_complete: { runId, agentId } idempotent telemetry after a scan pass; future discoveries remain allowed.
 * Runs stay running while agents poll and scan. Only explicit stop_run or reset ends ongoing discovery.
 * accept_submission: { runId, siteId, agentId, name, phone } (admin bridge)
 * publish_site: { runId, agentId, siteId } original discoverer verifies own receipt then creates other agents' delayed jobs
 * claim_job: { runId, agentId, jobId }; complete_job: { runId, agentId, jobId, receiptId }
 * call_event: { call: Call } (admin bridge, upsert idempotently)
 */
