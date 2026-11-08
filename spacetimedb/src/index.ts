import { schema, table, t, ScheduleAt, SenderError } from 'spacetimedb/server';
import type { DemoState } from '../../shared/contracts';
import { transition, type PrivateState } from './logic';
import { makeRng, seed32, seedWorld, tick, type SimWorld, type SimStats, type Source } from './sim';

const row = () => ({ id: t.string().primaryKey(), data: t.string() });

// Private schedule table that drives the in-database simulation.
const simTickSchedule = table({}, { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() });

const spacetimedb = schema({
  config: table({}, row()),
  demoRun: table({ public: true }, row()),
  agent: table({ public: true }, row()),
  site: table({ public: true }, { ...row(), runId: t.string().index('btree') }),
  job: table({ public: true }, { ...row(), runId: t.string().index('btree'), agentId: t.string().index('btree'), dueAt: t.f64() }),
  submission: table({ public: true }, { ...row(), runId: t.string().index('btree') }),
  demoEvent: table({ public: true }, { ...row(), runId: t.string().index('btree') }),
  call: table({ public: true }, { ...row(), runId: t.string().index('btree') }),

  // Labeled simulation tables. The `source` column marks every row 'simulated'
  // or 'live'; real and simulated rows share these tables.
  simSite: table({ public: true }, {
    id: t.u64().primaryKey().autoInc(), key: t.string().unique(), label: t.string(),
    leakiness: t.f64(), leaks: t.u32(), tracedCalls: t.u32(), source: t.string(),
  }),
  simPersona: table({ public: true }, {
    id: t.u64().primaryKey().autoInc(), key: t.string().unique(), name: t.string(),
    marker: t.string().index('btree'), phoneMasked: t.string(), plants: t.u32(), callsReceived: t.u32(), source: t.string(),
  }),
  simPlant: table({ public: true }, {
    id: t.u64().primaryKey().autoInc(), personaId: t.string().index('btree'), siteId: t.string().index('btree'),
    plantedAt: t.timestamp(), source: t.string(),
  }),
  simRing: table({ public: true }, {
    id: t.u64().primaryKey().autoInc(), key: t.string().unique(), label: t.string(),
    pretext: t.string(), calls: t.u32(), lastSeenAt: t.timestamp(),
  }),
  simRingPurchase: table({ public: true }, {
    id: t.u64().primaryKey().autoInc(), ringId: t.string().index('btree'), siteId: t.string().index('btree'), leaked: t.bool(),
  }),
  leakCall: table({ public: true }, {
    id: t.u64().primaryKey().autoInc(), personaId: t.string().index('btree'), ringId: t.string().index('btree'),
    siteId: t.string().index('btree'), spokenMarker: t.string().index('btree'), outcome: t.string(),
    durationSeconds: t.u32(), source: t.string(), externalId: t.string(), at: t.timestamp(),
  }),
  simStats: table({ public: true }, {
    id: t.u64().primaryKey(), running: t.bool(), seed: t.u64(), tick: t.u64(), calls: t.u64(),
    simulatedCalls: t.u64(), liveCalls: t.u64(), secondsBurned: t.u64(),
    personas: t.u32(), sites: t.u32(), rings: t.u32(),
  }),
  simTickSchedule,
});
export default spacetimedb;

const STATS_ID = 0n;
const LEAK_CALL_CAP = 600;
const TICK_INTERVAL_MICROS = 2_000_000n;

function emptyStats(): SimStats {
  return { running: false, seed: 0n, tick: 0n, calls: 0n, simulatedCalls: 0n, liveCalls: 0n, secondsBurned: 0n, personas: 0, sites: 0, rings: 0 };
}

export const init = spacetimedb.init(ctx => {
  // init's authenticated sender is the publisher/owner, never the first visitor.
  ctx.db.config.insert({ id: 'auth', data: JSON.stringify({ admin: ctx.sender.toHexString(), workerSecret: '', workers: {} } satisfies PrivateState) });
  if (!ctx.db.simStats.id.find(STATS_ID)) ctx.db.simStats.insert({ id: STATS_ID, ...statsToRow(emptyStats()) });
});

