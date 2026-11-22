import { useEffect, useRef, useState } from 'react';
import type { Account, Depth, ModelInfo, ProviderId } from '../../../server/types';
import { api, rememberRun } from '../api';
import { navigate } from '../nav';
import { Arrow, Check, Chevron, Globe, Info, Lock, Plus, Trash, Upload, ListIcon, Video, FileIcon } from '../components/Icons';

type PId = ProviderId | 'mock';
interface ProviderMeta { id: PId; name: string; mark: string; color: string; tag: string; free: boolean; placeholder: string; keyUrl: string }

const PROVIDERS: ProviderMeta[] = [
  { id: 'anthropic', name: 'Claude', mark: 'C', color: '#B8532F', tag: 'Best results', free: false, placeholder: 'sk-ant-…', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI', mark: 'O', color: '#0E8A6A', tag: 'Great results', free: false, placeholder: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'google', name: 'Gemini', mark: 'G', color: '#2F62D4', tag: 'Free tier', free: true, placeholder: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'deepseek', name: 'DeepSeek', mark: 'D', color: '#3D5BE0', tag: 'Low cost', free: false, placeholder: 'sk-…', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'openrouter', name: 'OpenRouter', mark: 'R', color: '#55556B', tag: 'Many models, some free', free: true, placeholder: 'sk-or-…', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'groq', name: 'Groq', mark: 'Q', color: '#C9431D', tag: 'Free tier', free: true, placeholder: 'gsk_…', keyUrl: 'https://console.groq.com/keys' },
];
const MOCK: ProviderMeta = { id: 'mock', name: 'Mock (testing)', mark: 'M', color: '#5B5675', tag: 'No key needed', free: false, placeholder: 'anything', keyUrl: '#' };

const DEPTHS: { id: Depth; name: string; hint: string }[] = [
  { id: 'quick', name: 'Quick', hint: 'Main journey only' },
  { id: 'standard', name: 'Standard', hint: 'Recommended' },
  { id: 'deep', name: 'Deep', hint: 'Every corner' },
];

function Dot({ done, active, n }: { done: boolean; active: boolean; n: number }) {
  return <span className={`dot ${done ? 'done' : active ? 'active' : 'todo'}`}>{done ? <Check size={16} /> : n}</span>;
}

export function Start() {
  const [mockAvailable, setMockAvailable] = useState(false);
  const [provider, setProvider] = useState<PId | null>(null);
  const [key, setKey] = useState('');
  const [keyState, setKeyState] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [keyError, setKeyError] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState('');
  const [recommended, setRecommended] = useState('');
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<{ state: 'idle' | 'loading' | 'ok' | 'error'; title?: string; host?: string; color?: string | null; error?: string }>({ state: 'idle' });
  const [more, setMore] = useState(false);
  const [depth, setDepth] = useState<Depth>('standard');
  const [depthTouched, setDepthTouched] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([{ role: '', username: '', password: '' }]);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const previewTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api.health().then((h) => setMockAvailable(h.mock)).catch(() => {});
  }, []);

  const list = mockAvailable ? [...PROVIDERS, MOCK] : PROVIDERS;
  const meta = list.find((p) => p.id === provider);
  const keyOk = keyState === 'ok';
  const urlOk = preview.state === 'ok';
  const limited = !!meta && (meta.free || model.endsWith(':free'));

  useEffect(() => {
    if (limited && !depthTouched) setDepth('quick');
    if (!limited && !depthTouched) setDepth('standard');
  }, [limited, depthTouched]);

  function pick(p: PId) {
    setProvider(p);
    setKeyState('idle');
    setModels([]);
    setModel('');
    setKeyError('');
  }

  async function check() {
    if (!provider || keyState === 'checking') return;
    setKeyState('checking');
    setKeyError('');
    try {
      const r = await api.checkKey(provider, key);
      if (r.ok) {
        setModels(r.models);
        setModel(r.recommended || r.models[0]?.id || '');
        setRecommended(r.recommended || '');
        setKeyState('ok');
      } else {
        setKeyState('error');
        setKeyError(r.error || 'This key did not work.');
      }
    } catch (e) {
      setKeyState('error');
      setKeyError(e instanceof Error ? e.message : 'Could not check the key.');
    }
  }

  function onUrl(v: string) {
    setUrl(v);
    window.clearTimeout(previewTimer.current);
    const full = v.trim() && !/^https?:\/\//i.test(v.trim()) ? `https://${v.trim()}` : v.trim();
    if (!/^https?:\/\/[^\s/]+\.[^\s]{2,}|^https?:\/\/localhost/i.test(full)) {
      setPreview({ state: 'idle' });
      return;
    }
    setPreview({ state: 'loading' });
    previewTimer.current = window.setTimeout(async () => {
      try {
        const r = await api.preview(full);
        setPreview(r.ok ? { state: 'ok', title: r.title, host: r.host, color: r.themeColor } : { state: 'error', error: r.error });
      } catch {
        setPreview({ state: 'error', error: 'Could not check the website.' });
      }
    }, 600);
  }

  async function start() {
    if (!provider || !keyOk || !urlOk) return;
    setSubmitting(true);
    setError('');
    try {
      const full = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
      const id = await api.createRun(
        { provider, apiKey: key, model, url: full, depth, notes, accounts: accounts.filter((a) => a.role.trim() && a.username.trim()) },
        files,
      );
      rememberRun(id, full);
      navigate(`/run/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the test.');
      setSubmitting(false);
    }
  }

  const ready = !!provider && keyOk && urlOk && !!model;

  return (
    <main className="page">
      <section className="rise" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, textAlign: 'center', marginTop: 8 }}>
        <span className="chip lav" style={{ fontSize: 14, padding: '6px 14px' }}>Your AI QA engineer</span>
        <h1 className="hero" style={{ fontWeight: 800, fontSize: 54, lineHeight: 1.06, letterSpacing: '-0.02em', textWrap: 'balance' }}>
          Find the bugs <span style={{ color: 'var(--violet)' }}>before your users do.</span>
        </h1>
        <p className="muted" style={{ margin: 0, fontSize: 19, maxWidth: 560 }}>
          Pick the AI you already use, add your website, and get a full test report with bugs, screenshots and videos.
        </p>
      </section>

      <form className="card big" style={{ display: 'flex', flexDirection: 'column', gap: 28 }} onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <fieldset>
          <legend className="step-legend"><Dot done={!!provider} active={!provider} n={1} />Which AI do you use?</legend>
          <div className="tiles">
            {list.map((p) => (
              <button key={p.id} type="button" className="tile" aria-pressed={provider === p.id} onClick={() => pick(p.id)}>
                <span className="row" style={{ width: '100%', flexWrap: 'nowrap' }}>
                  <span className="tile-mark" style={{ background: p.color }}>{p.mark}</span>
                  <b className="grow">{p.name}</b>
                  {provider === p.id && <span style={{ color: 'var(--violet)' }}><Check /></span>}
                </span>
                <span className={`tag ${p.free ? 'green' : ''}`}>{p.tag}</span>
              </button>
            ))}
          </div>
        </fieldset>

        {meta && (
          <fieldset className="rise" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <legend className="step-legend"><Dot done={keyOk} active={!keyOk} n={2} />Paste your {meta.name} API key</legend>
            <div className="row">
              <label className={`input-wrap ${keyOk ? 'ok' : ''}`} style={{ flex: '1 1 320px' }}>
                <span style={{ color: 'var(--violet)', display: 'flex' }}><Lock /></span>
                <span className="sr-only">API key</span>
                <input type="password" autoComplete="off" spellCheck={false} placeholder={meta.placeholder} value={key}
                  onChange={(e) => { setKey(e.target.value); if (keyState !== 'idle') setKeyState('idle'); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void check(); } }} />
              </label>
              <button type="button" className={`btn ${keyOk ? '' : 'ghost'}`} style={{ minWidth: 150, height: 60, ...(keyOk ? { background: 'var(--pass-bg)', color: 'var(--pass)' } : {}) }} onClick={check} disabled={!key.trim()}>
                {keyState === 'checking' ? <><span className="spinner" /> Checking</> : keyOk ? <><Check size={18} /> Key works</> : 'Check key'}
              </button>
            </div>
            <div className="row small muted" style={{ justifyContent: 'space-between' }}>
              <span>Private. Used only for this test, then deleted. You need an API key, not a chat subscription.</span>
              {meta.id !== 'mock' && <a href={meta.keyUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>Get a {meta.name} key</a>}
            </div>
            {keyState === 'error' && <div className="note err"><Info /> <span>{keyError}</span></div>}
            {keyOk && models.length > 0 && (
              <label className="label-sm rise">Model
                <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.id === recommended ? ' (recommended)' : ''}</option>)}
                </select>
              </label>
            )}
            {keyOk && limited && (
              <div className="note rise"><Info /><span>Free keys have daily limits, so I suggest a <strong>Quick test</strong> (main journey only). For a full test, use a paid key. You can change this under More options.</span></div>
            )}
          </fieldset>
        )}

        {keyOk && (
          <fieldset className="rise" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <legend className="step-legend"><Dot done={urlOk} active={!urlOk} n={3} />Which website should I test?</legend>
            <label className={`input-wrap ${urlOk ? 'ok' : ''}`}>
              <span style={{ color: 'var(--violet)', display: 'flex' }}><Globe /></span>
              <span className="sr-only">Website link</span>
              <input type="text" inputMode="url" placeholder="https://your-website.com" value={url} onChange={(e) => onUrl(e.target.value)} />
              {preview.state === 'loading' && <span className="spinner" />}
            </label>
            {preview.state === 'ok' && (
              <div className="row rise" style={{ padding: '14px 16px', borderRadius: 16, background: 'var(--lav-2)', flexWrap: 'nowrap' }}>
                <span className="tile-mark" style={{ width: 44, height: 44, borderRadius: 12, background: preview.color || 'var(--violet)' }}>{(preview.title || preview.host || '?')[0].toUpperCase()}</span>
                <span className="grow" style={{ display: 'flex', flexDirection: 'column' }}>
                  <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview.title}</b>
                  <span className="tiny muted">{preview.host} is reachable · your report will use its colors</span>
                </span>
              </div>
            )}
            {preview.state === 'error' && <div className="note err"><Info /> <span>{preview.error}</span></div>}
          </fieldset>
        )}

        {error && <div className="note err"><Info /> <span>{error}</span></div>}
        <button type="submit" className="btn primary huge" disabled={!ready || submitting}>
          {submitting ? <><span className="spinner" /> Starting…</> : ready ? <>Start testing <Arrow /></> : provider ? 'Almost there' : 'Pick your AI to start'}
        </button>

        <button type="button" className="link-btn" style={{ alignSelf: 'center' }} aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? 'Fewer options' : 'More options (optional)'} <Chevron up={more} />
        </button>

        {more && (
          <div className="rise" style={{ display: 'flex', flexDirection: 'column', gap: 22, paddingTop: 22, borderTop: '1px solid var(--line)' }}>
            <fieldset>
              <legend style={{ fontWeight: 600, marginBottom: 8, padding: 0 }}>How deep should it test?</legend>
              <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))' }}>
                {DEPTHS.map((d) => (
                  <label key={d.id} className="tile" aria-pressed={depth === d.id} style={{ minHeight: 0 }}>
                    <span className="row" style={{ gap: 8 }}>
                      <input type="radio" name="depth" checked={depth === d.id} onChange={() => { setDepth(d.id); setDepthTouched(true); }} style={{ accentColor: 'var(--violet)' }} />
                      <b>{d.name}</b>
                    </span>
                    <span className="tiny muted">{d.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="row" style={{ padding: '16px 18px', border: '2px dashed #d6cef7', borderRadius: 16, background: '#fbfaff', cursor: 'pointer', flexWrap: 'nowrap' }}>
              <span className="tile-mark" style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--lav-3)', color: 'var(--violet)' }}><Upload /></span>
              <span className="grow" style={{ display: 'flex', flexDirection: 'column' }}>
                <b>{files.length ? `${files.length} file${files.length > 1 ? 's' : ''}: ${files.map((f) => f.name).join(', ')}` : 'Add requirements or user stories'}</b>
                <span className="tiny muted">PDF, Word, Markdown or text. Up to 5 files, 10 MB each.</span>
              </span>
              <input type="file" multiple accept=".pdf,.docx,.md,.txt,.markdown,.csv,.json,.feature" className="sr-only" onChange={(e) => setFiles(Array.from(e.target.files || []).slice(0, 5))} />
            </label>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <b>Test logins for your website</b>
              {accounts.map((a, i) => (
                <div key={i} className="row" style={{ alignItems: 'flex-end' }}>
                  <label className="label-sm" style={{ flex: '1 1 140px' }}>Role<input className="input" placeholder="e.g. Customer" value={a.role} onChange={(e) => setAccounts(accounts.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} /></label>
                  <label className="label-sm" style={{ flex: '2 1 200px' }}>Email or username<input className="input" value={a.username} onChange={(e) => setAccounts(accounts.map((x, j) => (j === i ? { ...x, username: e.target.value } : x)))} /></label>
                  <label className="label-sm" style={{ flex: '2 1 160px' }}>Password<input className="input" type="password" autoComplete="off" value={a.password} onChange={(e) => setAccounts(accounts.map((x, j) => (j === i ? { ...x, password: e.target.value } : x)))} /></label>
                  {accounts.length > 1 && <button type="button" className="icon-btn" aria-label="Remove this login" onClick={() => setAccounts(accounts.filter((_, j) => j !== i))}><Trash /></button>}
                </div>
              ))}
              {accounts.length < 6 && <button type="button" className="link-btn" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={() => setAccounts([...accounts, { role: '', username: '', password: '' }])}><Plus /> Add another role</button>}
              <span className="tiny muted">The AI never sees passwords: the browser types them in for it, and they are hidden in the report.</span>
            </div>

            <label className="field">Anything to focus on or avoid?
              <textarea className="input" rows={3} placeholder="e.g. Focus on checkout. Don't touch the billing page." value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>
        )}
      </form>

      <section aria-label="What you get" className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: 14 }}>
        {([
          ['Test cases', 'Written from your users\' point of view, main journey first.', 'var(--lav-3)', 'var(--violet)', <ListIcon key="i" />],
          ['Bugs with video', 'Every bug comes with steps, a screenshot and a recording.', '#ffe9e2', '#d9461f', <Video key="i" />],
          ['One clear report', 'A single HTML file you can open, share or print.', 'var(--pass-bg)', 'var(--pass)', <FileIcon key="i" />],
        ] as const).map(([t, d, bg, fg, icon]) => (
          <div key={t} className="card" style={{ borderRadius: 20, padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ width: 42, height: 42, borderRadius: 14, background: bg, color: fg, display: 'flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden="true">{icon}</span>
            <b>{t}</b>
            <span className="small muted">{d}</span>
          </div>
        ))}
      </section>
    </main>
  );
}
