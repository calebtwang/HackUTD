import { schema, table, t } from 'spacetimedb/server';
import type { DemoState } from '../../shared/contracts';
import { transition, type PrivateState } from './logic';

const row = () => ({ id: t.string().primaryKey(), data: t.string() });
const spacetimedb = schema({
  config: table({}, row()),
  demoRun: table({ public: true }, row()),
  agent: table({ public: true }, row()),
  site: table({ public: true }, { ...row(), runId: t.string().index('btree') }),
  job: table({ public: true }, { ...row(), runId: t.string().index('btree'), agentId: t.string().index('btree'), dueAt: t.f64() }),
  submission: table({ public: true }, { ...row(), runId: t.string().index('btree') }),
  demoEvent: table({ public: true }, { ...row(), runId: t.string().index('btree') }),
  call: table({ public: true }, { ...row(), runId: t.string().index('btree') }),
});
export default spacetimedb;

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

export const dispatch = spacetimedb.reducer({ action: t.string(), payload: t.string() }, (ctx, { action, payload }) => {
  if (payload.length > 150_000) throw new Error('Payload exceeds the demo limit');
  const config = ctx.db.config.id.find('auth');
  if (!config) throw new Error('Database has not initialized');
  const auth = JSON.parse(config.data) as PrivateState;
  const state: DemoState = {
    run: readRows<NonNullable<DemoState['run']>>(ctx.db.demoRun)[0] ?? null,
    agents: readRows(ctx.db.agent), sites: readRows(ctx.db.site), jobs: readRows(ctx.db.job),
    submissions: readRows(ctx.db.submission), events: readRows(ctx.db.demoEvent), calls: readRows(ctx.db.call),
  };
  transition(state, auth, {
    sender: ctx.sender.toHexString(), now: Number(ctx.timestamp.microsSinceUnixEpoch / 1000n),
    random: () => ctx.random(), uuid: () => ctx.newUuidV4().toString(),
  }, action, JSON.parse(payload));
  syncRows(ctx.db.demoRun, state.run ? [state.run] : []);
  syncRows(ctx.db.agent, state.agents);
  syncRows(ctx.db.site, state.sites, ['runId']);
  syncRows(ctx.db.job, state.jobs, ['runId', 'agentId', 'dueAt']);
  syncRows(ctx.db.submission, state.submissions, ['runId']);
  syncRows(ctx.db.demoEvent, state.events, ['runId']);
  syncRows(ctx.db.call, state.calls, ['runId']);
  const data = JSON.stringify(auth);
  if (data !== config.data) ctx.db.config.id.update({ id: 'auth', data });
});
