import { useEffect, useRef, useState } from 'react';
import { GROUP_LABEL, GROUP_ORDER, type CheckpointAnswer, type Phase, type PublicRunState, type TestCase } from '../../../server/types';
import { api } from '../api';
import { navigate } from '../nav';
import { CheckpointCard } from '../components/Checkpoints';
import { Bell, Check, Chevron, Download, Info, Lock } from '../components/Icons';

const PHASES: { id: Phase; label: string }[] = [
  { id: 'learn', label: 'Learn your product' },
  { id: 'plan', label: 'Plan the tests' },
  { id: 'test', label: 'Test' },
  { id: 'report', label: 'Report' },
];

function useRunStream(id: string) {
  const [state, setState] = useState<PublicRunState | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let closed = false;
    api.getRun(id).then((s) => { if (!closed) { if (s) setState(s); else setMissing(true); } });
    const es = new EventSource(`/api/runs/${id}/events`);
    es.addEventListener('state', (e) => setState(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('frame', (e) => setFrame((e as MessageEvent).data));
    return () => { closed = true; es.close(); };
  }, [id]);
  return { state, frame, missing };
}

/** Sound + system notification + tab title when the agent needs the user. */
function useYourTurnAlerts(state: PublicRunState | null) {
  const lastCp = useRef<string | null>(null);
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!state) return;
    const cp = state.checkpoint?.id ?? null;
    const alert = (title: string, body: string) => {
      try {
        const ctx = new AudioContext();
        [660, 880].forEach((f, i) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
          g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + i * 0.18 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
          o.connect(g).connect(ctx.destination);
          o.start(ctx.currentTime + i * 0.18);
          o.stop(ctx.currentTime + i * 0.18 + 0.17);
        });
      } catch { /* sound is optional */ }
      try {
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body });
      } catch { /* ignore */ }
    };
    if (cp && cp !== lastCp.current) alert('QA Agent needs you', state.checkpoint!.title);
    if (state.status === 'done' && lastStatus.current && lastStatus.current !== 'done') alert('Your test report is ready', `Verdict: ${state.verdict}`);
    lastCp.current = cp;
    lastStatus.current = state.status;
    document.title = cp ? '(Your turn) QA Agent' : state.status === 'done' ? 'Report ready · QA Agent' : 'Testing… · QA Agent';
  }, [state]);
  useEffect(() => () => { document.title = 'QA Agent — Find the bugs before your users do'; }, []);
}

/** Re-renders every second so waiting times count up live. */
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function statusOf(c: TestCase) {
  switch (c.status) {
    case 'pass': return { cls: 'pass', label: '✓ Pass' };
    case 'fail': return { cls: 'fail', label: '✕ Fail' };
    case 'blocked': return { cls: 'blocked', label: '! Blocked' };
    case 'running': return { cls: 'running', label: 'Running' };
    case 'skipped': return { cls: 'skipped', label: 'Skipped' };
    default: return { cls: 'waiting', label: 'Waiting' };
  }
}