function statsToRow(s: SimStats) {
  return { running: s.running, seed: s.seed, tick: s.tick, calls: s.calls, simulatedCalls: s.simulatedCalls,
    liveCalls: s.liveCalls, secondsBurned: s.secondsBurned, personas: s.personas, sites: s.sites, rings: s.rings };
}

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

function requireAdmin(ctx: any) {
  const config = ctx.db.config.id.find('auth');
  if (!config) throw new Error('Database has not initialized');
  const auth = JSON.parse(config.data) as PrivateState;
  if (ctx.sender.toHexString() !== auth.admin) throw new Error('Admin identity required');
}

function readStats(ctx: any): SimStats {
  const r = ctx.db.simStats.id.find(STATS_ID);
  if (!r) return emptyStats();
  return { running: r.running, seed: r.seed, tick: r.tick, calls: r.calls, simulatedCalls: r.simulatedCalls,
    liveCalls: r.liveCalls, secondsBurned: r.secondsBurned, personas: r.personas, sites: r.sites, rings: r.rings };
}
function writeStats(ctx: any, s: SimStats) {
  if (ctx.db.simStats.id.find(STATS_ID)) ctx.db.simStats.id.update({ id: STATS_ID, ...statsToRow(s) });
  else ctx.db.simStats.insert({ id: STATS_ID, ...statsToRow(s) });
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

  // Additive: mirror verified live activity into the shared simulation tables.
  if (action === 'discover_site' || action === 'accept_submission' || action === 'call_event') {
    recordLive(ctx, action, state);
  }
});

function maskPhone(phone: string): string {
  const digits = (phone || '').replace(/\D/g, '');
  const last = digits.slice(-4).padStart(4, '0');
  return `***-***-${last}`;
}

// Mirrors confirmed live demo activity into sim_site / sim_persona / sim_plant /
// leak_call with source 'live'. Every write is existence-checked so it stays
// idempotent and never throws (a throw would roll back the whole reducer).
function recordLive(ctx: any, action: string, state: DemoState) {
  const liveSiteKey = (siteId: string) => `live:${siteId}`;
  const livePersonaKey = (agentId: string) => `live:${agentId}`;

  if (action === 'discover_site') {
    for (const site of state.sites) {
      const key = liveSiteKey(site.id);
      if (!ctx.db.simSite.key.find(key)) {
        ctx.db.simSite.insert({ id: 0n, key, label: site.title || site.id, leakiness: 0, leaks: 0, tracedCalls: 0, source: 'live' });
      }
    }
    return;
  }

  if (action === 'accept_submission') {
    for (const sub of state.submissions) {
      const agent = state.agents.find(a => a.id === sub.agentId);
      if (!agent) continue;
      const pKey = livePersonaKey(sub.agentId);
      if (!ctx.db.simPersona.key.find(pKey)) {
        ctx.db.simPersona.insert({ id: 0n, key: pKey, name: agent.name, marker: agent.marker,
          phoneMasked: maskPhone(agent.phone), plants: 1, callsReceived: 0, source: 'live' });
      }
      const sKey = liveSiteKey(sub.siteId);
      const already = Array.from(ctx.db.simPlant.personaId.filter(pKey) as Iterable<any>).some(pl => pl.siteId === sKey && pl.source === 'live');
      if (!already) {
        ctx.db.simPlant.insert({ id: 0n, personaId: pKey, siteId: sKey, plantedAt: ctx.timestamp, source: 'live' });
      }
    }
    return;
  }

  if (action === 'call_event') {
    const stats = readStats(ctx);
    let changed = false;
    for (const call of state.calls) {
      if (call.matchStatus !== 'verified') continue;
      const agent = state.agents.find(a => a.id === call.agentId);
      if (!agent) continue;
      const exists = Array.from(ctx.db.leakCall.spokenMarker.filter(agent.marker) as Iterable<any>)
        .some(lc => lc.source === 'live' && lc.externalId === call.id);
      if (exists) continue;
      // Attribute to the live site mirroring the discovered form.
      const siteId = call.matchedSiteId || (state.sites[0]?.id ?? '');
      const sKey = liveSiteKey(siteId);
      let siteRow = ctx.db.simSite.key.find(sKey);
      if (!siteRow) {
        const title = state.sites.find(s => s.id === siteId)?.title || siteId;
        siteRow = ctx.db.simSite.insert({ id: 0n, key: sKey, label: title || siteId, leakiness: 0, leaks: 0, tracedCalls: 0, source: 'live' });
      }
      ctx.db.leakCall.insert({ id: 0n, personaId: livePersonaKey(call.agentId), ringId: '', siteId: sKey,
        spokenMarker: agent.marker, outcome: call.durationSeconds > 0 ? 'answered' : 'hung_up',
        durationSeconds: Math.max(0, Math.round(call.durationSeconds)), source: 'live', externalId: call.id, at: ctx.timestamp });
      ctx.db.simSite.id.update({ ...siteRow, tracedCalls: siteRow.tracedCalls + 1 });
      const pRow = ctx.db.simPersona.key.find(livePersonaKey(call.agentId));
      if (pRow) ctx.db.simPersona.id.update({ ...pRow, callsReceived: pRow.callsReceived + 1 });
      stats.calls += 1n; stats.liveCalls += 1n;
      stats.secondsBurned += BigInt(Math.max(0, Math.round(call.durationSeconds)));
      changed = true;
    }
    if (changed) writeStats(ctx, stats);
    return;
  }
}

