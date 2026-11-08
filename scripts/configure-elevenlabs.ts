import 'dotenv/config';
import { ElevenLabsClient, type ElevenLabs } from '@elevenlabs/elevenlabs-js';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { PERSONAS, type Persona } from '../shared/contracts.ts';
import { makeAgentConfig, observationTool, publicWebhookBase } from './voice-config.ts';

type PersonaId = 'scout' | 'finch' | 'wren';
type Resources = {
  scope: string;
  secretId?: string;
  toolId?: string;
  webhook?: { id: string; url: string };
  agents: Partial<Record<PersonaId, { id: string; voiceId: string; phoneNumberId?: string; branchId?: string }>>;
};
class SetupError extends Error {}
const root = process.cwd();
const localDir = resolve(root, '.local');
const resourcePath = resolve(localDir, 'elevenlabs-resources.json');
const personaPath = resolve(localDir, 'personas.json');
let phase = 'checking local configuration';

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw new SetupError(`Invalid local configuration file: ${file.split('/').pop()}`); }
}
async function readOptional(file: string): Promise<string> {
  try { return (await readFile(file, 'utf8')).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
async function privateWrite(file: string, value: string): Promise<void> {
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}
async function saveEnvSecret(key: string, value: string): Promise<void> {
  const envPath = resolve(root, '.env');
  const previous = await readOptional(envPath);
  const line = `${key}=${JSON.stringify(value)}`;
  const expression = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, 'm');
  const updated = expression.test(previous) ? previous.replace(expression, () => line) : `${previous}${previous ? '\n' : ''}${line}`;
  await privateWrite(envPath, `${updated}\n`);
  process.env[key] = value;
}

function parseOptions() {
  let selection: PersonaId | 'all' = 'scout';
  let apply = false;
  let voiceOnly = false;
  for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--voice-only') voiceOnly = true;
    else if (arg === '--agent') {
      const value = process.argv[++index];
      if (!['scout', 'finch', 'wren', 'all'].includes(value)) throw new SetupError('--agent must be scout, finch, wren, or all.');
      selection = value as PersonaId | 'all';
    } else throw new SetupError('Usage: configure-elevenlabs.ts [--agent scout|finch|wren|all] [--dry-run|--apply] [--voice-only]');
  }
  return { selection, apply, voiceOnly };
}

