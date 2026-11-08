import type { Agent, Call, DemoState, Submission } from '../shared/contracts.js';

export function normalizeMarker(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').trim();
}
const spokenDemoMarkers: Readonly<Record<string,string>> = {
  'cedar finch 47': 'cedar finch forty seven',
  'copper meadow 62': 'copper meadow sixty two',
  'velvet acorn 83': 'velvet acorn eighty three',
};
const numberWord = /^(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|point)$/;
function containsMarker(text: string, marker: string): boolean {
  const normalized = normalizeMarker(marker);
  if (normalized.length < 8) return false;
  const haystack = ` ${normalizeMarker(text)} `;
  const spoken = spokenDemoMarkers[normalized];
  // Only these three complete synthetic IDs get spoken-number equivalents.
  // Do not normalize arbitrary numbers or accept names without the full marker.
  for (const variant of spoken ? [normalized,spoken] : [normalized]) {
    const phrase = ` ${variant} `;
    for (let index=haystack.indexOf(phrase); index>=0; index=haystack.indexOf(phrase,index+1)) {
      if (spoken) {
        const following = haystack.slice(index+phrase.length).trim().split(' ');
        // "forty seven hundred" and "47.5" are different numbers, not marker 47.
        if (numberWord.test(following[0] ?? '') || (following[0]==='and' && numberWord.test(following[1] ?? ''))) continue;
      }
      return true;
    }
  }
  return false;
}
export function possibleMatch(text: string, rows: Submission[]): Submission|undefined {
  return rows.find(row => containsMarker(text, row.marker));
}
export function verifiedMatch(transcript: Call['transcript'], rows: Submission[]): { submission: Submission; evidence: string }|undefined {
  const disclosed = new Set<string>();
  for (const turn of transcript) {
    if (turn.role === 'agent' || turn.role === 'assistant') {
      for (const row of rows) if (containsMarker(turn.message, row.marker)) disclosed.add(row.id);
    } else if (turn.role === 'user' || turn.role === 'caller') {
      const match = rows.find(row => !disclosed.has(row.id) && containsMarker(turn.message, row.marker));
      if (match) return { submission: match, evidence: turn.message.slice(0, 1000) };
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