// ---- Simulation control reducers ----------------------------------------

export const startSimulation = spacetimedb.reducer(
  { seed: t.u64(), personaCount: t.u32(), siteCount: t.u32(), ringCount: t.u32() },
  (ctx, { seed, personaCount, siteCount, ringCount }) => {
    requireAdmin(ctx);
    if (readStats(ctx).running) throw new Error('Simulation already running');
    const personas = Math.min(400, Math.max(1, personaCount));
    const sites = Math.min(60, Math.max(1, siteCount));
    const rings = Math.min(12, Math.max(1, ringCount));

    // Clear all simulation rows (simulated and live) for a clean seed.
    ctx.db.simSite.clear();
    ctx.db.simPersona.clear();
    ctx.db.simPlant.clear();
    ctx.db.simRing.clear();
    ctx.db.simRingPurchase.clear();
    ctx.db.leakCall.clear();

    const world = seedWorld(makeRng(seed32(seed)), { personaCount: personas, siteCount: sites, ringCount: rings });
    world.stats.seed = seed;
    world.stats.running = true;
    world.stats.tick = 0n;

    for (const s of world.sites) ctx.db.simSite.insert({ id: 0n, key: s.id, label: s.label, leakiness: s.leakiness, leaks: s.leaks, tracedCalls: s.tracedCalls, source: s.source });
    for (const p of world.personas) ctx.db.simPersona.insert({ id: 0n, key: p.id, name: p.name, marker: p.marker, phoneMasked: p.phoneMasked, plants: p.plants, callsReceived: p.callsReceived, source: p.source });
    for (const r of world.rings) ctx.db.simRing.insert({ id: 0n, key: r.id, label: r.label, pretext: r.pretext, calls: r.calls, lastSeenAt: ctx.timestamp });
    for (const pch of world.purchases) ctx.db.simRingPurchase.insert({ id: 0n, ringId: pch.ringId, siteId: pch.siteId, leaked: pch.leaked });
    writeStats(ctx, world.stats);

    for (const sched of ctx.db.simTickSchedule.iter()) ctx.db.simTickSchedule.scheduledId.delete(sched.scheduledId);
    ctx.db.simTickSchedule.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(TICK_INTERVAL_MICROS) });
  },
);

