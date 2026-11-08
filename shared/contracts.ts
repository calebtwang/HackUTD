export type Persona = { id: string; name: string; character: string; phone: string; voiceAgentId: string; marker: string; color: string; voiceReady: boolean };
export type DemoRun = { id: string; status: 'idle'|'running'|'stopped'|'complete'; seedUrl: string; startedAt: number };
export type Agent = Persona & { status: string; heartbeatAt: number };
export type Recipe = { url: string; fields: { label: string; valueFrom: 'name'|'phone'|'marker' }[]; submitLabel: string; successText: string };
export type Site = { id: string; runId: string; url: string; title: string; evidence: string[]; confidence: string; recipe: Recipe; status: string; discoveredBy: string; verifiedAt: number; analysisMode: 'model'|'fixture' };
export type Job = { id: string; runId: string; siteId: string; agentId: string; dueAt: number; status: string; leaseUntil: number; receiptId: string };
export type Submission = { id: string; runId: string; siteId: string; agentId: string; name: string; phone: string; marker: string; receivedAt: number };
export type DemoEvent = { id: string; runId: string; agentId: string; kind: string; message: string; timestamp: number };
export type Call = { id: string; runId: string; agentId: string; status: string; startedAt: number; durationSeconds: number; matchStatus: 'none'|'possible'|'verified'; matchedSiteId: string; evidence: string; transcript: { role: string; message: string }[]; summary: string };
export type DemoState = { run: DemoRun|null; agents: Agent[]; sites: Site[]; jobs: Job[]; submissions: Submission[]; events: DemoEvent[]; calls: Call[] };
export type SetupStatus = { database: { connected: boolean; host: string; name: string }; model: { configured: boolean; provider: string }; voice: { configured: number; total: number; webhookReady: boolean }; publicUrl: string; mode: 'live'|'rehearsal' };
export type AppSnapshot = DemoState & { setup: SetupStatus };
export const PERSONAS: Persona[] = [
  {id:'scout',name:'Mara Bell',character:'An enthusiastic gardener who always has one more question.',phone:'',voiceAgentId:'',marker:'Cedar Finch 47',color:'#b8e87b',voiceReady:false},
  {id:'finch',name:'Otis Vale',character:'A meticulous model-train hobbyist who checks every detail.',phone:'',voiceAgentId:'',marker:'Copper Meadow 62',color:'#e9b875',voiceReady:false},
  {id:'wren',name:'Nell Rowan',character:'A distracted novelist who turns everything into a story.',phone:'',voiceAgentId:'',marker:'Velvet Acorn 83',color:'#c7b3ef',voiceReady:false}
];
export const EMPTY_STATE: DemoState = {run:null,agents:[],sites:[],jobs:[],submissions:[],events:[],calls:[]};
/** Reducer contract: action + JSON payload. Backend owns validation and state transitions.
 * configure: { personas: Persona[], workerSecret: string } (admin only)
 * register_worker: { agentId, workerSecret } binds authenticated identity
 * start_run: { runId, seedUrl } (admin); stop_run: {}; reset: {} (admin)
 * agent_status: { runId, agentId, status }
 * event: { runId, agentId, kind, message }
 * discover_site: { runId, agentId, site: Site }
 * accept_submission: { runId, siteId, agentId, name, phone, marker } (admin bridge)
 * publish_site: { runId, agentId, siteId } verifies scout receipt then creates follower jobs
 * claim_job: { runId, agentId, jobId }; complete_job: { runId, agentId, jobId, receiptId }
 * call_event: { call: Call } (admin bridge, upsert idempotently)
 */
