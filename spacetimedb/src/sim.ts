// Pure, deterministic simulation of the leak-tracing product.
// No SpacetimeDB imports: this file is unit-testable from plain Node.
// All randomness flows through a caller-supplied `random()` so the same seed
// replays identically. The SpacetimeDB module owns persistence; this file only
// computes the next world state.

export type Source = 'simulated' | 'live';

export type SimSite = {
  id: string;
  label: string;
  leakiness: number;
  leaks: number;
  tracedCalls: number;
  source: Source;
};

export type SimPersona = {
  id: string;
  name: string;
  marker: string;
  phoneMasked: string;
  plants: number;
  callsReceived: number;
  source: Source;
};

export type Plant = {
  id: string;
  personaId: string;
  siteId: string;
  plantedAt: number;
  source: Source;
};

export type Ring = {
  id: string;
  label: string;
  pretext: string;
  calls: number;
  lastSeenAt: number;
};

// `leaked` is an implementation detail kept so `site.leaks` is counted exactly
// once per (ring, site) pair even after old calls are pruned. It mirrors the
// RingPurchase row's sim_ring_purchase.leaked column.
export type RingPurchase = {
  id: string;
  ringId: string;
  siteId: string;
  leaked: boolean;
};

export type CallOutcome = 'answered' | 'stalled' | 'hung_up';

export type LeakCall = {
  id: string;
  personaId: string;
  ringId: string;
  siteId: string;
  spokenMarker: string;
  outcome: CallOutcome;
  durationSeconds: number;
  source: Source;
  at: number;
};

export type SimStats = {
  running: boolean;
  seed: bigint;
  tick: bigint;
  calls: bigint;
  simulatedCalls: bigint;
  liveCalls: bigint;
  secondsBurned: bigint;
  personas: number;
  sites: number;
  rings: number;
};

export type SimWorld = {
  sites: SimSite[];
  personas: SimPersona[];
  rings: Ring[];
  plants: Plant[];
  purchases: RingPurchase[];
  calls: LeakCall[];
  stats: SimStats;
};

export type SeedCounts = { personaCount: number; siteCount: number; ringCount: number };
export type TickDelta = { newPlants: Plant[]; newCalls: LeakCall[]; newPurchases: RingPurchase[] };

// ---- Deterministic RNG (mulberry32) -------------------------------------

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seed32(seed: bigint): number {
  return Number(((seed % 4294967296n) + 4294967296n) % 4294967296n) >>> 0;
}

// A distinct, deterministic 32-bit seed for each tick of a given run.
export function tickSeed(seed: bigint, tick: bigint): number {
  return (seed32(seed) ^ seed32((tick + 1n) * 2654435761n)) >>> 0;
}

// ---- Word banks (fictional) ---------------------------------------------

const FIRST_NAMES = ['Mara', 'Otis', 'Nell', 'Gus', 'Edie', 'Hal', 'Pearl', 'Roy', 'Ada', 'Cyril', 'Wanda', 'Leon'];
const LAST_NAMES = ['Bell', 'Vale', 'Rowan', 'Knox', 'Pryor', 'Shaw', 'Mott', 'Fenn', 'Crane', 'Odom', 'Garza', 'Pike'];
const MARKER_ADJ = ['Cedar', 'Copper', 'Velvet', 'Amber', 'Silver', 'Hollow', 'Quiet', 'Marble', 'Dusky', 'Ivory'];
const MARKER_NOUN = ['Finch', 'Meadow', 'Acorn', 'Harbor', 'Lantern', 'Willow', 'Pebble', 'Thistle', 'Canyon', 'Brook'];
const SITE_LABELS = [
  'Utility credit callback',
  'Grant eligibility form',
  'Warranty renewal',
  'Benefit reassessment',
  'Rebate verification',
  'Account recovery intake',
  'Prize claim form',
  'Energy refund request',
];
const RING_LABELS = ['Blue Harbor', 'Ridgeline', 'Fairway', 'Northgate', 'Clearwater', 'Sunset Row', 'Birchwood', 'Delmont'];
const RING_PRETEXTS = ['bank security', 'Medicare', 'grandson in trouble', 'tech support', 'utility shutoff'];

function pick<T>(random: () => number, list: T[]): T {
  return list[Math.floor(random() * list.length) % list.length];
}