export const stopSimulation = spacetimedb.reducer({}, (ctx) => {
  requireAdmin(ctx);
  for (const sched of ctx.db.simTickSchedule.iter()) ctx.db.simTickSchedule.scheduledId.delete(sched.scheduledId);
  const stats = readStats(ctx);
  stats.running = false;
  writeStats(ctx, stats);
});

export const simTick = spacetimedb.reducer({ onSchedule: simTickSchedule }, { job: simTickSchedule.rowType }, (ctx, _job) => {
  if (!ctx.sender.isEqual(ctx.databaseIdentity)) throw new SenderError('simTick is a scheduled reducer');
  const stats = readStats(ctx);
  if (!stats.running) {
    for (const sched of ctx.db.simTickSchedule.iter()) ctx.db.simTickSchedule.scheduledId.delete(sched.scheduledId);
    return;
  }

  // Load the world from typed tables.
  const siteDbId = new Map<string, bigint>();
  const personaDbId = new Map<string, bigint>();
  const ringDbId = new Map<string, bigint>();
  const purchaseDbId = new Map<string, bigint>();

  const world: SimWorld = { sites: [], personas: [], rings: [], plants: [], purchases: [], calls: [], stats };
  for (const r of ctx.db.simSite.iter()) {
    siteDbId.set(r.key, r.id);
    world.sites.push({ id: r.key, label: r.label, leakiness: r.leakiness, leaks: r.leaks, tracedCalls: r.tracedCalls, source: r.source as Source });
  }
  for (const r of ctx.db.simPersona.iter()) {
    personaDbId.set(r.key, r.id);
    world.personas.push({ id: r.key, name: r.name, marker: r.marker, phoneMasked: r.phoneMasked, plants: r.plants, callsReceived: r.callsReceived, source: r.source as Source });
  }
  for (const r of ctx.db.simRing.iter()) {
    ringDbId.set(r.key, r.id);
    world.rings.push({ id: r.key, label: r.label, pretext: r.pretext, calls: r.calls, lastSeenAt: 0 });
  }
  for (const r of ctx.db.simRingPurchase.iter()) {
    purchaseDbId.set(`${r.ringId}|${r.siteId}`, r.id);
    world.purchases.push({ id: `${r.ringId}:${r.siteId}`, ringId: r.ringId, siteId: r.siteId, leaked: r.leaked });
  }
  for (const r of ctx.db.simPlant.iter()) {
    world.plants.push({ id: `${r.personaId}:${r.siteId}`, personaId: r.personaId, siteId: r.siteId, plantedAt: 0, source: r.source as Source });
  }

  // Snapshot counters so only changed rows are written back.
  const siteBefore = new Map(world.sites.map(s => [s.id, `${s.tracedCalls}/${s.leaks}`]));
  const personaBefore = new Map(world.personas.map(p => [p.id, `${p.plants}/${p.callsReceived}`]));
  const ringBefore = new Map(world.rings.map(r => [r.id, r.calls]));
  const purchaseLeakedBefore = new Set(world.purchases.filter(p => p.leaked).map(p => `${p.ringId}|${p.siteId}`));

  const rng = makeRng((seed32(stats.seed) ^ seed32((stats.tick + 1n) * 2654435761n)) >>> 0);
  const delta = tick(world, rng, Number(ctx.timestamp.microsSinceUnixEpoch));
  const newPurchaseKeys = new Set(delta.newPurchases.map(p => `${p.ringId}|${p.siteId}`));

  // Persist changed aggregate rows.
  for (const s of world.sites) {
    if (siteBefore.get(s.id) !== `${s.tracedCalls}/${s.leaks}`) {
      ctx.db.simSite.id.update({ id: siteDbId.get(s.id)!, key: s.id, label: s.label, leakiness: s.leakiness, leaks: s.leaks, tracedCalls: s.tracedCalls, source: s.source });
    }
  }
  for (const p of world.personas) {
    if (personaBefore.get(p.id) !== `${p.plants}/${p.callsReceived}`) {
      ctx.db.simPersona.id.update({ id: personaDbId.get(p.id)!, key: p.id, name: p.name, marker: p.marker, phoneMasked: p.phoneMasked, plants: p.plants, callsReceived: p.callsReceived, source: p.source });
    }
  }
  for (const r of world.rings) {
    if (ringBefore.get(r.id) !== r.calls) {
      ctx.db.simRing.id.update({ id: ringDbId.get(r.id)!, key: r.id, label: r.label, pretext: r.pretext, calls: r.calls, lastSeenAt: ctx.timestamp });
    }
  }
  // New purchases (insert) and existing purchases whose leaked flag flipped (update).
  for (const p of world.purchases) {
    const key = `${p.ringId}|${p.siteId}`;
    if (newPurchaseKeys.has(key)) {
      ctx.db.simRingPurchase.insert({ id: 0n, ringId: p.ringId, siteId: p.siteId, leaked: p.leaked });
    } else if (p.leaked && !purchaseLeakedBefore.has(key)) {
      const dbId = purchaseDbId.get(key);
      if (dbId !== undefined) ctx.db.simRingPurchase.id.update({ id: dbId, ringId: p.ringId, siteId: p.siteId, leaked: true });
    }
  }
  for (const pl of delta.newPlants) ctx.db.simPlant.insert({ id: 0n, personaId: pl.personaId, siteId: pl.siteId, plantedAt: ctx.timestamp, source: pl.source });
  for (const c of delta.newCalls) ctx.db.leakCall.insert({ id: 0n, personaId: c.personaId, ringId: c.ringId, siteId: c.siteId, spokenMarker: c.spokenMarker, outcome: c.outcome, durationSeconds: c.durationSeconds, source: c.source, externalId: '', at: ctx.timestamp });

  writeStats(ctx, world.stats);

  // Prune oldest simulated leak_call rows beyond the cap.
  let total = Number(ctx.db.leakCall.count());
  if (total > LEAK_CALL_CAP) {
    const simulated = Array.from(ctx.db.leakCall.iter()).filter((r: any) => r.source === 'simulated').sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const r of simulated) {
      if (total <= LEAK_CALL_CAP) break;
      ctx.db.leakCall.id.delete(r.id);
      total -= 1;
    }
  }
});