async function run(): Promise<void> {
  const options = parseOptions();
  const overrides = await readJson<Record<string, Partial<Persona>>>(personaPath, {});
  const personas = PERSONAS.filter(p => options.selection === 'all' || p.id === options.selection).map(p => ({
    ...p, ...overrides[p.id], id: p.id,
    phone: process.env[`${p.id.toUpperCase()}_PHONE`] || overrides[p.id]?.phone || '',
  }));
  const resources = await readJson<Resources>(resourcePath, { scope: '', agents: {} });
  const publicUrl = process.env.PUBLIC_WEBHOOK_URL || await readOptional(resolve(localDir, 'public-url'));
  if (!options.apply) {
    for (const persona of personas) {
      const config = makeAgentConfig({ persona, voiceId: 'STOCK_VOICE_SELECTED_ON_APPLY', name: `Honeyline Demo - ${persona.name}`, tag: 'dry-run', ...(options.voiceOnly ? {} : { toolId: 'OBSERVATION_TOOL', toolName: 'honeyline_report_observation', webhookId: 'SIGNED_POST_CALL_WEBHOOK' }) });
      console.log(JSON.stringify({ mode: 'dry-run', persona: persona.id, name: config.name, greeting: config.conversationConfig.agent?.firstMessage, maxSeconds: config.conversationConfig.conversation?.maxDurationSeconds, stockVoice: true, importConfiguredNumber: /^\+[1-9]\d{7,14}$/.test(persona.phone), observationTool: !options.voiceOnly, signedPostCallWebhook: !options.voiceOnly, voiceReadyAfterSetup: false }));
    }
    console.log('Dry-run complete. No API calls, purchases, calls, or configuration writes were performed.');
    return;
  }
  if (!process.env.ELEVENLABS_API_KEY) throw new SetupError('ELEVENLABS_API_KEY is missing. Store it in the private .env file.');
  if (!options.voiceOnly) {
    if (!publicUrl) throw new SetupError('Start the public webhook connection first, or select --voice-only for an initial phone-audio test.');
    try { publicWebhookBase(publicUrl); } catch (error) { throw new SetupError((error as Error).message); }
  }
  if (!resources.scope) resources.scope = randomBytes(5).toString('hex');
  const saveResources = () => privateWrite(resourcePath, JSON.stringify(resources, null, 2) + '\n');
  await saveResources();
  const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
  const tag = `honeyline-${resources.scope}`;
  const toolName = `honeyline_report_observation_${resources.scope}`;

  phase = 'selecting stock voices';
  const available = (await client.voices.search({ voiceType: 'default', pageSize: 100, includeCustomRates: false })).voices.filter(voice => voice.category === 'premade');
  const used = new Set(Object.values(resources.agents).map(record => record?.voiceId).filter(Boolean));
  const selectedVoices = new Map<string, string>();
  for (const persona of personas) {
    const key = persona.id as PersonaId;
    const explicit = process.env[`${key.toUpperCase()}_ELEVENLABS_VOICE_ID`];
    let voice = explicit ? available.find(v => v.voiceId === explicit) : available.find(v => v.voiceId === resources.agents[key]?.voiceId);
    if (explicit && !voice) {
      const lookup = await client.voices.get(explicit);
      if (lookup.category !== 'premade') throw new SetupError(`${key}: select a stock ElevenLabs voice for this demo.`);
      voice = lookup;
    }
    if (!voice) {
      const preferredGender = key === 'finch' ? 'male' : 'female';
      voice = available.find(v => !used.has(v.voiceId) && v.labels?.gender === preferredGender) || available.find(v => !used.has(v.voiceId));
    }
    if (!voice) throw new SetupError('Not enough distinct stock voices were available. Set a valid per-persona ELEVENLABS_VOICE_ID.');
    selectedVoices.set(key, voice.voiceId); used.add(voice.voiceId);
  }

  if (!options.voiceOnly) {
    phase = 'configuring the observation secret';
    const bearer = process.env.VOICE_TOOL_SECRET || await readOptional(resolve(localDir, 'voice-tool-secret'));
    if (!bearer) throw new SetupError('Start Honeyline once so its private voice-tool-secret exists.');
    const secretName = `Honeyline ${resources.scope} observation authorization`;
    if (!resources.secretId) {
      const matches = (await client.conversationalAi.secrets.list({ search: secretName, pageSize: 100 })).secrets.filter(secret => secret.name === secretName);
      if (matches.length > 1) throw new SetupError('Multiple matching Honeyline observation secrets exist; resolve the duplicate in ElevenLabs.');
      resources.secretId = matches[0]?.secretId;
    }
    if (resources.secretId) await client.conversationalAi.secrets.update(resources.secretId, { name: secretName, value: `Bearer ${bearer}` });
    else resources.secretId = (await client.conversationalAi.secrets.create({ name: secretName, value: `Bearer ${bearer}` })).secretId;
    await saveResources();

    phase = 'configuring the observation tool';
    if (!resources.toolId) {
      const matches = (await client.conversationalAi.tools.list({ search: toolName, pageSize: 100 })).tools.filter(tool => tool.toolConfig.type === 'webhook' && tool.toolConfig.name === toolName);
      if (matches.length > 1) throw new SetupError('Multiple matching Honeyline observation tools exist; resolve the duplicate in ElevenLabs.');
      resources.toolId = matches[0]?.id;
    }
    const tool = observationTool(toolName, publicUrl, resources.secretId);
    if (resources.toolId) await client.conversationalAi.tools.update(resources.toolId, tool);
    else resources.toolId = (await client.conversationalAi.tools.create(tool)).id;
    await saveResources();

    phase = 'configuring the signed post-call webhook';
    const url = `${publicWebhookBase(publicUrl)}/webhooks/elevenlabs/post-call`;
    const urlTag = createHash('sha256').update(url).digest('hex').slice(0, 8);
    const name = `Honeyline ${resources.scope} transcripts ${urlTag}`;
    const hooks = (await client.webhooks.list({ includeUsages: false })).webhooks;
    let webhook = hooks.find(h => h.webhookId === resources.webhook?.id && h.webhookUrl === url);
    if (!webhook) webhook = hooks.find(h => h.name === name && h.webhookUrl === url);
    if (webhook) {
      if (!process.env.ELEVENLABS_WEBHOOK_SECRET) throw new SetupError('The existing post-call webhook signing secret is missing locally. Restore ELEVENLABS_WEBHOOK_SECRET; do not invent a replacement.');
      await client.webhooks.update(webhook.webhookId, { name, isDisabled: false, retryEnabled: true });
      resources.webhook = { id: webhook.webhookId, url };
    } else {
      const created = await client.webhooks.create({ settings: { authType: 'hmac', name, webhookUrl: url } });
      if (!created.webhookSecret) throw new SetupError('ElevenLabs created a webhook without returning its signing secret. Resolve this in the dashboard before proceeding.');
      await saveEnvSecret('ELEVENLABS_WEBHOOK_SECRET', created.webhookSecret);
      resources.webhook = { id: created.webhookId, url };
      await client.webhooks.update(created.webhookId, { name, isDisabled: false, retryEnabled: true });
    }
    await saveResources();
  }

  for (const persona of personas) {
    const key = persona.id as PersonaId;
    phase = `configuring the ${key} agent`;
    const name = `Honeyline Demo - ${persona.name} [${resources.scope}]`;
    const voiceId = selectedVoices.get(key)!;
    let agentId = resources.agents[key]?.id || process.env[`${key.toUpperCase()}_ELEVENLABS_AGENT_ID`] || overrides[key]?.voiceAgentId;
    if (!agentId) {
      const found = (await client.conversationalAi.agents.list({ search: name, tags: tag, pageSize: 100 })).agents.filter(agent => agent.name === name && agent.tags.includes(tag));
      if (found.length > 1) throw new SetupError(`${key}: duplicate Honeyline agents found; select one in the private local mapping.`);
      agentId = found[0]?.agentId;
    }
    const config = makeAgentConfig({ persona, voiceId, name, tag, ...(options.voiceOnly ? {} : { toolId: resources.toolId, toolName, webhookId: resources.webhook!.id }) });
    if (agentId) {
      const existing = await client.conversationalAi.agents.get(agentId);
      await client.conversationalAi.agents.update(agentId, { ...config, branchId: existing.mainBranchId, versionDescription: 'Honeyline controlled four-minute demo configuration' });
    } else agentId = (await client.conversationalAi.agents.create(config)).agentId;
    resources.agents[key] = { ...resources.agents[key], id: agentId, voiceId };
    await saveResources();
    const configured = await client.conversationalAi.agents.get(agentId);
    if (configured.conversationConfig.agent?.firstMessage !== 'Hello?' || configured.conversationConfig.conversation?.maxDurationSeconds !== 240) {
      throw new SetupError(`${key}: the saved greeting or call duration did not match the requested settings.`);
    }
    resources.agents[key]!.branchId = configured.mainBranchId;
    overrides[key] = { ...overrides[key], phone: persona.phone, voiceAgentId: agentId, voiceReady: false };
    await privateWrite(personaPath, JSON.stringify(overrides, null, 2) + '\n');
    await saveResources();

    if (/^\+[1-9]\d{7,14}$/.test(persona.phone)) {
      phase = `importing the configured ${key} SIP number`;
      const sipPath = resolve(localDir, 'elevenlabs-sip.json');
      let sip = await readJson<{ username: string; password: string } | null>(sipPath, null);
      const username = process.env.ELEVENLABS_SIP_USERNAME;
      const password = process.env.ELEVENLABS_SIP_PASSWORD;
      if (Boolean(username) !== Boolean(password)) throw new SetupError('Set both ELEVENLABS_SIP_USERNAME and ELEVENLABS_SIP_PASSWORD, or neither.');
      if (username && password) sip = { username, password };
      if (!sip) {
        sip = { username: `honeyline_${resources.scope}`, password: randomBytes(24).toString('hex') };
        await privateWrite(sipPath, JSON.stringify(sip, null, 2) + '\n');
      }
      const existing = (await client.conversationalAi.phoneNumbers.list({ provider: 'sip_trunk' })).find(number => number.phoneNumber === persona.phone);
      const label = `Honeyline ${persona.name} [${resources.scope}]`;
      if (existing && existing.label !== label && resources.agents[key]?.phoneNumberId !== existing.phoneNumberId) {
        throw new SetupError(`${key}: this number is already imported under another label. Review its assignment before reusing it.`);
      }
      const inboundTrunkConfig = { mediaEncryption: 'allowed' as const, credentials: sip };
      const phoneNumberId = existing?.phoneNumberId || (await client.conversationalAi.phoneNumbers.create({ provider: 'sip_trunk', phoneNumber: persona.phone, label, agentId, supportsInbound: true, supportsOutbound: false, inboundTrunkConfig })).phoneNumberId;
      await client.conversationalAi.phoneNumbers.update(phoneNumberId, { agentId, label, inboundTrunkConfig, branchId: configured.mainBranchId });
      resources.agents[key]!.phoneNumberId = phoneNumberId;
      await saveResources();
      console.log(`${key}: agent and configured SIP number are linked. Photon routing and a two-way audio test are still required.`);
    } else console.log(`${key}: agent configured. No provisioned phone number was imported.`);
  }
  console.log('Setup saved privately. No numbers were purchased and no calls were placed. Voice readiness remains false until a successful test call.');
  if (!options.voiceOnly) console.log('Restart Honeyline to load the saved webhook signing secret, then reload persona configuration.');
  console.log('Photon inbound destination: sips:sip.rtc.elevenlabs.io:5061 (TLS, Auto media encryption). SIP credentials are in .local/elevenlabs-sip.json when numbers are imported; do not share that file.');
}

