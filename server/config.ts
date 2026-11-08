import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PERSONAS, type Persona } from '../shared/contracts.js';

export const root = process.cwd();
export const localDir = path.join(root, '.local');
mkdirSync(localDir, { recursive: true, mode: 0o700 });
function localSecret(name: string): string {
  const filename = path.join(localDir, name);
  if (existsSync(filename)) return readFileSync(filename, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(filename, secret, { mode: 0o600 });
  return secret;
}
export const workerSecret = process.env.WORKER_SECRET || localSecret('worker-secret');
export const voiceToolSecret = process.env.VOICE_TOOL_SECRET || localSecret('voice-tool-secret');
export const port = Number(process.env.PORT || 3210);
export const webhookPort = Number(process.env.WEBHOOK_PORT || 3211);
export const baseUrl = `http://127.0.0.1:${port}`;
const databaseConfigFile=path.join(localDir,'database.json');
const databaseConfig: {host?:string;name?:string;tokenFile?:string}=existsSync(databaseConfigFile)?JSON.parse(readFileSync(databaseConfigFile,'utf8')):{};
export const databaseHost = process.env.SPACETIMEDB_HOST || databaseConfig.host || 'http://127.0.0.1:3000';
export const databaseName = process.env.SPACETIMEDB_DATABASE || databaseConfig.name || 'honeyline-demo';
export function personas(): Persona[] {
  let overrides: Record<string, Partial<Persona>> = {};
  const config = path.join(localDir, 'personas.json');
  if (existsSync(config)) overrides = JSON.parse(readFileSync(config, 'utf8'));
  return PERSONAS.map(persona => {
    const item = { ...persona, ...overrides[persona.id], id: persona.id };
    const envPrefix = persona.id.toUpperCase();
    item.phone = process.env[`${envPrefix}_PHONE`] || item.phone || `DEMO-${envPrefix}`;
    item.voiceAgentId = process.env[`${envPrefix}_ELEVENLABS_AGENT_ID`] || item.voiceAgentId;
    item.voiceReady = Boolean(item.voiceReady && /^\+[1-9]\d{7,14}$/.test(item.phone) && item.voiceAgentId);
    return item;
  });
}
export function publicUrl(): string {
  const file = path.join(localDir, 'public-url');
  return (process.env.PUBLIC_WEBHOOK_URL || (existsSync(file) ? readFileSync(file, 'utf8') : '')).trim().replace(/\/$/, '');
}
export function adminToken(): string|undefined {
  if (process.env.SPACETIMEDB_TOKEN) return process.env.SPACETIMEDB_TOKEN;
  if (process.env.SPACETIMEDB_TOKEN_FILE) return readFileSync(path.resolve(root,process.env.SPACETIMEDB_TOKEN_FILE),'utf8').trim();
  if(databaseConfig.tokenFile) return readFileSync(path.resolve(root,databaseConfig.tokenFile),'utf8').trim();
  for (const name of ['admin-token', 'admin-token.txt']) {
    const file = path.join(localDir, name);
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  }
  return undefined;
}
