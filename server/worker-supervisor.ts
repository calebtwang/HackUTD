type Process = {
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number|null, signal: NodeJS.Signals|null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
};
export type WorkerExit = { runId: string; agentId: string; code: number|null; signal: NodeJS.Signals|null; spawnError: boolean; attempt: number; delayMs: number|null };
type Options = {
  spawn(agentId: string, runId: string): Process;
  isRunActive(runId: string): boolean;
  onExit(event: WorkerExit): void;
  delaysMs?: readonly number[];
  schedule?: (callback: () => void, delayMs: number) => () => void;
};
type Slot = { agentId: string; runId: string; retries: number; child?: Process; cancel?: () => void };

/** Five retries per worker/run, with a fresh identity check before every launch. */
export function createWorkerSupervisor(options: Options) {
  const slots = new Map<string, Slot>();
  const delays = options.delaysMs ?? [1000, 5000, 15000, 30000, 60000];
  const schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); });
  const current = (slot: Slot) => slots.get(slot.agentId) === slot && options.isRunActive(slot.runId);

  function failed(slot: Slot, code: number|null, signal: NodeJS.Signals|null, spawnError = false) {
    if (!current(slot)) return;
    const delayMs = delays[slot.retries] ?? null;
    if (delayMs !== null) {
      slot.retries++;
      slot.cancel = schedule(() => { slot.cancel = undefined; if (current(slot)) launch(slot); }, delayMs);
    }
    options.onExit({ runId: slot.runId, agentId: slot.agentId, code, signal, spawnError, attempt: slot.retries, delayMs });
  }

  function launch(slot: Slot) {
    if (!current(slot)) return;
    let child: Process;
    try { child = options.spawn(slot.agentId, slot.runId); }
    catch { failed(slot, null, null, true); return; }
    slot.child = child;
    let handled = false;
    const finish = (code: number|null, signal: NodeJS.Signals|null, spawnError = false) => {
      if (handled) return;
      handled = true;
      if (slot.child !== child) return;
      slot.child = undefined;
      failed(slot, code, signal, spawnError);
    };
    child.once('error', () => finish(null, null, true));
    child.once('exit', (code, signal) => finish(code, signal));
  }

  function stop() {
    const previous = [...slots.values()];
    // Invalidate callbacks before signaling: intentional exits must not respawn.
    slots.clear();
    for (const slot of previous) {
      slot.cancel?.();
      try { slot.child?.kill('SIGTERM'); } catch { /* An already-exited process needs no signal. */ }
    }
  }

  return {
    start(runId: string, agentIds: string[]) {
      stop();
      for (const agentId of new Set(agentIds)) {
        const slot: Slot = { agentId, runId, retries: 0 };
        slots.set(agentId, slot);
        launch(slot);
      }
    },
    stop,
  };
}
