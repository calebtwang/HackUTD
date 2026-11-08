import { schema, table, t, type ReducerCtx, type ViewCtx } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import type { DemoState } from '../../shared/contracts';
import { backendReaderAllowed, collectorPhoneRows, transition, type PrivateState } from './logic';
import { desiredJobTimers, releaseJobTimer as applyJobTimer, sameJobTimer, type JobTimer } from './scheduling';

const row = () => ({ id: t.string().primaryKey(), data: t.string() });
// Existing row shapes and canonical table names are preserved during migration.
const demoRunTable = table({}, row());
const agentTable = table({}, row());
const siteTable = table({}, { ...row(), runId: t.string().index('btree') });
const jobTable = table({}, { ...row(), runId: t.string().index('btree'), agentId: t.string().index('btree'), dueAt: t.f64() });
const submissionTable = table({}, { ...row(), runId: t.string().index('btree') });
const demoEventTable = table({}, { ...row(), runId: t.string().index('btree') });
const callTable = table({}, { ...row(), runId: t.string().index('btree') });
const jobSchedule = table({}, {
  scheduledId:t.u64().primaryKey().autoInc(),scheduledAt:t.scheduleAt(),jobId:t.string().unique(),
  runId:t.string(),kind:t.string(),expectedAt:t.f64(),
});
const spacetimedb = schema({
  config: table({}, row()),
  demoRun:demoRunTable,agent:agentTable,site:siteTable,job:jobTable,submission:submissionTable,demoEvent:demoEventTable,call:callTable,
  activeRun:table({}, {id:t.string().primaryKey(),runId:t.string()}),
  jobSchedule,
});
export default spacetimedb;
type ModuleContext = ReducerCtx<typeof spacetimedb.schemaType>;
type BackendViewContext = ViewCtx<typeof spacetimedb.schemaType>;

export const init = spacetimedb.init(ctx => {
  // init's authenticated sender is the publisher/owner, never the first visitor.
  ctx.db.config.insert({ id: 'auth', data: JSON.stringify({ admin: ctx.sender.toHexString(), workerSecret: '', workers: {} } satisfies PrivateState) });
});

function readRows<T>(table: { iter(): Iterable<{ data: string }> }): T[] {
  return Array.from(table.iter(), row => JSON.parse(row.data) as T);
}
function syncRows(table: any, values: any[], metadata: string[] = []) {
  const keep = new Set(values.map(v => v.id));
  for (const row of table.iter()) if (!keep.has(row.id)) table.id.delete(row.id);
  for (const value of values) {
    const existing = table.id.find(value.id);
    const data = JSON.stringify(value);
    if (existing?.data === data) continue;
    const next: Record<string, unknown> = { id: value.id, data };
    for (const key of metadata) next[key] = value[key];
    if (existing) table.id.update(next); else table.insert(next);
  }
}

function readState(ctx:ModuleContext): DemoState {
  return {
    run: readRows<NonNullable<DemoState['run']>>(ctx.db.demoRun)[0] ?? null,
    agents: readRows(ctx.db.agent), sites: readRows(ctx.db.site), jobs: readRows(ctx.db.job),
    submissions: readRows(ctx.db.submission), events: readRows(ctx.db.demoEvent), calls: readRows(ctx.db.call),
  };
}

function syncSchedules(ctx:ModuleContext,state:DemoState,now:number) {
  const wanted=new Map(desiredJobTimers(state,now).map(timer=>[timer.jobId,timer]));
  for(const scheduled of ctx.db.jobSchedule.iter()) {
    const timer=wanted.get(scheduled.jobId);
    if(timer && sameJobTimer(scheduled as JobTimer,timer)) wanted.delete(scheduled.jobId);
    else ctx.db.jobSchedule.scheduledId.delete(scheduled.scheduledId);
  }
  for(const timer of wanted.values()) ctx.db.jobSchedule.insert({
    scheduledId:0n,scheduledAt:ScheduleAt.time(BigInt(Math.trunc(timer.expectedAt))*1000n),...timer,
  });
}

function persistState(ctx:ModuleContext,state:DemoState) {
  // Reconciliation is idempotent and also backfills timers on ordinary configure
  // after an upgrade. init is deliberately not required to rerun.
  syncSchedules(ctx,state,Number(ctx.timestamp.microsSinceUnixEpoch/1000n));
  syncRows(ctx.db.demoRun, state.run ? [state.run] : []);
  syncRows(ctx.db.agent, state.agents);
  syncRows(ctx.db.site, state.sites, ['runId']);
  syncRows(ctx.db.job, state.jobs, ['runId', 'agentId', 'dueAt']);
  syncRows(ctx.db.submission, state.submissions, ['runId']);
  syncRows(ctx.db.demoEvent, state.events, ['runId']);
  syncRows(ctx.db.call, state.calls, ['runId']);
  const current=ctx.db.activeRun.id.find('current');
  if(!state.run) {if(current) ctx.db.activeRun.id.delete('current');}
  else if(current?.runId!==state.run.id) {
    const pointer={id:'current',runId:state.run.id};
    if(current) ctx.db.activeRun.id.update(pointer);else ctx.db.activeRun.insert(pointer);
  }
}

