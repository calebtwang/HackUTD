import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EMPTY_STATE, PERSONAS, type AppSnapshot, type Agent, type Call, type Site } from '../shared/contracts';
import { isPhoneNumber, modelDemoReady, phonePresentation } from '../shared/readiness';
import './style.css';

const INITIAL: AppSnapshot = { ...EMPTY_STATE, setup: {
  database: { connected: false, host: '', name: '' }, model: { configured: false, provider: '' },
  voice: { configured: 0, total: 2, webhookReady: false }, publicUrl: '', mode: 'rehearsal',
} };
const AGENT_IDS = ['scout', 'finch'] as const;
type EntryPoints = Record<typeof AGENT_IDS[number], string>;
const DEFAULT_ENTRY_POINTS: EntryPoints = { scout: 'http://localhost:3210/forum', finch: '' };
const ENTRY_POINTS_KEY = 'demo-entry-points';
const fmtTime = (time: number) => time ? new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const duration = (seconds: number) => `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60).toString().padStart(2, '0')}s`;
const statusText = (status: string) => status.replaceAll('_', ' ').replaceAll('-', ' ');
type PublicConfig = { siteMode: 'manager' | 'phishing' | 'forum'; demoOrigin: string; managerOrigin: string; forumOrigin?: string; forumUrl?: string; authRequired: boolean };
type AccessState = { authenticated: boolean; required: boolean };

async function readPublicConfig(): Promise<PublicConfig> {
  const response = await fetch('/api/public-config');
  if (response.status === 404 && ['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    return { siteMode: 'manager', demoOrigin: window.location.origin, managerOrigin: window.location.origin, forumOrigin: '', forumUrl: new URL('/forum',window.location.origin).href, authRequired: false };
  }
  if (!response.ok) throw new Error('Unable to load the demo settings. Refresh to try again.');
  return response.json();
}

function initialEntryPoints(): EntryPoints {
  try {
    const saved = JSON.parse(localStorage.getItem(ENTRY_POINTS_KEY) || 'null');
    if (saved && typeof saved.scout === 'string' && typeof saved.finch === 'string') return { scout: saved.scout, finch: saved.finch };
  } catch { /* Entry points still work when browser storage is unavailable. */ }
  return { ...DEFAULT_ENTRY_POINTS };
}

function App() {
  const path = window.location.pathname;
  // Fixture pages never receive the manager snapshot or call records.
  if (path === '/admin') return <pre className="numbers-only" />;
  if (path === '/phishing' || path.startsWith('/demo/')) return <FixturePage path={path} />;
  if (path === '/forum') return <Forum />;
  if (path === '/') return <RootPage />;
  return <Manager path={path} />;
}

function RootPage() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    readPublicConfig().then(value => { if (alive) setConfig(value); })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : 'Unable to load this page.'); });
    return () => { alive = false; };
  }, []);
  if (error) return <div className="manager"><main><p className="notice error" role="alert">{error}</p></main></div>;
  if (!config) return <div className="manager"><main><p role="status">Connecting…</p></main></div>;
  return config.siteMode === 'phishing' ? <FixturePage path="/phishing" /> : config.siteMode === 'forum' ? <Forum initialConfig={config} /> : <Manager path="/" initialConfig={config} />;
}