run().catch(error => {
  const status = error && typeof error === 'object' && 'statusCode' in error ? ` (HTTP ${String(error.statusCode)})` : '';
  console.error(error instanceof SetupError ? error.message : `ElevenLabs setup failed while ${phase}${status}. The response body and credentials were not printed.`);
  const detail = error && typeof error === 'object' ? error.body?.detail : undefined;
  if (Array.isArray(detail)) {
    for (const issue of detail.slice(0, 8)) {
      const location = Array.isArray(issue?.loc) ? issue.loc.filter((part: unknown) => typeof part === 'number' || (typeof part === 'string' && /^[a-zA-Z0-9_]+$/.test(part))).join('.') : 'configuration';
      const type = typeof issue?.type === 'string' && /^[a-zA-Z0-9_]+$/.test(issue.type) ? issue.type : 'validation_error';
      console.error(`Validation: ${location} (${type})`);
    }
  } else if (detail && typeof detail === 'object') {
    const code = detail.status ?? detail.code;
    if (typeof code === 'string' && /^[a-zA-Z0-9_ -]{1,100}$/.test(code)) console.error(`Provider error code: ${code}`);
    if (detail.message === 'Invalid conversation config: Value error, English Agents must use turbo or flash v2.') {
      console.error('The configured English agent requires the Flash v2 speech model.');
    }
  }
  process.exitCode = 1;
});
