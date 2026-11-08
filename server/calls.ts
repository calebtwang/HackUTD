import type { Agent, Call, DemoState, Submission } from '../shared/contracts.js';

function normalizeName(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').trim();
}
function containsName(text: string, name: string): boolean {
  const normalized = normalizeName(name);
  return normalized.split(' ').length >= 2 && ` ${normalizeName(text)} `.includes(` ${normalized} `);
}
/** A name can suggest a source only when it was submitted to exactly one site. */
export function possibleMatch(text: string, rows: Submission[]): Submission|undefined {
  const matches = rows.filter(row => containsName(text, row.name));
  return new Set(matches.map(row => row.siteId)).size === 1 ? matches[0] : undefined;
}
/** Caller-first name mentions remain possible associations, never proof of site access. */
export function callerNameMention(transcript: Call['transcript'], rows: Submission[]): { submission: Submission; evidence: string }|undefined {
  const disclosed = new Set<string>();
  for (const turn of transcript) {
    if (turn.role === 'agent' || turn.role === 'assistant') {
      for (const row of rows) if (containsName(turn.message, row.name)) disclosed.add(normalizeName(row.name));
    } else if (turn.role === 'user' || turn.role === 'caller') {
      const match = possibleMatch(turn.message, rows);
      if (match && !disclosed.has(normalizeName(match.name))) return { submission: match, evidence: turn.message.slice(0, 1000) };
    }
  }
  return undefined;
}
export function findAgent(state: DemoState, providerAgentId: string): Agent|undefined {
  return state.agents.find(agent => agent.voiceAgentId && agent.voiceAgentId === providerAgentId);
}
export function buildCall(state: DemoState, agent: Agent, id: string): Call {
  const existing = state.calls.find(call => call.id === id);
  return existing || {id,runId:state.run?.id || '',agentId:agent.id,status:'active',startedAt:Date.now(),durationSeconds:0,matchStatus:'none',matchedSiteId:'',evidence:'',transcript:[],summary:''};
}
/** A delayed provider webhook must not attach a previous call to a newly reset run. */
export function callRunStatus(state: DemoState, id: string, providerStartSeconds: unknown): 'current'|'old'|'unknown' {
  if (!state.run) return 'unknown';
  const startedAt = Number(providerStartSeconds);
  if (Number.isFinite(startedAt) && startedAt > 0) {
    // Provider timestamps are in whole seconds; accept a call in the run's first second.
    return startedAt * 1000 < Math.floor(state.run.startedAt / 1000) * 1000 ? 'old' : 'current';
  }
  return state.calls.some(call => call.id === id && call.runId === state.run!.id) ? 'current' : 'unknown';
}
/** Platform-filled turn time and elapsed seconds identify a conversation across demo resets. */
export function observedCallStart(observedAt: unknown, elapsedSeconds: unknown, now = Date.now()): number|undefined {
  if (typeof observedAt !== 'string' || observedAt.length > 100 || !observedAt.includes('T') || typeof elapsedSeconds !== 'number') return undefined;
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || elapsedSeconds > 86400 || Math.abs(now-observed) > 30*60*1000) return undefined;
  return Math.floor((observed-elapsedSeconds*1000)/1000);
}
export function parseTranscript(value: unknown): Call['transcript'] {
  if (!Array.isArray(value)) return [];
  let remaining = 100_000;
  return value.slice(0,200).flatMap(turn => {
    if (!turn || typeof turn !== 'object') return [];
    const candidate = turn as Record<string,unknown>;
    if (typeof candidate.role !== 'string' || !candidate.role.trim() || typeof candidate.message !== 'string' || remaining <= 0) return [];
    const role = candidate.role.slice(0,30);
    let message = candidate.message.slice(0,5000);
    let cost = JSON.stringify({role,message}).length + 1;
    if (cost > remaining) {
      let low = 0; let high = message.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (JSON.stringify({role,message:message.slice(0,middle)}).length + 1 <= remaining) low = middle;
        else high = middle - 1;
      }
      message = message.slice(0,low);
      cost = JSON.stringify({role,message}).length + 1;
      if (cost > remaining) return [];
    }
    remaining -= cost;
    return [{role,message}];
  });
}
