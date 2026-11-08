import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EMPTY_STATE, PERSONAS, type AppSnapshot, type Agent, type Call } from '../shared/contracts';
import { isPhoneNumber, modelDemoReady, phonePresentation } from '../shared/readiness';
import { useSpacetime, type SimSnapshot } from './spacetime';
import './style.css';

const INITIAL: AppSnapshot = { ...EMPTY_STATE, setup: {
  database: { connected: false, host: '', name: '' }, model: { configured: false, provider: '' },
  voice: { configured: 0, total: 3, webhookReady: false }, publicUrl: '', mode: 'rehearsal',
} };
const fmtTime = (time: number) => time ? new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const duration = (seconds: number) => `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60).toString().padStart(2, '0')}s`;
const statusText = (status: string) => status.replaceAll('_', ' ').replaceAll('-', ' ');

function Navigation({ path }: { path: string }) {
  return <nav className="navigation" aria-label="Main navigation">
    {[
      ['/', 'Dashboard'], ['/evidence', 'Evidence'], ['/forum', 'Forum'],
      ['/admin', 'Collected numbers'], ['/setup', 'Setup'],
    ].map(([href, label]) => <a key={href} href={href} aria-current={path === href ? 'page' : undefined}>{label}</a>)}
  </nav>;
}

function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(INITIAL);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [now, setNow] = useState(Date.now());
  const [seed, setSeed] = useState(42);
  const [simPending, setSimPending] = useState(false);
  const [simError, setSimError] = useState('');
  const path = window.location.pathname;
  const sim = useSpacetime(snapshot.setup.database.host, snapshot.setup.database.name);
  useEffect(() => {
    let alive = true;
    document.title = path === '/admin' ? 'Collected numbers' : path === '/forum' ? 'Community forum' : path.startsWith('/demo/') ? 'Demo website' : 'Agent manager';
    fetch('/api/state').then(async response => {
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
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; events.close(); window.clearInterval(timer); };
  }, [path]);

  async function action(endpoint: string, body: unknown = {}) {
    setPending(endpoint); setError('');
    try {
      const response = await fetch(`/api/demo/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
      if (result.setup) setSnapshot(result);
      else { const state = await fetch('/api/state'); if (state.ok) setSnapshot(await state.json()); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to complete the request.'); }
    finally { setPending(''); }
  }

  async function simControl(endpoint: 'start' | 'stop', body: unknown = {}) {
    setSimPending(true); setSimError('');
    try {
      const response = await fetch(`/api/sim/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
    } catch (cause) { setSimError(cause instanceof Error ? cause.message : 'Unable to complete the request.'); }
    finally { setSimPending(false); }
  }

  // Deliberately no chrome or empty-state text on the collector's number list.
  // Prefer the collector_numbers view over the direct connection; fall back to the SSE snapshot filter.
  if (path === '/admin') {
    const numbers = sim.connected ? sim.collectorNumbers : snapshot.submissions.map(row => row.phone).filter(isPhoneNumber);
    return <pre className="numbers-only">{numbers.join('\n')}</pre>;
  }
  if (path.startsWith('/demo/')) return <FixturePage path={path} snapshot={snapshot} />;
  if (path === '/forum') return <Forum />;
  const online = connection === 'online';
  const running = snapshot.run?.status === 'running';
  const databaseReady = online && snapshot.setup.database.connected;
  const modelReady = online && modelDemoReady(snapshot.setup);
  const agents: Agent[] = snapshot.agents.length ? snapshot.agents : PERSONAS.map(persona => ({ ...persona, status: 'waiting', heartbeatAt: 0 }));
  return <div className="manager">
    <Navigation path={path} />
    <main>
      <div className="connection-status" role="status">Server: {connection}. Database: {snapshot.setup.database.connected ? 'connected' : 'not connected'}.</div>
      {connection === 'offline' && <p className="notice">Connection interrupted. Showing the last received state; controls resume after reconnection.</p>}
      {error && <div className="notice error" role="alert">{error} <button onClick={() => setError('')}>Dismiss</button></div>}
      {path === '/evidence' ? <Evidence snapshot={snapshot} /> : <>
        <h1>Agent manager</h1>
        <div className="controls">
          <button disabled={!modelReady || running || !!pending} onClick={() => action('start', { mode: 'live' })}>Start model demo</button>
          <button disabled={!databaseReady || running || !!pending} onClick={() => action('start', { mode: 'rehearsal' })}>Run rehearsal</button>
          <button disabled={!databaseReady || !running || !!pending} onClick={() => action('stop')}>Stop run</button>
          <button disabled={!databaseReady || running || !!pending} onClick={() => action('reset')}>Reset</button>
          {pending && <span role="status">Working…</span>}
        </div>
        <p>Run: <strong>{snapshot.run ? statusText(snapshot.run.status) : 'not started'}</strong>. Mode: {snapshot.setup.mode === 'live' ? 'model discovery' : 'fixed-rule rehearsal'}.</p>
        <p className="secondary">Model discovery requires a connected model and database. Phone testing is separate.</p>
        <p className="summary-line">Sites: {snapshot.sites.length} | Submissions: {snapshot.submissions.length} | Calls: {snapshot.calls.length} | Call duration: {duration(snapshot.calls.reduce((sum, call) => sum + call.durationSeconds, 0))} | Phone lines tested: {snapshot.setup.voice.configured}/{snapshot.setup.voice.total}</p>
        <Simulation sim={sim} seed={seed} setSeed={setSeed} databaseReady={databaseReady} pending={simPending} error={simError} onStart={() => simControl('start', { seed, personaCount: 120, siteCount: 24, ringCount: 6 })} onStop={() => simControl('stop')} />
        <h2>Agents</h2>
        <div className="table-scroll"><table className="agents-table">
          <thead><tr><th>Worker</th><th>Character</th><th>Phone</th><th>Reference</th><th>Status</th></tr></thead>
          <tbody>{agents.map(agent => <AgentRow key={agent.id} agent={agent} snapshot={snapshot} now={now} />)}</tbody>
        </table></div>
        <p className="secondary">Only tested phone numbers have call links. Browser-only agents still submit their demo details.</p>
        <h2>Connections</h2>
        <table className="setup-table"><thead><tr><th>Service</th><th>Status</th></tr></thead><tbody>
          <tr><td>Discovery model</td><td>{snapshot.setup.model.configured ? `Configured (${snapshot.setup.model.provider})` : 'Setup needed'}</td></tr>
          <tr><td>SpacetimeDB</td><td>{snapshot.setup.database.connected ? 'Connected' : 'Not connected'}</td></tr>
          <tr><td>Browser subscription</td><td>{sim.connected ? 'Connected (direct)' : 'Not connected'}</td></tr>
          <tr><td>Call updates</td><td>{snapshot.setup.voice.webhookReady ? 'Configured' : 'Setup needed'}</td></tr>
        </tbody></table>
        <p><a href="/setup">Manage connections and credentials</a></p>
        <h2>Activity</h2><Activity snapshot={snapshot} />
      </>}
    </main>
  </div>;
}

function AgentRow({ agent, snapshot, now }: { agent: Agent; snapshot: AppSnapshot; now: number }) {
  const phone = phonePresentation(agent);
  const job = snapshot.jobs.find(item => item.agentId === agent.id && item.runId === snapshot.run?.id && ['pending', 'scheduled', 'queued', 'waiting'].includes(item.status));
  const receipt = snapshot.submissions.find(item => item.agentId === agent.id && item.runId === snapshot.run?.id);
  const call = snapshot.calls.find(item => item.agentId === agent.id && ['ringing', 'active', 'in_progress', 'in-progress', 'connected'].includes(item.status));
  const seconds = job ? Math.max(0, Math.ceil((job.dueAt - now) / 1000)) : 0;
  const status = call ? 'In conversation' : receipt ? 'Submission received' : job ? seconds > 0 ? `Submitting in ${seconds}s` : 'Ready to submit' : statusText(agent.status || 'waiting');
  return <tr>
    <td>{agent.id}<small>{agent.id === 'scout' ? 'Scout' : 'Follower'}</small><small>{agent.heartbeatAt && now - agent.heartbeatAt < 20_000 ? 'Connected' : 'Not active'}</small></td>
    <td>{agent.name}<small>{agent.character}</small></td>
    <td className="phone-cell">{phone.href ? <a href={phone.href}>{agent.phone}</a> : <span>{agent.phone || `DEMO-${agent.id.toUpperCase()}`}</span>}<small>{phone.state === 'tested' ? 'Tested; call this number' : phone.state === 'browser-only' ? 'Browser only; no phone line' : 'Call test needed'}</small></td>
    <td>{agent.marker}</td><td>{status}</td>
  </tr>;
}

function Activity({ snapshot }: { snapshot: AppSnapshot }) {
  const events = [...snapshot.events].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
  if (!events.length) return <p>No activity yet. Start a run to see updates.</p>;
  return <div className="table-scroll"><table>
    <thead><tr><th>Time</th><th>Worker</th><th>Event</th></tr></thead>
    <tbody>{events.map(event => <tr key={event.id}><td className="nowrap">{fmtTime(event.timestamp)}</td><td>{event.agentId || 'system'}</td><td>{event.kind === 'form_accepted' ? 'Profile accepted by the demo form.' : event.message}</td></tr>)}</tbody>
  </table></div>;
}

function Simulation({ sim, seed, setSeed, databaseReady, pending, error, onStart, onStop }: {
  sim: SimSnapshot; seed: number; setSeed: (value: number) => void; databaseReady: boolean;
  pending: boolean; error: string; onStart: () => void; onStop: () => void;
}) {
  const stats = sim.stats;
  const hours = Math.floor(stats ? stats.secondsBurned / 3600 : 0);
  const minutes = Math.floor(((stats ? stats.secondsBurned : 0) % 3600) / 60);
  const sourceLabel = (source: string) => source === 'live' ? 'Live' : 'Simulated';
  const personaName = new Map(sim.personas.map(persona => [persona.key, persona.name]));
  const siteLabel = new Map(sim.sites.map(site => [site.key, site.label]));
  const plantsBySite = (key: string) => sim.plants.filter(plant => plant.siteId === key).length;
  const listsBought = (key: string) => sim.ringPurchases.filter(purchase => purchase.ringId === key).length;
  const sites = [...sim.sites].sort((a, b) => b.tracedCalls - a.tracedCalls || (a.source === 'live' ? 0 : 1) - (b.source === 'live' ? 0 : 1)).slice(0, 15);
  const running = Boolean(stats?.running);
  return <section className="simulation">
    <h2>Simulation</h2>
    <p>Simulated rows are generated inside the database by a scheduled reducer and are labeled simulated. Live rows come from actual calls.</p>
    <div className="connection-status" role="status">
      {sim.connected ? `Browser connection to SpacetimeDB: connected as ${sim.identityShort}` : 'Browser connection to SpacetimeDB: not connected'}
      {' | '}Simulation: {running ? 'running' : 'stopped'}
      {' | '}Tick: {stats ? stats.tick : 0}
      {' | '}Simulated calls: {stats ? stats.simulatedCalls : 0}
      {' | '}Live calls: {stats ? stats.liveCalls : 0}
      {' | '}Caller time simulated: {hours}h {minutes}m
    </div>
    <div className="controls">
      <label htmlFor="sim-seed">Seed</label>
      <input id="sim-seed" type="number" min={0} value={seed} onChange={event => setSeed(Math.max(0, Math.floor(Number(event.target.value) || 0)))} />
      <button disabled={!databaseReady || running || pending} onClick={onStart}>Start simulation</button>
      <button disabled={!databaseReady || !running || pending} onClick={onStop}>Stop simulation</button>
      {pending && <span role="status">Working…</span>}
    </div>
    {error && <div className="notice error" role="alert">{error}</div>}
    <h3>Sites by traced leaks</h3>
    {!sites.length ? <p>No sites yet. Start the simulation to generate activity.</p> : <div className="table-scroll"><table>
      <thead><tr><th>Label</th><th>Source</th><th>Plants</th><th>Leaks</th><th>Traced calls</th></tr></thead>
      <tbody>{sites.map(site => <tr key={site.key}><td>{site.label}</td><td>{sourceLabel(site.source)}</td><td>{plantsBySite(site.key)}</td><td>{site.leaks}</td><td>{site.tracedCalls}</td></tr>)}</tbody>
    </table></div>}
    <h3>Scam operations (simulated)</h3>
    {!sim.rings.length ? <p>No operations yet.</p> : <div className="table-scroll"><table>
      <thead><tr><th>Label</th><th>Pretext</th><th>Calls</th><th>Lists purchased</th></tr></thead>
      <tbody>{sim.rings.map(ring => <tr key={ring.key}><td>{ring.label}</td><td>{ring.pretext}</td><td>{ring.calls}</td><td>{listsBought(ring.key)}</td></tr>)}</tbody>
    </table></div>}
    <h3>Recent calls</h3>
    {!sim.leakCalls.length ? <p>No calls yet.</p> : <div className="table-scroll"><table>
      <thead><tr><th>Time</th><th>Source</th><th>Persona</th><th>Spoken reference</th><th>Attributed site</th><th>Outcome</th><th>Duration</th></tr></thead>
      <tbody>{sim.leakCalls.map(call => <tr key={call.id}>
        <td className="nowrap">{fmtTime(call.at)}</td><td>{sourceLabel(call.source)}</td>
        <td>{personaName.get(call.personaId) || call.personaId}</td><td>{call.spokenMarker}</td>
        <td>{siteLabel.get(call.siteId) || call.siteId}</td><td>{statusText(call.outcome)}</td><td className="nowrap">{duration(call.durationSeconds)}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}

function Evidence({ snapshot }: { snapshot: AppSnapshot }) {
  return <>
    <h1>Evidence</h1><h2>Discovered sites</h2>
    {!snapshot.sites.length ? <p>No sites discovered.</p> : snapshot.sites.map(site => <section className="record" key={site.id}>
      <h3><a href={site.url} target="_blank" rel="noreferrer">{site.title}</a></h3><p className="url">{site.url}</p>
      <p>Analysis: {site.analysisMode === 'fixture' ? 'fixed-rule rehearsal' : 'model'}. Confidence: {site.confidence}. Status: {statusText(site.status)}.</p>
      <ul>{site.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul>
      <details><summary>Submission instructions</summary><table><thead><tr><th>Field</th><th>Profile value</th></tr></thead><tbody>{site.recipe.fields.map(field => <tr key={field.label}><td>{field.label}</td><td>{field.valueFrom}</td></tr>)}</tbody></table><p>Submit button: {site.recipe.submitLabel}</p><p>Success message: {site.recipe.successText}</p></details>
    </section>)}
    <h2>Submission receipts</h2>
    {!snapshot.submissions.length ? <p>No submissions received.</p> : <div className="table-scroll"><table><thead><tr><th>Time</th><th>Worker</th><th>Name</th><th>Phone</th><th>Reference</th></tr></thead><tbody>{snapshot.submissions.map(row => <tr key={row.id}><td className="nowrap">{fmtTime(row.receivedAt)}</td><td>{row.agentId}</td><td>{row.name}</td><td>{row.phone}</td><td>{row.marker}</td></tr>)}</tbody></table></div>}
    <h2>Calls</h2><p className="secondary">A verified reference match links a caller to the submitted details; it does not establish their identity or prove fraud.</p>
    {!snapshot.calls.length ? <p>No calls received. Completed transcripts appear after the provider sends an update.</p> : snapshot.calls.map(call => <CallRecord key={call.id} call={call} snapshot={snapshot} />)}
  </>;
}

function CallRecord({ call, snapshot }: { call: Call; snapshot: AppSnapshot }) {
  const agent = snapshot.agents.find(item => item.id === call.agentId);
  const source = snapshot.sites.find(item => item.id === call.matchedSiteId && item.runId === call.runId);
  return <section className="record">
    <h3>{agent?.name || call.agentId}: {statusText(call.status)}</h3>
    <p>{fmtTime(call.startedAt)}. Duration: {duration(call.durationSeconds)}. {call.matchStatus === 'verified' ? 'Reference matched.' : call.matchStatus === 'possible' ? 'Possible connection; not yet verified.' : 'No source match.'}</p>
    {call.summary && <p>{call.summary}</p>}
    {source && call.matchStatus !== 'none' && <p>{call.matchStatus === 'verified' ? 'Matched source' : 'Possible source'}: <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></p>}
    {call.evidence && <p>{call.evidence}</p>}
    {call.transcript.length ? <details><summary>Read post-call transcript</summary><div className="transcript">{call.transcript.map((line, index) => <p key={index}><strong>{line.role === 'agent' ? agent?.name || 'Agent' : line.role === 'user' ? 'Caller' : line.role}:</strong> {line.message}</p>)}</div></details> : <p className="secondary">Transcript pending the provider's post-call update.</p>}
  </section>;
}

function DemoNotice({ phishing = false }: { phishing?: boolean }) {
  return <div className="demo-notice" data-demo-banner="true" data-ignore-analysis="true" role="note"><strong>{phishing ? 'Demo phishing site.' : 'Demo website.'}</strong> Fictional content. Use synthetic details only. No real offer or payment.</div>;
}

function Forum() {
  return <div className="forum-page"><Navigation path="/forum" /><DemoNotice />
    <main className="forum-content" data-crawl-content><h1>Community forum</h1><p>General discussion and local notices</p>
      <table><thead><tr><th>Topic</th><th>Posted by</th><th>Date</th></tr></thead><tbody>
        <tr><td><a href="/demo/benign-event">Saturday seed swap at the community garden</a><p>Bring spare seeds. No registration required.</p></td><td>Garden club</td><td>Today</td></tr>
        <tr><td><a href="/demo/claim">Your household has been selected for a $750 utility credit</a><p>A limited number of unclaimed household credits are available. Confirm your full name and phone number to arrange a callback and release yours today.</p></td><td>Account services</td><td>Today</td></tr>
        <tr><td><a href="/demo/benign-news">Library reading room opens this weekend</a><p>New seating and a local-author shelf.</p></td><td>Community editor</td><td>Yesterday</td></tr>
      </tbody></table>
    </main>
  </div>;
}

function FixturePage({ path, snapshot }: { path: string; snapshot: AppSnapshot }) {
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [marker, setMarker] = useState('');
  const [submitted, setSubmitted] = useState(false); const [receiptId, setReceiptId] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const query = new URLSearchParams(window.location.search);
    try {
      const response = await fetch('/api/mock/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: query.get('runId') || query.get('run') || snapshot.run?.id || '', siteId: query.get('siteId') || query.get('site') || '', agentId: query.get('agentId') || query.get('agent') || '', name, phone, marker }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The request could not be received.');
      setReceiptId(result.receiptId || result.id || result.submission?.id || ''); setSubmitted(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to submit.'); }
    finally { setBusy(false); }
  }
  if (path !== '/demo/claim') return <div className="plain-article"><DemoNotice /><main data-crawl-content>
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
              <h2>Callback request</h2><p>Complete all three fields below.</p>
              <form onSubmit={submit}>
                <label htmlFor="full-name">Full name</label><input id="full-name" name="name" autoComplete="off" value={name} onChange={event => setName(event.target.value)} required />
                <label htmlFor="phone">Phone number</label><input id="phone" name="phone" type="tel" autoComplete="off" value={phone} onChange={event => setPhone(event.target.value)} required />
                <label htmlFor="reference">Reference</label><input id="reference" name="marker" autoComplete="off" value={marker} onChange={event => setMarker(event.target.value)} required />
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
