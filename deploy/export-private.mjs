// Execute only at the explicit cutover step. Never print credential contents.
import { parse } from 'dotenv';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2] && path.resolve(process.argv[2]);
if (!output || process.argv.length !== 3) throw new Error('Usage: node deploy/export-private.mjs /private/path/hackutd-private.tar.gz');
if (output === root || output.startsWith(root + path.sep)) throw new Error('Write the private archive outside the source checkout.');
if (existsSync(output)) throw new Error('Output already exists; choose a new private archive path.');
for (const filename of ['.env', '.local/personas.json']) {
  if (!lstatSync(path.join(root, filename)).isFile()) throw new Error(`Private migration requires a regular file: ${filename}`);
}
const env = parse(readFileSync(path.join(root, '.env')));
if (!env.SPACETIMEDB_HOST || !env.SPACETIMEDB_DATABASE || !env.SPACETIMEDB_TOKEN) throw new Error('The private .env must contain the existing cloud database host, name and owner token.');
const host = env.SPACETIMEDB_HOST.replace(/\/$/, '');
const database = env.SPACETIMEDB_DATABASE;
const namespace = createHash('sha256').update(`${host}|${database}`).digest('hex').slice(0, 16);
const files = ['.env', '.local/personas.json'];
for (const id of ['scout', 'finch']) {
  const filename = `.local/worker-${id}-${namespace}.json`;
  if (!lstatSync(path.join(root, filename)).isFile()) throw new Error(`Private migration requires a regular identity file for ${id}.`);
  const identity = JSON.parse(readFileSync(path.join(root, filename), 'utf8'));
  if (!identity.token || identity.host !== host || identity.database !== database) throw new Error(`Current cloud identity does not match for ${id}.`);
  files.push(filename);
}
if (!existsSync(path.join(root, '.local/personas.json'))) throw new Error('Missing tested phone readiness file.');
process.umask(0o077);
const result = spawnSync('tar', ['-czf', output, ...files], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
if (result.status !== 0) throw new Error('Private archive creation failed; no credential contents were printed.');
chmodSync(output, 0o600);
console.log('Created a private archive containing only .env, personas.json, and the two current cloud worker identities.');