// ---- Public views --------------------------------------------------------

// Submitted, callable-format phone numbers only. No names, no source.
export const collectorNumbers = spacetimedb.view(
  { public: true },
  t.array(t.row('CollectorNumber', { phone: t.string() })),
  (ctx) => {
    const out: { phone: string }[] = [];
    for (const r of ctx.db.submission.iter()) {
      try {
        const phone = (JSON.parse(r.data) as { phone?: string }).phone ?? '';
        if (/^\+[1-9]\d{6,14}$/.test(phone)) out.push({ phone });
      } catch { /* skip malformed rows */ }
    }
    return out;
  },
);

// Operator ledger: identity and source without the phone number.
export const operatorLedger = spacetimedb.view(
  { public: true },
  t.array(t.row('LedgerEntry', { id: t.string(), agentId: t.string(), name: t.string(), marker: t.string(), siteId: t.string(), receivedAt: t.f64() })),
  (ctx) => {
    const out: { id: string; agentId: string; name: string; marker: string; siteId: string; receivedAt: number }[] = [];
    for (const r of ctx.db.submission.iter()) {
      try {
        const s = JSON.parse(r.data) as { id: string; agentId: string; name: string; marker: string; siteId: string; receivedAt: number };
        out.push({ id: s.id, agentId: s.agentId, name: s.name, marker: s.marker, siteId: s.siteId, receivedAt: s.receivedAt });
      } catch { /* skip malformed rows */ }
    }
    return out;
  },
);
