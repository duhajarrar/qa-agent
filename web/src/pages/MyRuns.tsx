import { useEffect, useState } from 'react';
import type { PublicRunState } from '../../../server/types';
import { api, recentRuns } from '../api';
import { navigate } from '../nav';

export function MyRuns() {
  const [items, setItems] = useState<{ id: string; url: string; at: number; state: PublicRunState | null }[] | null>(null);
  useEffect(() => {
    const list = recentRuns();
    Promise.all(list.map(async (r) => ({ ...r, state: await api.getRun(r.id).catch(() => null) }))).then(setItems);
  }, []);
  return (
    <main className="page">
      <h1 style={{ fontWeight: 800, fontSize: 32 }}>My tests</h1>
      <p className="muted" style={{ margin: 0 }}>Tests you started in this browser. Reports are kept on the server for a few hours, so download the ones you need.</p>
      {!items ? <div className="row muted"><span className="spinner" /> Loading…</div> : items.length === 0 ? (
        <div className="card"><p style={{ marginTop: 0 }}>No tests yet.</p><button className="btn primary" onClick={() => navigate('/')}>Start your first test</button></div>
      ) : (
        <ul className="card" style={{ listStyle: 'none', padding: 8, margin: 0 }}>
          {items.map((r) => (
            <li key={r.id}>
              <a href={`/run/${r.id}`} onClick={(e) => { e.preventDefault(); navigate(`/run/${r.id}`); }}
                className="row" style={{ padding: '14px 16px', borderRadius: 14, textDecoration: 'none', color: 'inherit' }}>
                <b className="grow">{(() => { try { return new URL(r.url).host; } catch { return r.url; } })()}</b>
                <span className="small muted">{new Date(r.at).toLocaleString()}</span>
                <span className={`chip ${r.state?.status === 'done' ? 'lav' : r.state?.status === 'waiting' ? 'coral' : ''}`}>
                  {r.state ? (r.state.status === 'done' ? r.state.verdict : r.state.status === 'waiting' ? 'Needs you' : r.state.status) : 'Expired'}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