function maskedPhone(random: () => number): string {
  let last = '';
  for (let i = 0; i < 4; i++) last += Math.floor(random() * 10).toString();
  return `***-***-${last}`;
}

// ---- Seeding -------------------------------------------------------------

export function seedWorld(random: () => number, counts: SeedCounts): SimWorld {
  const siteCount = Math.max(1, counts.siteCount);
  const personaCount = Math.max(1, counts.personaCount);
  const ringCount = Math.max(1, counts.ringCount);

  const sites: SimSite[] = [];
  for (let i = 0; i < siteCount; i++) {
    const base = SITE_LABELS[i % SITE_LABELS.length];
    const label = i < SITE_LABELS.length ? base : `${base} ${Math.floor(i / SITE_LABELS.length) + 1}`;
    sites.push({ id: `site-${i}`, label, leakiness: 0.05 + random() * 0.55, leaks: 0, tracedCalls: 0, source: 'simulated' });
  }

  const usedMarkers = new Set<string>();
  const personas: SimPersona[] = [];
  for (let i = 0; i < personaCount; i++) {
    const name = `${pick(random, FIRST_NAMES)} ${pick(random, LAST_NAMES)}`;
    let marker = `${pick(random, MARKER_ADJ)} ${pick(random, MARKER_NOUN)} ${10 + Math.floor(random() * 90)}`;
    let guard = 0;
    while (usedMarkers.has(marker) && guard++ < 50) {
      marker = `${pick(random, MARKER_ADJ)} ${pick(random, MARKER_NOUN)} ${10 + Math.floor(random() * 90)}`;
    }
    usedMarkers.add(marker);
    personas.push({ id: `persona-${i}`, name, marker, phoneMasked: maskedPhone(random), plants: 0, callsReceived: 0, source: 'simulated' });
  }

  const rings: Ring[] = [];
  for (let i = 0; i < ringCount; i++) {
    rings.push({
      id: `ring-${i}`,
      label: i < RING_LABELS.length ? RING_LABELS[i] : `${RING_LABELS[i % RING_LABELS.length]} ${Math.floor(i / RING_LABELS.length) + 1}`,
      pretext: RING_PRETEXTS[i % RING_PRETEXTS.length],
      calls: 0,
      lastSeenAt: 0,
    });
  }

  const purchases: RingPurchase[] = [];
  for (const ring of rings) {
    for (const site of sites) {
      if (random() < site.leakiness) {
        purchases.push({ id: `${ring.id}:${site.id}`, ringId: ring.id, siteId: site.id, leaked: false });
      }
    }
  }
  // Guarantee every ring can act: give list-less rings their leakiest site.
  for (const ring of rings) {
    if (!purchases.some(pch => pch.ringId === ring.id)) {
      const site = [...sites].sort((a, b) => b.leakiness - a.leakiness)[0];
      purchases.push({ id: `${ring.id}:${site.id}`, ringId: ring.id, siteId: site.id, leaked: false });
    }
  }

  const stats: SimStats = {
    running: true,
    seed: 0n,
    tick: 0n,
    calls: 0n,
    simulatedCalls: 0n,
    liveCalls: 0n,
    secondsBurned: 0n,
    personas: personas.length,
    sites: sites.length,
    rings: rings.length,
  };

  return { sites, personas, rings, plants: [], purchases, calls: [], stats };
}

// ---- One simulation step -------------------------------------------------

function weightedSite(random: () => number, sites: SimSite[]): SimSite {
  const total = sites.reduce((sum, s) => sum + s.leakiness, 0);
  if (total <= 0) return pick(random, sites);
  let target = random() * total;
  for (const s of sites) {
    target -= s.leakiness;
    if (target <= 0) return s;
  }
  return sites[sites.length - 1];
}

