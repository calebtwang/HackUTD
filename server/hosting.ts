import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { AppSnapshot, Site } from '../shared/contracts.js';
import { normalizeEntryPoints } from './entry-points.js';

export type HostingOptions = { port: number; managerOrigin?: string; demoOrigin?: string; demoAliases?: string[]; forumOrigin?: string; judgeCode?: string; production?: boolean };
const SESSION_COOKIE = '__Host-judge';
const SESSION_MS = 12 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MUTATIONS = new Set(['/api/demo/start', '/api/demo/stop', '/api/demo/reset', '/api/setup/reload']);
const MANAGER_PAGES = new Set(['/', '/debug', '/setup', '/evidence']);
const DEMO_PAGES = new Set(['/', '/forum', '/phishing', '/admin', '/demo/claim', '/demo/benign-event', '/demo/benign-news']);
const MANAGER_READS = new Set(['/api/state', '/api/events', '/api/debug/state', '/api/auth/status', '/api/public-config', '/health']);
const DEMO_READS = new Set(['/api/public-config']);
const FORUM_PAGES = new Set(['/', '/forum', '/demo/benign-event', '/demo/benign-news', '/api/public-config']);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function publicOrigin(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname.includes('*') || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) throw new Error(`${label} must be an exact HTTPS origin without a wildcard, path, credentials, or custom port.`);
  return url.origin;
}
function equalSecret(value: string, expected: string) {
  return timingSafeEqual(createHash('sha256').update(value).digest(), createHash('sha256').update(expected).digest());
}
function cookieToken(req: Request): string {
  const matches = (req.get('Cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${SESSION_COOKIE}=`));
  return matches.length === 1 ? matches[0].slice(SESSION_COOKIE.length + 1) : '';
}
export function staticAssetPath(pathname: string): boolean {
  return /^\/assets\/[a-zA-Z0-9_-]+\.(?:js|css|png|jpg|jpeg|svg|webp|gif|woff2?)$/.test(pathname);
}

/** Host and cookie policy is independent of the database and never trusts forwarded headers. */
export function createHosting(options: HostingOptions, now = Date.now) {
  const localOrigin = `http://127.0.0.1:${options.port}`;
  const hosted = Boolean(options.managerOrigin || options.demoOrigin || options.demoAliases?.length || options.forumOrigin);
  if (hosted && (!options.managerOrigin || !options.demoOrigin || !options.judgeCode || options.judgeCode.trim().length < 6)) throw new Error('Hosted mode requires both public origins and a JUDGE_ACCESS_CODE of at least 6 characters.');
  const managerOrigin = hosted ? publicOrigin(options.managerOrigin!, 'MANAGER_PUBLIC_ORIGIN') : localOrigin;
  const demoOrigin = hosted ? publicOrigin(options.demoOrigin!, 'DEMO_PUBLIC_ORIGIN') : localOrigin;
  if (hosted && managerOrigin === demoOrigin) throw new Error('Manager and demonstration origins must be different.');
  const demoOrigins = new Set([demoOrigin,...(options.demoAliases || []).map(value=>publicOrigin(value,'DEMO_PUBLIC_ALIASES'))]);
  if (hosted && demoOrigins.has(managerOrigin)) throw new Error('A demonstration alias cannot be the manager origin.');
  const fixtureHosts = new Map([...demoOrigins].map(origin=>[new URL(origin).host,origin]));
  const forumOrigin = options.forumOrigin ? publicOrigin(options.forumOrigin,'FORUM_PUBLIC_ORIGIN') : '';
  if (forumOrigin && (forumOrigin === managerOrigin || demoOrigins.has(forumOrigin))) throw new Error('The forum origin must be separate from manager and demonstration origins.');
  const forumHost = forumOrigin ? new URL(forumOrigin).host : '';
  const forumUrl = forumOrigin ? `${forumOrigin}/` : `${demoOrigin}/forum`;
  const production = hosted || Boolean(options.production);
  const sessions = new Map<string, number>();
  const failures = new Map<string, { attempts: number; expiresAt: number }>();
  let globalFailures = { attempts: 0, expiresAt: now() + RATE_WINDOW_MS };
  function fixtureOrigin(req: Request): string|undefined {
    return hosted ? fixtureHosts.get(req.get('Host')?.toLowerCase() || '') : undefined;
  }
  function siteMode(req: Request): 'manager'|'phishing'|'forum' {
    if (hosted && forumHost && req.get('Host')?.toLowerCase() === forumHost) return 'forum';
    return fixtureOrigin(req) ? 'phishing' : 'manager';
  }
  function authenticated(req: Request): boolean {
    if (!hosted) return true;
    if (siteMode(req) !== 'manager') return false;
    const token = cookieToken(req);
    const expiresAt = sessions.get(token);
    if (!expiresAt || expiresAt <= now()) { if (expiresAt) sessions.delete(token); return false; }
    return true;
  }
  function guard(req: Request, res: Response, next: NextFunction) {
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','X-Frame-Options':'DENY'});
    const host = req.get('Host')?.toLowerCase();
    if (!hosted) {
      if (!LOOPBACK.has(req.socket.remoteAddress || '') || ![`127.0.0.1:${options.port}`, `localhost:${options.port}`].includes(host || '')) { res.status(403).json({error:'Demo controls are available on this laptop only.'}); return; }
      const origin = req.get('Origin');
      if (!['GET','HEAD','OPTIONS'].includes(req.method) && origin && ![localOrigin, `http://localhost:${options.port}`].includes(origin)) { res.status(403).json({error:'Origin is not allowed.'}); return; }
      next(); return;
    }
    const requestedFixtureOrigin = fixtureOrigin(req);
    const forum = siteMode(req) === 'forum';
    if (host !== new URL(managerOrigin).host && !requestedFixtureOrigin && !forum) { res.status(403).json({error:'Host is not allowed.'}); return; }
    const fixture = Boolean(requestedFixtureOrigin);
    const read = req.method === 'GET' || req.method === 'HEAD';
    const allowed = read
      ? (forum ? FORUM_PAGES.has(req.path) : fixture ? DEMO_PAGES.has(req.path) || DEMO_READS.has(req.path) : MANAGER_PAGES.has(req.path) || MANAGER_READS.has(req.path)) || staticAssetPath(req.path)
      : !forum && req.method === 'POST' && (fixture ? req.path === '/api/mock/submit' : MUTATIONS.has(req.path) || ['/api/auth/login','/api/auth/logout'].includes(req.path));
    if (!allowed) { res.status(404).json({error:'Not found.'}); return; }
    if (!read && req.get('Origin') !== (requestedFixtureOrigin || managerOrigin)) { res.status(403).json({error:'Origin is not allowed.'}); return; }
    if (!fixture && (MUTATIONS.has(req.path) || req.path === '/api/debug/state') && !authenticated(req)) { res.status(401).json({error:'Enter the judge access code to use these controls.'}); return; }
    next();
  }
  function login(req: Request, res: Response) {
    if (!hosted) { res.json({authenticated:true,required:false}); return; }
    const time = now();
    const key = req.socket.remoteAddress || 'unknown';
    for (const [address, value] of failures) if (value.expiresAt <= time) failures.delete(address);
    if (globalFailures.expiresAt <= time) globalFailures = {attempts:0,expiresAt:time+RATE_WINDOW_MS};
    const prior = failures.get(key) || {attempts:0,expiresAt:time+RATE_WINDOW_MS};
    if (prior.attempts >= 8 || globalFailures.attempts >= 40) { res.set('Retry-After',String(Math.max(1,Math.ceil((prior.expiresAt-time)/1000))));res.status(429).json({error:'Too many attempts. Try again later.'});return; }
    const code = req.body?.code;
    if (typeof code !== 'string' || code.length > 500 || !equalSecret(code, options.judgeCode!)) {
      failures.set(key,{...prior,attempts:prior.attempts+1});globalFailures.attempts++;
      res.status(401).json({error:'The access code was not accepted.'}); return;
    }
    failures.delete(key);
    for (const [token, expiresAt] of sessions) if (expiresAt <= time) sessions.delete(token);
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
    sessions.delete(cookieToken(req));
    const token = randomBytes(32).toString('hex');
    sessions.set(token,time+SESSION_MS);
    res.set('Set-Cookie',`${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MS/1000}; HttpOnly; Secure; SameSite=Strict`);
    res.json({authenticated:true,required:true});
  }
  function logout(req: Request, res: Response) {
    sessions.delete(cookieToken(req));
    if (hosted) res.set('Set-Cookie',`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
    res.json({authenticated:!hosted,required:hosted});
  }
  function prepareRun(input: unknown, agentIds: string[]) {
    function normalized(base:string) {
      const entries=normalizeEntryPoints(input,agentIds,base);
      if(forumOrigin) for(const [id,value] of Object.entries(entries)) {
        if(!value) continue;
        const url=new URL(value);
        if(demoOrigins.has(url.origin) && url.pathname==='/forum') {
          const relocated=new URL(forumUrl);relocated.search=url.search;
          entries[id]=relocated.href;
        }
      }
      return entries;
    }
    const initial = normalized(demoOrigin);
    const selectedOrigin = Object.values(initial).filter(Boolean).map(value=>new URL(value).origin).find(origin=>demoOrigins.has(origin)) || demoOrigin;
    // Relative paths follow the selected owned fixture; explicit external URLs retain their origin.
    const entryPoints = selectedOrigin === demoOrigin ? initial : normalized(selectedOrigin);
    return {seedUrl:`${selectedOrigin}/forum`,entryPoints};
  }
  return {hosted,production,managerOrigin,demoOrigin,forumOrigin,forumUrl,siteMode,authenticated,guard,login,logout,
    publicConfig:(req:Request)=>({siteMode:siteMode(req),managerOrigin,demoOrigin:fixtureOrigin(req) || demoOrigin,forumOrigin,forumUrl,authRequired:hosted}),
    forumRedirect:(req:Request)=>hosted && forumOrigin && (siteMode(req)==='phishing' || siteMode(req)==='forum') ? `${forumUrl}${req.url.includes('?')?req.url.slice(req.url.indexOf('?')):''}` : undefined,
    canResume:(seedUrl:string)=>!hosted || demoOrigins.has(new URL(seedUrl).origin),prepareRun,
  };
}

/** Build every public field explicitly so new private fields cannot leak by default. */
export function publicSnapshot(current: AppSnapshot): AppSnapshot {
  const sites: Site[] = current.sites.map(site => ({
    id:site.id,runId:site.runId,url:site.url,title:site.title,evidence:[],confidence:site.confidence,
    recipe:site.recipe ? {url:site.recipe.url,fields:site.recipe.fields.map(field=>({label:field.label,valueFrom:field.valueFrom})),submitLabel:site.recipe.submitLabel,successText:site.recipe.successText} : null,
    status:site.status,discoveredBy:site.discoveredBy,verifiedAt:site.verifiedAt,analysisMode:site.analysisMode,
    submissionAllowed:site.submissionAllowed,observedFields:site.observedFields ? [...site.observedFields] : undefined,
    observedButtons:site.observedButtons ? [...site.observedButtons] : undefined,observedFormAction:site.observedFormAction,
    sourceUrl:site.sourceUrl,sourceLabel:site.sourceLabel,inspectionStatus:site.inspectionStatus,
  }));
  return {
    run:current.run ? {id:current.run.id,status:current.run.status,seedUrl:current.run.seedUrl,startedAt:current.run.startedAt,entryPoints:current.run.entryPoints ? {...current.run.entryPoints} : undefined,mode:current.run.mode} : null,
    agents:current.agents.map(agent=>({id:agent.id,name:agent.name,character:agent.character,phone:agent.phone,voiceAgentId:'',color:agent.color,voiceReady:Boolean(agent.voiceReady && agent.voiceAgentId && /^\+[1-9]\d{7,14}$/.test(agent.phone)),status:agent.status,heartbeatAt:agent.heartbeatAt})),
    sites,jobs:[],submissions:[],events:[],calls:[],
    setup:{database:{connected:current.setup.database.connected,host:'',name:''},model:{configured:current.setup.model.configured,provider:''},voice:{configured:current.setup.voice.configured,total:current.setup.voice.total,webhookReady:current.setup.voice.webhookReady},publicUrl:'',mode:current.setup.mode},
  };
}
