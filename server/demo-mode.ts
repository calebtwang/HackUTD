import type { DemoState } from '../shared/contracts';

/** Recover the run's recorded mode after restarting the local adapter. */
export function demoMode(state: DemoState, fallback: 'live'|'rehearsal'): 'live'|'rehearsal' {
  if (!state.run) return fallback;
  const start = state.events.find(event => event.runId === state.run!.id && event.kind === 'system' &&
    (event.message.startsWith('Live demo started') || event.message.startsWith('Rehearsal started.')));
  if (start) return start.message.startsWith('Live demo started') ? 'live' : 'rehearsal';
  const discovered = state.sites.find(site => site.runId === state.run!.id);
  if (discovered) return discovered.analysisMode === 'model' ? 'live' : 'rehearsal';
  // New runs use the requested mode until their start event arrives.
  return fallback;
}
