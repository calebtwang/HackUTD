import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSafeProfile, assertUnchangedAssignment, assertUnchangedProfile, sipEnvironmentCredentials, type PhotonAssignment as Assignment, type PhotonProfile as Profile } from './photon-validation';

// Photon Beta (2.0), documented at https://api.photon.codes/openapi.json.
// Default: read-only inspection and a redacted plan. --apply configures existing
// explicitly selected resources only. This script never buys numbers or calls.
type Resource = {resourceId:string;state:string;type:string;abilities:string[];detail:Record<string,unknown>};
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const resourcesArg = args.find(arg=>arg.startsWith('--resources='));
if (args.some(arg=>arg!=='--apply' && arg!=='--dry-run' && !arg.startsWith('--resources='))) throw new Error('Use [--dry-run|--apply] [--resources=RESOURCE_ID,RESOURCE_ID,RESOURCE_ID].');
if (apply && args.includes('--dry-run')) throw new Error('Choose apply or dry-run, not both.');
const resourceIds = resourcesArg?.slice('--resources='.length).split(',').filter(Boolean) || [];
if (resourceIds.length && (resourceIds.length>2 || new Set(resourceIds).size!==resourceIds.length)) throw new Error('Select one or two distinct existing voice resources.');
const project = process.env.PHOTON_PROJECT_ID;
const key = process.env.PHOTON_API_KEY;
if (!project?.startsWith('pho_prj_') || !key) throw new Error('Set the Photon Beta project ID and API key locally.');
const root = `/v1/projects/${encodeURIComponent(project)}/platforms`;
const destinationUri = 'sips:sip.rtc.elevenlabs.io:5061';
const profileName = 'Honeyline demo inbound';
const privateFile = resolve('.local/photon-resources.json');
async function readJson<T>(path:string, fallback:T):Promise<T> {try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return fallback;throw new Error('A private local configuration file could not be read.');}}
async function request<T>(path:string,method='GET',body?:unknown):Promise<T> {
  if(method!=='GET'&&!apply)throw new Error('Dry-run attempted a write.');
  const response=await fetch(`https://api.photon.codes${path}`,{method,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',...(method==='POST'?{'Idempotency-Key':randomUUID()}: {})},signal:AbortSignal.timeout(30000),...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json() as any;
  if(!response.ok)throw new Error(`Photon ${method} failed: HTTP ${response.status}, ${typeof result.code==='string'?result.code:'request rejected'}.`);
  return result as T;
}
async function pages<T>(path:string,field:string):Promise<T[]> {
  const result:T[]=[];let token:string|undefined;
  do {const url=new URL(path,'https://api.photon.codes');url.searchParams.set('pageSize','200');if(token)url.searchParams.set('pageToken',token);const page=await request<Record<string,unknown>>(url.pathname+url.search);if(!Array.isArray(page[field]))throw new Error('Unexpected Photon list response.');result.push(...page[field] as T[]);token=typeof page.nextPageToken==='string'?page.nextPageToken:undefined;}while(token);
  return result;
}
async function run() {
  const envCredentials=sipEnvironmentCredentials(process.env.ELEVENLABS_SIP_USERNAME,process.env.ELEVENLABS_SIP_PASSWORD);
  const [resources,profiles]=await Promise.all([pages<Resource>(`${root}/resources?ability=pstn_voice&state=active`,'resources'),pages<Profile>(`${root}/voice/profiles`,'profiles')]);
  console.log(JSON.stringify({mode:apply?'apply':'dry-run',eligibleResources:resources.map(r=>({resourceId:r.resourceId,type:r.type,state:r.state,activationState:r.detail.activationState||'unknown'})),note:'Active ownership is not proof of a working call. No numbers will be purchased.'},null,2));
  if(!resourceIds.length){console.log('To preview exact routing, select one or two owned resource IDs using --resources=ID,ID.');if(apply)throw new Error('Apply requires explicit resource selection.');return;}
  // Photon admits routing by ownership and pstn_voice ability; activation is a separate timer.
  // Preparing a route never marks the number callable or tested.
  for(const id of resourceIds){const r=resources.find(r=>r.resourceId===id);if(!r||r.state!=='active'||!r.abilities.includes('pstn_voice'))throw new Error('A selected resource is not an owned voice-capable line.');}
  const saved=await readJson<{profileId?:string;resourceIds?:string[]}>(privateFile,{});
  const matches=profiles.filter(p=>p.profileId===saved.profileId||p.name===profileName);
  if(matches.length>1)throw new Error('Multiple Honeyline profiles exist; resolve the ambiguity before applying.');
  let profile=matches[0];
  if(profile)assertSafeProfile(profile,destinationUri);
  const assignments=await Promise.all(resourceIds.map(id=>request<Assignment>(`${root}/voice/lines/${encodeURIComponent(id)}/profile`)));
  if(assignments.some(a=>a.profileId&&a.profileId!==profile?.profileId))throw new Error('A selected line already has another explicit profile; no assignments were changed.');
  const credentials=envCredentials||await readJson<{username:string;password:string}|null>(resolve('.local/elevenlabs-sip.json'),null);
  const hasCredentials=!!credentials?.username&&!!credentials?.password;
  const defaultExists=profiles.some(p=>p.isDefault);
  console.log(JSON.stringify({plan:{createNeutralDefault:!defaultExists,createAdditionalProfile:!profile,profileName,destinationUri,mediaEncryption:'auto',credentials:hasCredentials?'loaded privately':'missing',assignOnlyResources:resourceIds,outbound:'unchanged / disabled',voiceReadyAfterConfiguration:false}},null,2));
  if(!apply){console.log('Dry-run complete. No provider resources were changed.');return;}
  if(!hasCredentials)throw new Error('Import the numbers into ElevenLabs first so matching inbound credentials are saved privately.');
  await mkdir(resolve('.local'),{recursive:true,mode:0o700});
  // Any routing change invalidates previous manual test readiness.
  const personaFile=resolve('.local/personas.json');
  const personas=await readJson<Record<string,Record<string,unknown>>>(personaFile,{});
  for(const id of ['scout','finch'])if(personas[id])personas[id].voiceReady=false;
  await writeFile(personaFile,JSON.stringify(personas,null,2)+'\n',{mode:0o600});
  if(!defaultExists)await request(`${root}/voice/profiles/default`,'PUT',{protocol:'sip',mediaEncryption:'auto'});
  if(!profile)profile=await request<Profile>(`${root}/voice/profiles`,'POST',{name:profileName,protocol:'sip',mediaEncryption:'auto'});
  await mkdir(resolve('.local'),{recursive:true,mode:0o700});
  await writeFile(privateFile,JSON.stringify({profileId:profile.profileId,resourceIds},null,2)+'\n',{mode:0o600});
  // Revalidate the inspected configuration, then use its version to guard the write.
  const currentProfile=await request<Profile>(`${root}/voice/profiles/${encodeURIComponent(profile.profileId)}`);
  assertUnchangedProfile(profile,currentProfile,destinationUri);
  profile=currentProfile;
  await request(`${root}/voice/profiles/${encodeURIComponent(profile.profileId)}/inbound`,'PUT',{expectedVersion:profile.version,destinationUri,credentials});
  for(const [index,id] of resourceIds.entries()){const current=await request<Assignment>(`${root}/voice/lines/${encodeURIComponent(id)}/profile`);assertUnchangedAssignment(assignments[index],current,profile.profileId);if(current.profileId!==profile.profileId)await request(`${root}/voice/lines/${encodeURIComponent(id)}/profile`,'PUT',{expectedVersion:current.resourceVersion,profileId:profile.profileId});}
  const configured=await request<Profile>(`${root}/voice/profiles/${encodeURIComponent(profile.profileId)}`);
  if(configured.configuration.inbound?.destinationUri!==destinationUri)throw new Error('Saved inbound destination did not match.');
  for(const id of resourceIds){const assigned=await request<Assignment>(`${root}/voice/lines/${encodeURIComponent(id)}/profile`);if(assigned.profileId!==profile.profileId)throw new Error('A saved line assignment did not match.');}
  console.log('Existing lines now use the saved ElevenLabs inbound route. No numbers were purchased and no calls placed.');
  console.log('Reload local persona configuration before starting another demo. Voice readiness remains false until a real incoming call confirms two-way audio, the correct character, and normal hang-up.');
}
run().catch(error=>{console.error(error instanceof Error?error.message:'Photon configuration failed.');process.exitCode=1;});
