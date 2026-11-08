import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { serverHealthy } from './healthcheck.mjs';

// An empty runtime volume must never create new identities for an existing DB.
function validateMigration() {
  for (const key of ['SPACETIMEDB_HOST', 'SPACETIMEDB_DATABASE', 'SPACETIMEDB_TOKEN', 'WORKER_SECRET', 'VOICE_TOOL_SECRET', 'JUDGE_ACCESS_CODE']) {
    if (!process.env[key]?.trim()) throw new Error(`Missing required private setting: ${key}`);
  }
  if (process.env.JUDGE_ACCESS_CODE.trim().length < 12) throw new Error('JUDGE_ACCESS_CODE must contain at least 12 characters.');
  const host = process.env.SPACETIMEDB_HOST.replace(/\/$/, '');
  const database = process.env.SPACETIMEDB_DATABASE;
  const target = new URL(host);
  if (['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('Hosted deployment requires the existing remote SpacetimeDB, not a laptop database.');
  const namespace = createHash('sha256').update(`${host}|${database}`).digest('hex').slice(0, 16);
  for (const id of ['scout', 'finch']) {
    let identity;
    try { identity = JSON.parse(readFileSync(`.local/worker-${id}-${namespace}.json`, 'utf8')); }
    catch { throw new Error(`Missing or invalid migrated identity for ${id}; copy the current database identity instead of creating a replacement.`); }
    if (!identity.token || identity.host !== host || identity.database !== database) throw new Error(`Migrated identity does not match the configured database for ${id}.`);
  }
  try { JSON.parse(readFileSync('.local/personas.json', 'utf8')); }
  catch { throw new Error('The migrated personas.json file is required to preserve tested phone readiness.'); }
}

try { validateMigration(); }
catch (error) { console.error(error instanceof Error ? error.message : 'Deployment settings are incomplete.'); process.exit(1); }

const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { stdio: 'inherit', env: process.env });
let stopping = false;
let exitCode = 0;
let failures = 0;
let probing = false;
let watchdog;
let forceExit;

function stop(code) {
  if (stopping) return;
  stopping = true; exitCode = code;
  clearTimeout(startWatchdog); clearInterval(watchdog);
  child.kill('SIGTERM');
  forceExit = setTimeout(() => { child.kill('SIGKILL'); process.exit(code); }, 25000);
}

child.once('error', () => { console.error('Could not start the application process.'); stop(1); });
child.once('exit', code => {
  clearTimeout(startWatchdog); clearInterval(watchdog); clearTimeout(forceExit);
  process.exit(stopping ? exitCode : (code ?? 1));
});
process.once('SIGTERM', () => stop(0));
process.once('SIGINT', () => stop(0));

const startWatchdog = setTimeout(() => {
  watchdog = setInterval(async () => {
    if (probing || stopping) return;
    probing = true;
    try {
      failures = await serverHealthy() ? 0 : failures + 1;
      if (failures >= 4) { console.error('The app stopped responding to health probes; restarting its container.'); stop(1); }
    } finally { probing = false; }
  }, 15000);
}, 60000);
