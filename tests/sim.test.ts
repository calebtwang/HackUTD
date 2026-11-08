import assert from 'node:assert/strict';
import test from 'node:test';
import {
  makeRng,
  seed32,
  tickSeed,
  seedWorld,
  tick,
  type SeedCounts,
  type SimWorld,
} from '../spacetimedb/src/sim';

// Replays the module's per-tick RNG derivation (index.ts simTick) so these
// unit tests exercise the same world evolution the database does.
function run(seed: bigint, counts: SeedCounts, ticks: number): SimWorld {
  const world = seedWorld(makeRng(seed32(seed)), counts);
  world.stats.seed = seed;
  world.stats.tick = 0n;
  for (let i = 0; i < ticks; i++) {
    const rng = makeRng(tickSeed(seed, world.stats.tick));
    tick(world, rng, 1_700_000_000_000_000 + i);
  }
  return world;
}

// JSON cannot serialize BigInt; stringify through this replacer for comparison.
const bigintSafe = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? `${value}n` : value;
const snapshot = (world: SimWorld) => JSON.stringify(world, bigintSafe);

const COUNTS: SeedCounts = { personaCount: 120, siteCount: 24, ringCount: 6 };

test('same seed produces an identical world after N ticks', () => {
  const a = run(42n, COUNTS, 30);
  const b = run(42n, COUNTS, 30);
  assert.equal(snapshot(a), snapshot(b));
  // The determinism has to hold at the aggregate level too, not just the blob.
  assert.equal(a.stats.calls, b.stats.calls);
  assert.equal(a.stats.secondsBurned, b.stats.secondsBurned);
  assert.ok(a.stats.calls > 0n, 'simulation should have produced calls');
});

test('different seeds diverge', () => {
  const a = run(42n, COUNTS, 30);
  const b = run(7n, COUNTS, 30);
  assert.notEqual(snapshot(a), snapshot(b));
});

test('seeded counts respect their floors and requested sizes', () => {
  // sim.ts enforces a floor of one of each; the DB reducer adds the upper caps.
  const floored = seedWorld(makeRng(seed32(1n)), { personaCount: 0, siteCount: 0, ringCount: 0 });
  assert.equal(floored.sites.length, 1);
  assert.equal(floored.personas.length, 1);
  assert.equal(floored.rings.length, 1);

  const sized = seedWorld(makeRng(seed32(99n)), COUNTS);
  assert.equal(sized.sites.length, COUNTS.siteCount);
  assert.equal(sized.personas.length, COUNTS.personaCount);
  assert.equal(sized.rings.length, COUNTS.ringCount);
  assert.equal(sized.stats.personas, COUNTS.personaCount);
  assert.equal(sized.stats.sites, COUNTS.siteCount);
  assert.equal(sized.stats.rings, COUNTS.ringCount);
});

test('every call marker resolves to its planted persona and increments the right site', () => {
  const world = run(42n, COUNTS, 40);
  const personaById = new Map(world.personas.map(p => [p.id, p]));
  const plantKeys = new Set(world.plants.map(pl => `${pl.personaId}|${pl.siteId}`));
  const callsPerSite = new Map<string, number>();

  assert.ok(world.calls.length > 0, 'expected simulated calls');
  for (const call of world.calls) {
    const persona = personaById.get(call.personaId);
    assert.ok(persona, `call ${call.id} references a missing persona`);
    // Spoken marker must be exactly the planted persona's marker.
    assert.equal(call.spokenMarker, persona!.marker);
    // The persona must actually have been planted on the attributed site.
    assert.ok(plantKeys.has(`${call.personaId}|${call.siteId}`),
      `call ${call.id} was not backed by a plant on ${call.siteId}`);
    callsPerSite.set(call.siteId, (callsPerSite.get(call.siteId) ?? 0) + 1);
  }

  // Attribution: each site's tracedCalls equals the calls attributed to it.
  for (const site of world.sites) {
    assert.equal(site.tracedCalls, callsPerSite.get(site.id) ?? 0,
      `site ${site.id} tracedCalls disagrees with its call count`);
  }
});

test('leakier sites trace more calls over many ticks', () => {
  const world = run(1234n, COUNTS, 200);
  const byLeak = [...world.sites].sort((a, b) => a.leakiness - b.leakiness);
  const leakiest = byLeak[byLeak.length - 1];
  const leakLeast = byLeak[0];
  assert.ok(leakiest.tracedCalls > leakLeast.tracedCalls,
    `expected the leakiest site (${leakiest.tracedCalls}) to out-trace the least leaky (${leakLeast.tracedCalls})`);
});

test('persona markers are unique', () => {
  const world = seedWorld(makeRng(seed32(42n)), COUNTS);
  const markers = world.personas.map(p => p.marker);
  assert.equal(new Set(markers).size, markers.length);
});
