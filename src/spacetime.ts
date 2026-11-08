import { useEffect, useState } from 'react';
import { DbConnection } from '../server/module_bindings';

// A direct, read-only browser connection to SpacetimeDB. The sim tables and the
// existing public tables are public, so an anonymous identity (no token) is used.

export type SimStats = {
  running: boolean; seed: number; tick: number; calls: number;
  simulatedCalls: number; liveCalls: number; secondsBurned: number;
  personas: number; sites: number; rings: number;
};
export type SimSite = { key: string; label: string; leakiness: number; leaks: number; tracedCalls: number; source: string };
export type SimPersona = { key: string; name: string; marker: string; phoneMasked: string; plants: number; callsReceived: number; source: string };
export type SimRing = { key: string; label: string; pretext: string; calls: number; lastSeenAt: number };
export type SimRingPurchase = { ringId: string; siteId: string; leaked: boolean };
export type SimPlant = { siteId: string; personaId: string };
export type LeakCall = {
  id: number; personaId: string; ringId: string; siteId: string;
  spokenMarker: string; outcome: string; durationSeconds: number; source: string; at: number;
};
export type LedgerRow = { id: string; agentId: string; name: string; marker: string; siteId: string; receivedAt: number };

export type SimSnapshot = {
  connected: boolean;
  identityShort: string;
  stats: SimStats | null;
  sites: SimSite[];
  personas: SimPersona[];
  rings: SimRing[];
  ringPurchases: SimRingPurchase[];
  plants: SimPlant[];
  leakCalls: LeakCall[];
  collectorNumbers: string[];
  ledger: LedgerRow[];
};

const EMPTY: SimSnapshot = {
  connected: false, identityShort: '', stats: null, sites: [], personas: [], rings: [],
  ringPurchases: [], plants: [], leakCalls: [], collectorNumbers: [], ledger: [],
};

const millis = (value: { toMillis(): bigint }): number => Number(value.toMillis());

/**
 * Connects the browser directly to SpacetimeDB and returns reactive snapshots of
 * the simulation tables, the collector_numbers view and the operator_ledger view.
 * Views are subscribed separately so a missing view cannot break the table group.
 */
export function useSpacetime(host: string, name: string): SimSnapshot {
  const [snap, setSnap] = useState<SimSnapshot>(EMPTY);
  useEffect(() => {
    if (!host || !name) return;
    let closed = false;
    let scheduled = false;
    let identityShort = '';
    let conn: DbConnection | undefined;

    const read = (): Omit<SimSnapshot, 'connected' | 'identityShort'> => {
      const c = conn!;
      const leakCalls = Array.from(c.db.leakCall.iter(), r => ({
        id: Number(r.id), personaId: r.personaId, ringId: r.ringId, siteId: r.siteId,
        spokenMarker: r.spokenMarker, outcome: r.outcome, durationSeconds: r.durationSeconds,
        source: r.source, at: millis(r.at),
      })).sort((a, b) => b.at - a.at || b.id - a.id).slice(0, 30);
      const statsRow = Array.from(c.db.simStats.iter())[0];
      return {
        stats: statsRow ? {
          running: statsRow.running, seed: Number(statsRow.seed), tick: Number(statsRow.tick),
          calls: Number(statsRow.calls), simulatedCalls: Number(statsRow.simulatedCalls),
          liveCalls: Number(statsRow.liveCalls), secondsBurned: Number(statsRow.secondsBurned),
          personas: statsRow.personas, sites: statsRow.sites, rings: statsRow.rings,
        } : null,
        sites: Array.from(c.db.simSite.iter(), r => ({
          key: r.key, label: r.label, leakiness: r.leakiness, leaks: r.leaks, tracedCalls: r.tracedCalls, source: r.source,
        })),
        personas: Array.from(c.db.simPersona.iter(), r => ({
          key: r.key, name: r.name, marker: r.marker, phoneMasked: r.phoneMasked,
          plants: r.plants, callsReceived: r.callsReceived, source: r.source,
        })),
        rings: Array.from(c.db.simRing.iter(), r => ({
          key: r.key, label: r.label, pretext: r.pretext, calls: r.calls, lastSeenAt: millis(r.lastSeenAt),
        })),
        ringPurchases: Array.from(c.db.simRingPurchase.iter(), r => ({ ringId: r.ringId, siteId: r.siteId, leaked: r.leaked })),
        plants: Array.from(c.db.simPlant.iter(), r => ({ siteId: r.siteId, personaId: r.personaId })),
        leakCalls,
        collectorNumbers: Array.from(c.db.collectorNumbers.iter(), r => r.phone),
        ledger: Array.from(c.db.operatorLedger.iter(), r => ({
          id: r.id, agentId: r.agentId, name: r.name, marker: r.marker, siteId: r.siteId, receivedAt: r.receivedAt,
        })),
      };
    };

    const notify = () => {
      if (closed || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (closed || !conn) return;
        setSnap({ ...read(), connected: conn.isActive, identityShort });
      });
    };

    conn = DbConnection.builder().withUri(host).withDatabaseName(name)
      .withConfirmedReads(true).withAutomaticReconnect()
      .onConnect((c, id) => {
        identityShort = id.toHexString().slice(0, 8);
        const tracked = [
          c.db.simStats, c.db.simSite, c.db.simPersona, c.db.simPlant,
          c.db.simRing, c.db.simRingPurchase, c.db.leakCall,
          c.db.collectorNumbers, c.db.operatorLedger,
        ];
        for (const table of tracked) { table.onInsert(notify); table.onUpdate(notify); table.onDelete(notify); }
        c.subscriptionBuilder().onApplied(() => notify()).onError(() => { /* table group error: leave snapshot as-is */ })
          .subscribe([
            'SELECT * FROM sim_stats', 'SELECT * FROM sim_site', 'SELECT * FROM sim_persona',
            'SELECT * FROM sim_plant', 'SELECT * FROM sim_ring', 'SELECT * FROM sim_ring_purchase',
            'SELECT * FROM leak_call', 'SELECT * FROM agent', 'SELECT * FROM demo_run',
            'SELECT * FROM site', 'SELECT * FROM job', 'SELECT * FROM submission',
            'SELECT * FROM demo_event', 'SELECT * FROM call',
          ]);
        // Views in a separate subscription so a missing view does not break the tables.
        c.subscriptionBuilder().onApplied(() => notify()).onError(() => { /* view missing: tables still work */ })
          .subscribe(['SELECT * FROM collector_numbers', 'SELECT * FROM operator_ledger']);
        notify();
      })
      .onDisconnect(() => { if (!closed) setSnap(s => ({ ...s, connected: false })); })
      .onConnectError(() => { if (!closed) setSnap(s => ({ ...s, connected: false })); })
      .build();

    return () => { closed = true; conn?.disconnect(); };
  }, [host, name]);
  return snap;
}