export const dispatch = spacetimedb.reducer({ action: t.string(), payload: t.string() }, (ctx, { action, payload }) => {
  if (payload.length > 150_000) throw new Error('Payload exceeds the demo limit');
  const config = ctx.db.config.id.find('auth');
  if (!config) throw new Error('Database has not initialized');
  const auth = JSON.parse(config.data) as PrivateState;
  const state=readState(ctx);
  transition(state, auth, {
    sender: ctx.sender.toHexString(), now: Number(ctx.timestamp.microsSinceUnixEpoch / 1000n),
    random: () => ctx.random(), uuid: () => ctx.newUuidV4().toString(),
  }, action, JSON.parse(payload));
  persistState(ctx,state);
  const data = JSON.stringify(auth);
  if (data !== config.data) ctx.db.config.id.update({ id: 'auth', data });
});

export const releaseJobTimer = spacetimedb.reducer(
  {name:'release_job_timer',onSchedule:jobSchedule},{timer:jobSchedule.rowType},(ctx,{timer})=>{
    if(!ctx.sender.isEqual(ctx.databaseIdentity)) throw new Error('Only the database scheduler can release a job');
    const state=readState(ctx);
    applyJobTimer(state,timer as JobTimer,Number(ctx.timestamp.microsSinceUnixEpoch/1000n));
    persistState(ctx,state);
  },
);

function backendAllowed(ctx:BackendViewContext): boolean {
  const auth=ctx.db.config.id.find('auth');
  return Boolean(auth && backendReaderAllowed(JSON.parse(auth.data) as PrivateState,ctx.sender.toHexString()));
}

// Return query plans, not full-table iteration. An unauthorized query has a
// contradictory indexed predicate so it cannot expose even a malformed ID.
export const backend_demo_run=spacetimedb.view({name:'backend_demo_run',public:true},t.array(demoRunTable.rowType),ctx=>
  backendAllowed(ctx)?ctx.from.demoRun.build():ctx.from.demoRun.where(row=>row.id.eq('').and(row.id.eq('!'))).build());
export const backend_agent=spacetimedb.view({name:'backend_agent',public:true},t.array(agentTable.rowType),ctx=>
  backendAllowed(ctx)?ctx.from.agent.build():ctx.from.agent.where(row=>row.id.eq('').and(row.id.eq('!'))).build());
export const backend_site=spacetimedb.view({name:'backend_site',public:true},t.array(siteTable.rowType),ctx=>
  backendAllowed(ctx)?ctx.from.site.build():ctx.from.site.where(row=>row.id.eq('').and(row.id.eq('!'))).build());
export const backend_job=spacetimedb.view({name:'backend_job',public:true},t.array(jobTable.rowType),ctx=>
  backendAllowed(ctx)?ctx.from.job.build():ctx.from.job.where(row=>row.id.eq('').and(row.id.eq('!'))).build());
export const backend_submission=spacetimedb.view({name:'backend_submission',public:true},t.array(submissionTable.rowType),ctx=>
  backendAllowed(ctx)?ctx.from.submission.build():ctx.from.submission.where(row=>row.id.eq('').and(row.id.eq('!'))).build());
export const backend_demo_event=spacetimedb.view({name:'backend_demo_event',public:true},t.array(demoEventTable.rowType),ctx=>
  backendAllowed(ctx)?ctx.from.demoEvent.build():ctx.from.demoEvent.where(row=>row.id.eq('').and(row.id.eq('!'))).build());
export const backend_call=spacetimedb.view({name:'backend_call',public:true},t.array(callTable.rowType),ctx=>
  backendAllowed(ctx)?ctx.from.call.build():ctx.from.call.where(row=>row.id.eq('').and(row.id.eq('!'))).build());

export const collector_numbers=spacetimedb.anonymousView(
  {name:'collector_numbers',public:true},t.array(t.row('CollectorNumber',{phone:t.string().primaryKey()})),ctx=>{
    const current=ctx.db.activeRun.id.find('current');
    return current?collectorPhoneRows(ctx.db.submission.runId.filter(current.runId)):[];
  },
);
