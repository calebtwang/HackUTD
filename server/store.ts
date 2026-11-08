import { DbConnection, tables } from './module_bindings';
import type { DemoState } from '../shared/contracts';

export type StoreOptions = { host?: string; database?: string; token?: string; onChange?: (state: DemoState) => void };
export type DemoStore = {
  snapshot(): DemoState;
  collectorNumbers(): { phone: string }[];
  dispatch(action: string, payload: unknown): Promise<void>;
  subscribe(listener: (state: DemoState) => void): () => void;
  close(): void;
  readonly identity: string;
  readonly token: string;
  readonly connected: boolean;
};

/** Resolves only after the initial subscription snapshot has been applied. */
export async function connectStore(options: StoreOptions = {}): Promise<DemoStore> {
  const host = options.host ?? process.env.SPACETIMEDB_HOST ?? 'http://127.0.0.1:3000';
  const database = options.database ?? process.env.SPACETIMEDB_DATABASE ?? 'honeyline-demo';
  let identity = '';
  let token = options.token ?? '';
  let closed = false;
  let scheduled = false;
  const listeners = new Set<(state: DemoState) => void>();
  if (options.onChange) listeners.add(options.onChange);
  let connection: DbConnection;
  const parse = <T>(table: { iter(): Iterable<{ data: string }> }): T[] => Array.from(table.iter(), x => JSON.parse(x.data) as T);
  const snapshot = (): DemoState => ({
    run: parse<NonNullable<DemoState['run']>>(connection.db.backendDemoRun)[0] ?? null,
    agents: parse<DemoState['agents'][number]>(connection.db.backendAgent).sort((a, b) => ['scout', 'finch'].indexOf(a.id) - ['scout', 'finch'].indexOf(b.id)),
    sites: parse(connection.db.backendSite), jobs: parse(connection.db.backendJob), submissions: parse(connection.db.backendSubmission),
    events: parse<DemoState['events'][number]>(connection.db.backendDemoEvent).sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)),
    calls: parse(connection.db.backendCall),
  });
  const notify = () => {
    if (closed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!closed) { const state = snapshot(); for (const listener of listeners) listener(state); }
    });
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { connection?.disconnect(); reject(new Error(`SpacetimeDB did not connect at ${host}/${database} within 15 seconds`)); }, 15_000);
    let builder = DbConnection.builder().withUri(host).withDatabaseName(database)
      .withConfirmedReads(true).withAutomaticReconnect()
      .onConnect((conn, id, savedToken) => {
        identity = id.toHexString(); token = savedToken;
        for (const table of [conn.db.backendAgent, conn.db.backendDemoRun, conn.db.backendSite, conn.db.backendJob, conn.db.backendSubmission, conn.db.backendDemoEvent, conn.db.backendCall, conn.db.collectorNumbers]) {
          table.onInsert(notify); table.onUpdate(notify); table.onDelete(notify);
        }
        conn.subscriptionBuilder().onApplied(() => { clearTimeout(timer); notify(); resolve(); })
          .onError(ctx => { clearTimeout(timer); reject(ctx.event ?? new Error('SpacetimeDB subscription failed')); })
          .subscribe([tables.backendAgent, tables.backendDemoRun, tables.backendSite, tables.backendJob, tables.backendSubmission, tables.backendDemoEvent, tables.backendCall, tables.collectorNumbers]);
      })
      .onAutomaticReconnect((_conn, id, savedToken) => { identity = id.toHexString(); token = savedToken; notify(); })
      .onDisconnect(() => notify())
      .onConnectError((_ctx, error) => { clearTimeout(timer); reject(error); });
    if (token) builder = builder.withToken(token);
    connection = builder.build();
  });
  return {
    snapshot,
    collectorNumbers: () => Array.from(connection.db.collectorNumbers.iter(), row => ({phone: row.phone})),
    async dispatch(action, payload) {
      if (closed) throw new Error('Store has been closed');
      await connection.reducers.dispatch({ action, payload: JSON.stringify(payload) });
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { closed = true; listeners.clear(); connection.disconnect(); },
    get identity() { return identity; },
    get token() { return token; },
    get connected() { return !closed && connection.isActive; },
  };
}