export function RunView({ id }: { id: string }) {
  const { state, frame, missing } = useRunStream(id);
  const [open, setOpen] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [notify, setNotify] = useState(() => 'Notification' in window && Notification.permission === 'granted');
  useYourTurnAlerts(state);
  const now = useNow(!!state && ['running', 'queued'].includes(state.status));
  // Server and browser clocks can differ, so measure the wait with the browser's own clock.
  const waitSeen = useRef<{ key: number | null; at: number }>({ key: null, at: 0 });
  if (state && state.aiWaitingSince !== waitSeen.current.key) waitSeen.current = { key: state.aiWaitingSince, at: Date.now() };

  if (missing) {
    return (
      <main className="page"><div className="card"><h2>This test was not found</h2><p className="muted">Tests are kept for a few hours after they finish.</p>
        <button className="btn primary" onClick={() => navigate('/')}>Start a new test</button></div></main>
    );
  }
  if (!state) return <main className="page"><div className="row muted"><span className="spinner" /> Loading…</div></main>;

  const host = (() => { try { return new URL(state.url).host; } catch { return state.url; } })();
  const phaseIdx = PHASES.findIndex((p) => p.id === state.phase);
  const finished = ['done', 'failed', 'stopped'].includes(state.status);
  const cases = GROUP_ORDER.flatMap((g) => state.cases.filter((c) => c.group === g));
  const counted = cases.filter((c) => c.status !== 'skipped');
  const doneCases = counted.filter((c) => ['pass', 'fail', 'blocked'].includes(c.status));
  const pass = cases.filter((c) => c.status === 'pass').length;
  const fail = cases.filter((c) => c.status === 'fail').length;
  const showResults = phaseIdx >= 2 && cases.length > 0;
  const send = async (a: CheckpointAnswer) => { await api.answer(id, state.checkpoint!.id, a).catch(() => {}); };
  const aiWait = state.status === 'running' && state.aiWaitingSince ? Math.max(0, now - waitSeen.current.at) : null;
  const liveState = state.status === 'waiting' ? 'paused' : finished || state.status === 'queued' ? 'off' : 'live';

  return (
    <main className="page wide">
      <div className="row" style={{ gap: '12px 20px' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }} className="grow">
          <h1 style={{ fontWeight: 800, fontSize: 28 }}>Testing {host}</h1>
          <span className="muted small">{state.depth[0].toUpperCase() + state.depth.slice(1)} test · {state.model}</span>
        </div>
        {'Notification' in window && !finished && (
          <button type="button" className="btn ghost small" aria-pressed={notify}
            onClick={async () => { if (Notification.permission !== 'granted') setNotify((await Notification.requestPermission()) === 'granted'); }}>
            <Bell /> {notify ? 'Notifications on' : 'Notify me when it needs me'}
          </button>
        )}
        {!finished && (confirmStop ? (
          <span className="row" style={{ gap: 6 }}>
            <button type="button" className="btn small" style={{ background: 'var(--fail-bg)', color: 'var(--fail)' }} onClick={() => { void api.stop(id); setConfirmStop(false); }}>Yes, stop it</button>
            <button type="button" className="btn ghost small" onClick={() => setConfirmStop(false)}>Keep going</button>
          </span>
        ) : (
          <button type="button" className="btn ghost small" onClick={() => setConfirmStop(true)}>Stop test</button>
        ))}
      </div>

      <ol className="stepper" aria-label="Progress">
        {PHASES.map((p, i) => {
          const done = i < phaseIdx || state.status === 'done';
          const cls = done ? 'done' : i === phaseIdx ? 'active' : 'todo';
          return (
            <li key={p.id} className={cls} aria-current={cls === 'active' ? 'step' : undefined}>
              <span className={`dot ${done ? 'done' : ''}`}>{done ? <Check size={15} /> : i + 1}</span>{p.label}
            </li>
          );
        })}
      </ol>

      <div className="split">
        <section className="main">
          {state.status === 'queued' && (
            <div className="card row"><span className="spinner" /> <span>Waiting for a free test slot{state.queuePosition ? ` (you're number ${state.queuePosition} in line)` : ''}…</span></div>
          )}
          {state.status === 'failed' && (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h2 style={{ fontSize: 22 }}>The test stopped because of a problem</h2>
              <div className="note err"><Info /><span>{state.error}</span></div>
              <button type="button" className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => navigate('/')}>Try again</button>
              <span className="tiny muted">Your settings are kept in this tab, so you can just pick another model or press Start.</span>
            </div>
          )}
          {state.status === 'stopped' && !state.reportReady && (
            <div className="card"><h2 style={{ fontSize: 22 }}>You stopped this test</h2><p className="muted">Your API key was deleted from the server.</p>
              <button type="button" className="btn primary" onClick={() => navigate('/')}>Start a new test</button></div>
          )}

          {state.status === 'running' && !state.checkpoint && !showResults && (
            <div className="card row rise" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
              <span className="spinner" style={{ marginTop: 4 }} />
              <div>
                <b>{{ learn: 'Learning your product: exploring the website and reading your documents.', plan: 'Planning the tests.', test: 'Running the tests.', report: 'Writing the bug reports and the final report.' }[state.phase]}</b>
                <div className="small muted">The live view and the box on the right show every step. Keep this tab open: it beeps when it needs you.</div>
              </div>
            </div>
          )}
          {state.checkpoint && <CheckpointCard key={state.checkpoint.id} cp={state.checkpoint} send={send} />}

          {state.reportReady && (
            <section className="verdict-card rise">
              <span className="chip" style={{ alignSelf: 'flex-start', background: '#fff', color: 'var(--violet-dark)', fontSize: 14, padding: '5px 14px' }}>{state.verdict}</span>
              <h2 style={{ fontWeight: 800, fontSize: 32, lineHeight: 1.15 }}>
                {state.verdict === 'Inconclusive'
                  ? `No test could run to the end on ${host}. See why below.`
                  : state.bugs.length ? `${state.bugs.length} bug${state.bugs.length > 1 ? 's' : ''} found in ${host}.` : `No bugs found in ${host}.`}
              </h2>
              <div className="stats">
                {[[cases.length, 'Tests'], [pass, 'Passed'], [fail, 'Failed'], [cases.length - pass - fail, 'Blocked or not run']].map(([v, l]) => (
                  <div key={l} className="stat"><b>{v}</b><span className="small">{l}</span></div>
                ))}
              </div>
              <div className="row">
                <a className="btn white" href={`/api/runs/${id}/files/report.html`} target="_blank" rel="noreferrer">Open the report</a>
                <a className="btn outline-white" href={`/api/runs/${id}/download.zip`}><Download size={18} /> Report, bugs and videos (.zip)</a>
              </div>
            </section>
          )}
          {state.reportReady && state.bugs.length > 0 && (
            <section className="card" style={{ padding: '10px 8px' }}>
              <h2 style={{ fontSize: 20, margin: '10px 16px 6px' }}>Bugs found</h2>
              {state.bugs.map((b) => (
                <div key={b.id} className="bug-row">
                  <span className={`chip ${b.priority === 'Blocker' || b.priority === 'Critical' ? 'red' : b.priority === 'High' ? 'orange' : 'lav'}`} style={{ width: 84, justifyContent: 'center' }}>{b.priority}</span>
                  <b style={{ flex: '1 1 320px' }}>{b.title}</b>
                  <span className="tiny muted">{b.severity}</span>
                  <a className="tiny" href={`/api/runs/${id}/files/${b.file}`} target="_blank" rel="noreferrer">Bug file</a>
                </div>
              ))}
            </section>
          )}

          {showResults && (
            <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="row" style={{ alignItems: 'baseline', gap: '6px 14px' }}>
                <span style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: 24 }}>{doneCases.length} of {counted.length} tests done</span>
                <span className="muted small">{pass} passed · {fail} failed</span>
              </div>
              <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={counted.length} aria-valuenow={doneCases.length} aria-label="Tests done">
                <div style={{ width: `${(pass / Math.max(1, counted.length)) * 100}%`, background: '#22a05b' }} />
                <div style={{ width: `${(fail / Math.max(1, counted.length)) * 100}%`, background: '#e5484d' }} />
                <div style={{ width: `${((doneCases.length - pass - fail) / Math.max(1, counted.length)) * 100}%`, background: '#e0a040' }} />
              </div>
              {GROUP_ORDER.filter((g) => cases.some((c) => c.group === g)).map((g, gi) => (
                <div key={g}>
                  <h3 style={{ fontSize: 16, margin: '8px 12px 4px' }}>{gi + 1} · {GROUP_LABEL[g]}</h3>
                  <ul className="results">
                    {cases.filter((c) => c.group === g).map((c) => {
                      const st = statusOf(c);
                      const canOpen = ['pass', 'fail', 'blocked', 'skipped'].includes(c.status);
                      const isOpen = open === c.id;
                      const bug = state.bugs.find((b) => b.id === c.bugId);
                      return (
                        <li key={c.id} style={{ borderRadius: 14, background: c.status === 'fail' ? '#fff8f6' : undefined }}>
                          <button type="button" className="result-row" disabled={!canOpen} aria-expanded={canOpen ? isOpen : undefined} onClick={() => setOpen(isOpen ? null : c.id)} style={{ cursor: canOpen ? 'pointer' : 'default' }}>
                            <span className={`status ${st.cls}`}>{c.status === 'running' && <span className="spinner sm" />}{st.label}</span>
                            <span className="tiny muted" style={{ width: 60, flex: 'none', fontWeight: 600 }}>{c.id}</span>
                            <span className="grow" style={{ fontWeight: 500 }}>{c.title}</span>
                            {canOpen && <Chevron up={isOpen} size={18} />}
                          </button>
                          {isOpen && (
                            <div className="result-detail">
                              <span><b>Expected:</b> {c.expected}</span>
                              <span><b>Actual:</b> {c.actual || c.notes || '—'}</span>
                              {c.notes && c.actual && <span className="muted">{c.notes}</span>}
                              {c.screenshot && <a href={`/api/runs/${id}/files/${c.screenshot}`} target="_blank" rel="noreferrer">Screenshot</a>}
                              {c.video && <video controls preload="metadata" src={`/api/runs/${id}/files/${c.video}`} style={{ width: '100%', borderRadius: 12, background: '#000' }} />}
                              {bug && <span className="row" style={{ gap: 6 }}><span className="chip red">{bug.priority}</span><span className="chip outline">{bug.severity}</span> <b>{bug.id}</b> {bug.businessImpact}</span>}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </section>
          )}
        </section>

        <aside className="side">
          <div className="browser">
            <div className="browser-bar">
              <span className="dots" aria-hidden="true"><span /><span /><span /></span>
              <span className="browser-url">{state.live.url || host}</span>
            </div>
            <div className="browser-view">
              {frame && !finished ? <img src={`data:image/jpeg;base64,${frame}`} alt="Live view of the agent's browser" /> : <span>{finished ? 'The browser is closed' : "The agent's browser appears here"}</span>}
            </div>
          </div>
          <div className="live-card" aria-live="polite">
            <span className="row tiny" style={{ gap: 8, color: '#cfc8ee', fontWeight: 600 }}>
              <span className={`live-dot ${liveState === 'live' ? '' : liveState}`} />
              {state.status === 'waiting' ? 'Paused — waiting for you' : state.status === 'queued' ? 'In line' : finished ? (state.status === 'done' ? 'Finished' : 'Stopped') : 'Live'}
            </span>
            <span style={{ fontWeight: 600 }}>{state.status === 'waiting' ? state.checkpoint?.title : finished ? state.activity.at(-1)?.text : aiWait !== null ? 'Waiting for the AI to answer…' : state.live.action || state.activity.at(-1)?.text || 'Starting…'}</span>
            {aiWait !== null && (
              <span className="tiny" style={{ color: aiWait > 60_000 ? '#ffcfbf' : '#cfc8ee' }}>
                {fmt(aiWait)}{aiWait > 60_000 ? ' · Slower than usual: the AI provider may be busy. It will retry or stop with a clear message, so you never wait forever.' : ' · This is normal: each step takes the AI a few seconds.'}
              </span>
            )}
            {state.status === 'running' && (
              <span className="tiny" style={{ color: '#cfc8ee' }}>
                {state.live.step ? `${state.live.step} · ` : ''}AI used {(state.usage.inputTokens + state.usage.outputTokens).toLocaleString()} tokens so far
              </span>
            )}
          </div>
          <details className="card" style={{ padding: '18px 22px' }} open={!state.checkpoint && !showResults}>
            <summary>What I've done so far</summary>
            <ul className="feed">
              {[...state.activity].reverse().map((a, i) => <li key={i}><time>{fmt(a.t)}</time><span>{a.text}</span></li>)}
            </ul>
          </details>
          {state.understanding && (
            <details className="card" style={{ padding: '18px 22px' }}>
              <summary>What I learned about {state.understanding.productName}</summary>
              <p className="small" style={{ marginBottom: 6 }}>{state.understanding.summary}</p>
              {state.personas.length > 0 && <p className="small muted" style={{ margin: 0 }}>Users: {state.personas.map((p) => p.name).join(', ')}</p>}
            </details>
          )}
          <span className="tiny muted row" style={{ gap: 6 }}><Lock size={14} /> {finished ? 'Your API key was deleted when the test finished.' : 'Your API key is only kept in memory for this test.'}</span>
        </aside>
      </div>
    </main>
  );
}