function Manager({ path, initialConfig }: { path: string; initialConfig?: PublicConfig }) {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(INITIAL);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [entryPoints, setEntryPoints] = useState<EntryPoints>(initialEntryPoints);
  const [entryPointsEdited, setEntryPointsEdited] = useState(false);
  const [access, setAccess] = useState<AccessState | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(initialConfig || null);
  const [accessCode, setAccessCode] = useState('');
  const [authPending, setAuthPending] = useState(false);
  const canControl = Boolean(access && (!access.required || access.authenticated));
  const isDebug = path === '/debug';
  useEffect(() => {
    let alive = true;
    document.title = isDebug ? 'Debugging' : 'Agent manager';
    const legacyLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    Promise.all([
      fetch('/api/auth/status').then(async response => {
        if (response.status === 404 && legacyLocal) return { authenticated: true, required: false };
        if (!response.ok) throw new Error('Unable to check access. Refresh to try again.');
        return response.json() as Promise<AccessState>;
      }),
      initialConfig ? Promise.resolve(initialConfig) : readPublicConfig(),
    ]).then(([status, settings]) => { if (alive) { setAccess(status); setConfig(settings); } })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : 'Unable to connect.'); });
    return () => { alive = false; };
  }, [isDebug, initialConfig]);
  useEffect(() => {
    const saved = snapshot.run?.entryPoints;
    let browserHasSavedEntries = false;
    try { browserHasSavedEntries = Boolean(localStorage.getItem(ENTRY_POINTS_KEY)); } catch { /* Storage is optional. */ }
    if (!entryPointsEdited) {
      if (saved) {
        const adopted = { scout: saved.scout || '', finch: saved.finch || '' };
        setEntryPoints(adopted);
        try { localStorage.setItem(ENTRY_POINTS_KEY, JSON.stringify(adopted)); } catch { /* Storage is optional. */ }
      }
      else if (!snapshot.run && !browserHasSavedEntries && config?.authRequired && config.demoOrigin) setEntryPoints({ scout: config.forumUrl || new URL('/forum', config.demoOrigin).href, finch: '' });
    }
  }, [snapshot.run?.id, snapshot.run?.entryPoints?.scout, snapshot.run?.entryPoints?.finch, entryPointsEdited, config]);
  useEffect(() => {
    if (!access || (isDebug && !canControl)) return;
    let alive = true;
    setConnection('connecting');
    fetch(isDebug ? '/api/debug/state' : '/api/state').then(async response => {
      if (response.status === 401) { setSnapshot(INITIAL); setAccess({ required: true, authenticated: false }); }
      if (!response.ok) throw new Error('Unable to reach the server.');
      return response.json();
    }).then(value => { if (alive) { setSnapshot(value); setConnection('online'); } }).catch(() => { if (alive) setConnection('offline'); });
    const events = new EventSource('/api/events');
    events.onmessage = event => {
      if (!alive) return;
      try { setSnapshot(JSON.parse(event.data)); setConnection('online'); }
      catch { setError('An update could not be read. Refresh to reconnect.'); }
    };
    events.onopen = () => { if (alive) setConnection('online'); };
    events.onerror = () => { if (alive) setConnection('offline'); };
    return () => { alive = false; events.close(); };
  }, [isDebug, access?.authenticated, access?.required]);

  async function changeAccess(event?: React.FormEvent) {
    event?.preventDefault();
    setAuthPending(true); setError('');
    try {
      const response = await fetch(`/api/auth/${canControl ? 'logout' : 'login'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(canControl ? {} : { code: accessCode }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to update access.');
      setSnapshot(INITIAL); setConnection('connecting'); setAccessCode('');
      if (canControl) setAccess({ required: true, authenticated: false });
      const status = await fetch('/api/auth/status');
      if (!status.ok) throw new Error('Unable to check access. Refresh to try again.');
      setAccess(await status.json());
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to update access.'); }
    finally { setAuthPending(false); }
  }

  async function action(endpoint: string, body: unknown = {}) {
    setPending(endpoint); setError('');
    try {
      const response = await fetch(`/api/demo/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (response.status === 401) { setSnapshot(INITIAL); setAccess({ required: true, authenticated: false }); }
      if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
      if (result.setup) setSnapshot(result);
      else { const state = await fetch(isDebug ? '/api/debug/state' : '/api/state'); if (state.ok) setSnapshot(await state.json()); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to complete the request.'); }
    finally { setPending(''); }
  }
  function editEntryPoint(agentId: typeof AGENT_IDS[number], value: string) {
    const next = { ...entryPoints, [agentId]: value };
    setEntryPoints(next); setEntryPointsEdited(true);
    try { localStorage.setItem(ENTRY_POINTS_KEY, JSON.stringify(next)); } catch { /* Storage is optional. */ }
  }

  const online = connection === 'online';
  const running = snapshot.run?.status === 'running';
  const databaseReady = online && snapshot.setup.database.connected;
  const modelReady = online && modelDemoReady(snapshot.setup);
  const agents: Agent[] = AGENT_IDS.map(id => snapshot.agents.find(agent => agent.id === id) || { ...PERSONAS.find(persona => persona.id === id)!, status: 'waiting', heartbeatAt: 0 });
  const accessControls = access?.required && (canControl
    ? <button disabled={authPending} onClick={() => changeAccess()}>Lock controls</button>
    : <form className="access-form" onSubmit={changeAccess}>
      <label htmlFor="access-code">Access code</label>
      <input id="access-code" type="password" autoComplete="current-password" value={accessCode} onChange={event => setAccessCode(event.target.value)} required disabled={authPending} />
      <button type="submit" disabled={authPending || !accessCode.trim()}>{authPending ? 'Unlocking…' : 'Unlock controls'}</button>
    </form>);
  return <div className="manager">
    <main>
      {connection === 'offline' && <p className="notice">Connection interrupted. Showing the last received state; controls resume after reconnection.</p>}
      {error && <div className="notice error" role="alert">{error} <button onClick={() => setError('')}>Dismiss</button></div>}
      {isDebug ? <>
        <h1>Debugging</h1>
        {accessControls && <div className="access-controls">{accessControls}</div>}
        {!access ? <p role="status">Connecting…</p> : !canControl ? <p>Enter the access code to view diagnostics.</p> : <>
        <h2>Connections</h2>
        <table className="setup-table"><thead><tr><th>Service</th><th>Status</th></tr></thead><tbody>
          <tr><td>Server</td><td>{connection}</td></tr>
          <tr><td>Discovery model</td><td>{snapshot.setup.model.configured ? `Configured (${snapshot.setup.model.provider})` : 'Setup needed'}</td></tr>
          <tr><td>SpacetimeDB</td><td>{snapshot.setup.database.connected ? 'Connected' : 'Not connected'}<small>{snapshot.setup.database.host} {snapshot.setup.database.name}</small></td></tr>
          <tr><td>Call updates</td><td>{snapshot.setup.voice.webhookReady ? 'Configured' : 'Setup needed'}</td></tr>
          {agents.map(agent => <tr key={agent.id}><td>{agent.name}'s phone</td><td>{phonePresentation(agent).state === 'tested' ? 'Call tested' : isPhoneNumber(agent.phone) ? 'Configured; call test needed' : 'No phone configured'}</td></tr>)}
        </tbody></table>
        <h2>Run</h2>
        <p>Status: {snapshot.run ? statusText(snapshot.run.status) : 'not started'}. Mode: {snapshot.setup.mode === 'live' ? 'model discovery' : 'fixed-rule rehearsal'}.</p>
        <div className="controls">
          <button disabled={!databaseReady || running || !!pending} onClick={() => action('start', { mode: 'rehearsal', entryPoints })}>Run rehearsal</button>
          <button disabled={!databaseReady || !running || !!pending} onClick={() => action('stop')}>Stop</button>
          <button disabled={!databaseReady || running || !!pending} onClick={() => action('reset')}>Reset</button>
          {pending && <span role="status">Working…</span>}
        </div>
        <p className="secondary">Rehearsal uses fixed rules. It uses the entry points set in the agent manager.</p>
        <h2>Submissions</h2>
        {!snapshot.submissions.length ? <p>No submissions received.</p> : <div className="table-scroll"><table><thead><tr><th>Time</th><th>Agent</th><th>Site</th><th>Name</th><th>Phone</th></tr></thead><tbody>{snapshot.submissions.filter(row => AGENT_IDS.some(id => id === row.agentId)).map(row => <tr key={row.id}><td className="nowrap">{fmtTime(row.receivedAt)}</td><td>{agents.find(agent => agent.id === row.agentId)?.name || 'Agent'}</td><td>{snapshot.sites.find(site => site.id === row.siteId)?.url || row.siteId}</td><td>{row.name}</td><td>{row.phone}</td></tr>)}</tbody></table></div>}
        <h2>Activity</h2><Activity snapshot={snapshot} agents={agents} />
        <h2>Calls</h2>
        <p className="secondary">Source matches use the caller's post-call transcript. They do not establish identity or prove fraud.</p>
        {snapshot.calls.filter(call => AGENT_IDS.some(id => id === call.agentId)).length ? snapshot.calls.filter(call => AGENT_IDS.some(id => id === call.agentId)).map(call => <CallRecord key={call.id} call={call} snapshot={snapshot} />) : <p>No calls received.</p>}
        </>}
      </> : <>
        <h1>Agent manager</h1>
        <div className="table-scroll"><table className="agents-table">
          <thead><tr><th>Name</th><th>Phone</th><th>Entry point</th></tr></thead>
          <tbody>{agents.map(agent => <AgentRow key={agent.id} agent={agent} entryPoint={(running || !canControl) && snapshot.run?.entryPoints ? snapshot.run.entryPoints[agent.id] || '' : entryPoints[agent.id as keyof EntryPoints]} disabled={!canControl || running || !!pending} onEntryPointChange={value => editEntryPoint(agent.id as keyof EntryPoints, value)} />)}</tbody>
        </table></div>
        <div className="controls">
          <button disabled={!canControl || !modelReady || running || !!pending} onClick={() => action('start', { mode: 'live', entryPoints })}>Start</button>
          <button disabled={!canControl || !databaseReady || !running || !!pending} onClick={() => action('stop')}>Stop</button>
          <button disabled={!canControl || !databaseReady || running || !!pending} onClick={() => action('reset')}>Reset</button>
          {canControl && accessControls}
          {pending && <span role="status">Working…</span>}
        </div>
        {!canControl && accessControls}
        {!modelReady && online && <p className="secondary">Start requires a connected database and discovery model.</p>}
        {connection === 'connecting' && <p role="status">Connecting…</p>}
        {snapshot.setup.mode === 'rehearsal' && snapshot.run && <p className="secondary">This run uses fixed-rule rehearsal.</p>}
        <h2>Sites</h2>
        <Sites snapshot={snapshot} />
      </>}
    </main>
  </div>;
}

function AgentRow({ agent, entryPoint, disabled, onEntryPointChange }: { agent: Agent; entryPoint: string; disabled: boolean; onEntryPointChange: (value: string) => void }) {
  // Public snapshots retain tested readiness but omit the provider's private agent ID.
  const phoneHref = isPhoneNumber(agent.phone) && agent.voiceReady ? `tel:${agent.phone}` : null;
  return <tr>
    <th scope="row">{agent.name}</th>
    <td className="phone-cell">{phoneHref ? <a href={phoneHref}>{agent.phone}</a> : <span>{isPhoneNumber(agent.phone) ? agent.phone : 'Not configured'}</span>}</td>
    <td className="entry-point-cell"><label className="entry-point-label" htmlFor={`${agent.id}-entry-point`}>Entry point</label><input id={`${agent.id}-entry-point`} aria-label={`${agent.name} entry point`} type="text" value={entryPoint} onChange={event => onEntryPointChange(event.target.value)} disabled={disabled} spellCheck={false} /></td>
  </tr>;
}

function Sites({ snapshot }: { snapshot: AppSnapshot }) {
  return <div className="table-scroll"><table className="sites-table">
    <thead><tr><th>Site</th><th>Form instructions</th></tr></thead>
    <tbody>{snapshot.sites.map(site => <tr key={site.id}>
      <td><a href={site.url} target="_blank" rel="noreferrer">{site.url}</a></td>
      <td><SiteInstructions site={site} /></td>
    </tr>)}</tbody>
  </table></div>;
}

function SiteInstructions({ site }: { site: Site }) {
  const hasSource = Boolean(site.sourceUrl || site.sourceLabel);
  const readOnly = site.submissionAllowed === false || hasSource;
  const recipe = readOnly ? null : site.recipe;
  if (recipe) return <ol className="field-list">{recipe.fields.map(field => <li key={field.label}>Fill {field.label} with the agent's {field.valueFrom === 'name' ? 'name' : 'phone number'}.</li>)}<li>Press {recipe.submitLabel}.</li><li>Confirm: {recipe.successText}.</li></ol>;

  const detail = site.inspectionMessage?.trim().replace(/[.!?]+$/, '');
  const inspection = site.inspectionStatus === 'pending' ? 'Inspection pending.'
    : site.inspectionStatus === 'inspecting' ? 'Inspecting page.'
    : site.inspectionStatus === 'unavailable' ? `Could not inspect${detail ? `: ${detail}` : ''}. No form instructions available.`
    : site.inspectionStatus === 'analysis_failed' ? `Analysis failed${detail ? `: ${detail}` : ''}. No form instructions available.`
    : site.inspectionStatus === 'not_flagged' ? 'Page was not flagged on inspection.'
    : site.inspectionStatus === 'inspected' ? 'Page inspected.' : '';
  const sourceUrl = safeHttpUrl(site.sourceUrl);
  const sourceLabel = site.sourceLabel || (sourceUrl ? new URL(sourceUrl).hostname : 'Feed');
  const hasFields = Boolean(site.observedFields?.length);
  const hasObservation = hasFields || Boolean(site.observedButtons?.length || site.observedFormAction);
  const noInstructions = !hasObservation && !['pending', 'inspecting', 'unavailable', 'analysis_failed'].includes(site.inspectionStatus || '');
  return <div className="site-instructions">
    <p>{hasSource && <>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">{sourceLabel}</a> : sourceLabel} listing. </>}{inspection && <>{inspection} </>}{readOnly && <>Read only. </>}{noInstructions && 'No form instructions available.'}</p>
    {hasFields && <><p>Observed fields:</p><ul className="field-list">{site.observedFields!.map((field, index) => <li key={index}>{field}</li>)}</ul></>}
    {site.observedButtons?.length ? <p>Observed buttons: {site.observedButtons.join(', ')}.</p> : null}
    {site.observedFormAction && <p>Observed form action: {site.observedFormAction}</p>}
  </div>;
}

function safeHttpUrl(value?: string): string | null {
  try {
    const url = new URL(value || '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function Activity({ snapshot, agents }: { snapshot: AppSnapshot; agents: Agent[] }) {
  const events = snapshot.events.filter(event => !event.agentId || event.agentId === 'system' || AGENT_IDS.some(id => id === event.agentId)).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
  if (!events.length) return <p>No activity yet. Start a run to see updates.</p>;
  return <div className="table-scroll"><table>
    <thead><tr><th>Time</th><th>Agent</th><th>Event</th></tr></thead>
    <tbody>{events.map(event => <tr key={event.id}><td className="nowrap">{fmtTime(event.timestamp)}</td><td>{agents.find(agent => agent.id === event.agentId)?.name || 'System'}</td><td>{event.kind === 'form_accepted' ? 'Details accepted by the demo form.' : event.message}</td></tr>)}</tbody>
  </table></div>;
}

function CallRecord({ call, snapshot }: { call: Call; snapshot: AppSnapshot }) {
  const agent = snapshot.agents.find(item => item.id === call.agentId);
  const source = snapshot.sites.find(item => item.id === call.matchedSiteId && item.runId === call.runId);
  return <section className="record">
    <h3>{agent?.name || call.agentId}: {statusText(call.status)}</h3>
    <p>{fmtTime(call.startedAt)}. Duration: {duration(call.durationSeconds)}. {call.matchStatus !== 'none' ? 'Possible association based on submitted details.' : 'No source match.'}</p>
    {call.summary && <p>{call.summary}</p>}
    {source && call.matchStatus !== 'none' && <p>Possible source: <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></p>}
    {call.evidence && <p>{call.evidence}</p>}
    {call.transcript.length ? <details><summary>Read post-call transcript</summary><div className="transcript">{call.transcript.map((line, index) => <p key={index}><strong>{line.role === 'agent' ? agent?.name || 'Agent' : line.role === 'user' ? 'Caller' : line.role}:</strong> {line.message}</p>)}</div></details> : <p className="secondary">Transcript pending the provider's post-call update.</p>}
  </section>;
}

function DemoNotice({ phishing = false }: { phishing?: boolean }) {
  return <div className="demo-notice" data-demo-banner="true" data-ignore-analysis="true" role="note"><strong>{phishing ? 'Demo phishing site.' : 'Demo website.'}</strong> Fictional content. Use synthetic details only. No real offer or payment.</div>;
}

function Forum({ initialConfig }: { initialConfig?: PublicConfig }) {
  const [claimUrl, setClaimUrl] = useState(initialConfig ? new URL('/phishing',initialConfig.demoOrigin).href : '/phishing');
  useEffect(() => {
    let alive = true;
    document.title = 'Community forum';
    (initialConfig ? Promise.resolve(initialConfig) : readPublicConfig()).then(config => {
      if (alive && config?.authRequired && config.demoOrigin) setClaimUrl(new URL('/phishing', config.demoOrigin).href);
    }).catch(() => { /* The owned /phishing route remains available if configuration cannot load. */ });
    return () => { alive = false; };
  }, [initialConfig]);
  return <div className="forum-page"><DemoNotice />
    <main className="forum-content" data-crawl-content><h1>Community forum</h1><p>General discussion and local notices</p>
      <table><thead><tr><th>Topic</th><th>Posted by</th><th>Date</th></tr></thead><tbody>
        <tr><td><a href="/demo/benign-event">Saturday seed swap at the community garden</a><p>Bring spare seeds. No registration required.</p></td><td>Garden club</td><td>Today</td></tr>
        <tr><td><a href={claimUrl}>Your household has been selected for a $750 utility credit</a><p>A limited number of unclaimed household credits are available. Confirm your full name and phone number to arrange a callback and release yours today.</p></td><td>Account services</td><td>Today</td></tr>
        <tr><td><a href="/demo/benign-news">Library reading room opens this weekend</a><p>New seating and a local-author shelf.</p></td><td>Community editor</td><td>Yesterday</td></tr>
      </tbody></table>
    </main>
  </div>;
}

function FixturePage({ path }: { path: string }) {
  const [name, setName] = useState(''); const [phone, setPhone] = useState('');
  const [submitted, setSubmitted] = useState(false); const [receiptId, setReceiptId] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { document.title = 'Demo website'; }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const query = new URLSearchParams(window.location.search);
    try {
      const response = await fetch('/api/mock/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: query.get('runId') || query.get('run') || '', siteId: query.get('siteId') || query.get('site') || '', agentId: query.get('agentId') || query.get('agent') || '', name, phone }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The request could not be received.');
      setReceiptId(result.receiptId || result.id || result.submission?.id || ''); setSubmitted(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to submit.'); }
    finally { setBusy(false); }
  }
  if (path !== '/phishing' && path !== '/demo/claim') return <div className="plain-article"><DemoNotice /><main data-crawl-content>
    <p><a href="/forum">Back to community forum</a></p>
    <h1>{path.includes('event') ? 'Saturday seed swap' : 'Library reading room opens this weekend'}</h1>
    {path.includes('event') ? <><p>Bring labeled envelopes of spare seeds to the community garden on Saturday, 10 a.m. to noon.</p><p>Entry is free. No registration, phone number, or personal details are needed.</p></> : <><p>The neighborhood library's reading room opens this weekend with new seating and a local-author shelf.</p><p>Everyone is welcome during regular library hours. No registration or contact information is required.</p></>}
  </main></div>;
  return <div className="bank-page"><DemoNotice phishing />
    <div className="bank-site">
      <header className="bank-header"><strong>Example Savings Bank</strong><span>Fictional bank</span></header>
      <div className="bank-location">Personal banking &gt; Account services &gt; Unclaimed credit</div>
      <div className="bank-body">
        <aside className="bank-navigation"><strong>Account services</strong><a href="#credit-information">Unclaimed credit</a><a href="#callback-form">Request a callback</a><a href="/forum">Community forum</a></aside>
        <main className="bank-content" data-crawl-content>
          <h1 id="credit-information">Unclaimed utility credit</h1>
          <p><strong>Your household could receive $750.</strong></p>
          <p>You have been selected for an unclaimed utility credit. Our account services desk can help release your funds.</p>
          <p><strong>Act today. Unclaimed credits are reassigned after 24 hours.</strong></p>
          <p>Confirm your full name and phone number to request a callback. A representative will explain how to release your credit.</p>
          <p className="bank-small">A processing payment may be requested by the representative before the credit can be released.</p>
          <section id="callback-form" className="bank-form">
            {submitted ? <div role="status" data-receipt-id={receiptId}><h2>Your request has been received</h2><p>Account services has received your callback details.</p></div> : <>
              <h2>Callback request</h2><p>Enter your name and phone number below.</p>
              <form onSubmit={submit}>
                <label htmlFor="full-name">Full name</label><input id="full-name" name="name" autoComplete="off" value={name} onChange={event => setName(event.target.value)} required />
                <label htmlFor="phone">Phone number</label><input id="phone" name="phone" type="tel" autoComplete="off" value={phone} onChange={event => setPhone(event.target.value)} required />
                {error && <p className="error" role="alert">{error}</p>}
                <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Request callback'}</button>
              </form>
            </>}
          </section>
        </main>
      </div>
      <footer className="bank-footer">Example Savings Bank — fictional demonstration website</footer>
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