export function tick(world: SimWorld, random: () => number, nowMicros: number): TickDelta {
  const delta: TickDelta = { newPlants: [], newCalls: [], newPurchases: [] };
  const sims = world.sites.filter(s => s.source === 'simulated');
  const simPersonas = world.personas.filter(p => p.source === 'simulated');
  if (!sims.length || !simPersonas.length || !world.rings.length) {
    world.stats.tick += 1n;
    return delta;
  }
  const plantKey = (personaId: string, siteId: string) => `${personaId}|${siteId}`;
  const havePlant = new Set(world.plants.map(p => plantKey(p.personaId, p.siteId)));
  let plantSeq = world.plants.length;

  // (a) plant a few personas on sites, weighted by leakiness
  const plantsThisTick = 2 + Math.floor(random() * 4);
  for (let i = 0; i < plantsThisTick; i++) {
    const persona = pick(random, simPersonas);
    const site = weightedSite(random, sims);
    const key = plantKey(persona.id, site.id);
    if (havePlant.has(key)) continue;
    havePlant.add(key);
    const plant: Plant = { id: `plant-${plantSeq++}`, personaId: persona.id, siteId: site.id, plantedAt: nowMicros, source: 'simulated' };
    world.plants.push(plant);
    delta.newPlants.push(plant);
    persona.plants += 1;
  }

  // (b) rings buy more lists, weighted by leakiness
  const haveBuy = new Set(world.purchases.map(p => `${p.ringId}|${p.siteId}`));
  const buysThisTick = 1 + Math.floor(random() * 3);
  for (let i = 0; i < buysThisTick; i++) {
    const ring = pick(random, world.rings);
    const site = weightedSite(random, sims);
    const key = `${ring.id}|${site.id}`;
    if (haveBuy.has(key)) continue;
    if (random() < site.leakiness) {
      haveBuy.add(key);
      const purchase: RingPurchase = { id: `${ring.id}:${site.id}`, ringId: ring.id, siteId: site.id, leaked: false };
      world.purchases.push(purchase);
      delta.newPurchases.push(purchase);
    }
  }

  // (c) simulated calls: a ring dials a persona it can reach through a bought list
  const siteById = new Map(world.sites.map(s => [s.id, s]));
  const personaById = new Map(world.personas.map(p => [p.id, p]));
  const purchaseByKey = new Map(world.purchases.map(p => [`${p.ringId}|${p.siteId}`, p]));
  const plantsBySite = new Map<string, Plant[]>();
  for (const plant of world.plants) {
    const list = plantsBySite.get(plant.siteId) ?? [];
    list.push(plant);
    plantsBySite.set(plant.siteId, list);
  }

  const callCount = 10 + Math.floor(random() * 31);
  let callSeq = world.calls.length;
  for (let i = 0; i < callCount; i++) {
    const ring = pick(random, world.rings);
    const owned = world.purchases.filter(p => p.ringId === ring.id);
    if (!owned.length) continue;
    const purchase = pick(random, owned);
    const plantsHere = plantsBySite.get(purchase.siteId);
    if (!plantsHere || !plantsHere.length) continue;
    const plant = pick(random, plantsHere);
    const persona = personaById.get(plant.personaId);
    const site = siteById.get(plant.siteId);
    if (!persona || !site) continue;

    const roll = random();
    const outcome: CallOutcome = roll < 0.45 ? 'answered' : roll < 0.75 ? 'stalled' : 'hung_up';
    const durationSeconds = outcome === 'stalled' ? 180 + Math.floor(random() * 301) : 20 + Math.floor(random() * 221);

    // Attribution: spoken marker -> plant -> site
    site.tracedCalls += 1;
    ring.calls += 1;
    ring.lastSeenAt = nowMicros;
    persona.callsReceived += 1;
    const pch = purchaseByKey.get(`${ring.id}|${site.id}`);
    if (pch && !pch.leaked) {
      pch.leaked = true;
      site.leaks += 1;
    }

    const call: LeakCall = {
      id: `call-${callSeq++}`,
      personaId: persona.id,
      ringId: ring.id,
      siteId: site.id,
      spokenMarker: persona.marker,
      outcome,
      durationSeconds,
      source: 'simulated',
      at: nowMicros,
    };
    world.calls.push(call);
    delta.newCalls.push(call);

    world.stats.calls += 1n;
    world.stats.simulatedCalls += 1n;
    world.stats.secondsBurned += BigInt(durationSeconds);
  }

  // (d) stats
  world.stats.tick += 1n;
  world.stats.personas = world.personas.length;
  world.stats.sites = world.sites.length;
  world.stats.rings = world.rings.length;
  return delta;
}
