import type { DemoState } from '../../shared/contracts';

export type JobTimer = { jobId: string; runId: string; kind: 'release'|'lease'; expectedAt: number };

/** Also upgrades legacy future-pending jobs, without changing their chosen delay. */
export function desiredJobTimers(state: DemoState, now: number): JobTimer[] {
  if (state.run?.status !== 'running') return [];
  const timers: JobTimer[] = [];
  for (const job of state.jobs) {
    if (job.runId !== state.run.id) continue;
    if (job.status === 'pending' && job.dueAt > now) job.status = 'scheduled';
    if (job.status === 'scheduled') timers.push({jobId:job.id,runId:job.runId,kind:'release',expectedAt:job.dueAt});
    else if (job.status === 'claimed') timers.push({jobId:job.id,runId:job.runId,kind:'lease',expectedAt:job.leaseUntil});
  }
  return timers;
}

/** Called only by the database scheduler adapter, never through worker dispatch. */
export function releaseJobTimer(state: DemoState, timer: JobTimer, now: number): boolean {
  if (state.run?.status !== 'running' || state.run.id !== timer.runId || !Number.isFinite(timer.expectedAt) || now < timer.expectedAt) return false;
  const job = state.jobs.find(job=>job.id===timer.jobId && job.runId===timer.runId);
  if (!job) return false;
  if (timer.kind === 'release') {
    if (job.status !== 'scheduled' || job.dueAt !== timer.expectedAt) return false;
  } else if (timer.kind === 'lease') {
    if (job.status !== 'claimed' || job.leaseUntil !== timer.expectedAt) return false;
  } else return false;
  job.status = 'pending';
  job.leaseUntil = 0;
  // An accepted receipt survives a worker crash; its replay must not resubmit.
  return true;
}

export function sameJobTimer(left: JobTimer, right: JobTimer): boolean {
  return left.jobId===right.jobId && left.runId===right.runId && left.kind===right.kind && left.expectedAt===right.expectedAt;
}
