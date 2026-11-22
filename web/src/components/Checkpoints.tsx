import { useMemo, useState } from 'react';
import { GROUP_LABEL, GROUP_ORDER, type CaseGroup, type Checkpoint, type CheckpointAnswer } from '../../../server/types';
import { Chevron, Grip, Plus, Trash } from './Icons';

type Send = (a: CheckpointAnswer) => Promise<void>;

function Actions({ primary, onPrimary, onDefaults, busy }: { primary: string; onPrimary: () => void; onDefaults?: () => void; busy: boolean }) {
  return (
    <div className="row" style={{ paddingTop: 4 }}>
      <button type="button" className="btn primary" onClick={onPrimary} disabled={busy}>
        {busy ? <span className="spinner" /> : null}
        {primary}
      </button>
      {onDefaults && (
        <button type="button" className="btn ghost" onClick={onDefaults} disabled={busy}>
          Use your best guess
        </button>
      )}
    </div>
  );
}

// ---------------- questions ----------------
function QuestionsCard({ cp, send }: { cp: Extract<Checkpoint, { kind: 'questions' }>; send: Send }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const go = async (a: CheckpointAnswer) => { setBusy(true); await send(a); };
  return (
    <section className="turn" aria-labelledby="cp-title">
      <span className="turn-chip">Your turn</span>
      <h2 id="cp-title" style={{ fontSize: 26 }}>{cp.title}</h2>
      <p className="muted" style={{ margin: 0 }}>Your answers change what I test. Tap an answer or type your own.</p>
      {cp.questions.map((q) => (
        <div key={q.id} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 16, borderRadius: 18, background: 'var(--lav)' }}>
          <b>{q.question}</b>
          <div className="row" role="group" aria-label={`Answers for: ${q.question}`}>
            {q.suggestions.map((s) => (
              <button key={s} type="button" className="quick" aria-pressed={answers[q.id] === s} onClick={() => setAnswers((a) => ({ ...a, [q.id]: s }))}>{s}</button>
            ))}
          </div>
          <input className="input" aria-label="Your own answer" placeholder={`Or type your answer (default: ${q.defaultAnswer})`} value={q.suggestions.includes(answers[q.id]) ? '' : answers[q.id] || ''}
            onChange={(e) => { const v = e.target.value; setAnswers((a) => ({ ...a, [q.id]: v })); }} style={{ background: '#fff' }} />
        </div>
      ))}
      <Actions busy={busy} primary="Send answers" onPrimary={() => go({ kind: 'questions', answers })} onDefaults={() => go({ kind: 'questions', useDefaults: true, answers: {} })} />
    </section>
  );
}

// ---------------- main journey (drag to reorder) ----------------
function FlowCard({ cp, send }: { cp: Extract<Checkpoint, { kind: 'flow' }>; send: Send }) {
  const [steps, setSteps] = useState(() => cp.steps.map((text, i) => ({ id: `s${i}`, text })));
  const [values, setValues] = useState<Record<string, string>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    setSteps(next);
  };
  const go = async (a: CheckpointAnswer) => { setBusy(true); await send(a); };
  return (
    <section className="turn" aria-labelledby="cp-title">
      <span className="turn-chip">Your turn</span>
      <h2 id="cp-title" style={{ fontSize: 26 }}>{cp.title}</h2>
      <p className="muted" style={{ margin: 0 }}>I'll test this journey first. Edit any step, drag to reorder, or add what's missing.</p>
      <ol className="flow-list">
        {steps.map((s, i) => (
          <li key={s.id} className={`flow-item ${dragId === s.id ? 'dragging' : ''} ${overId === s.id && dragId !== s.id ? 'drag-over' : ''}`}
            draggable onDragStart={() => setDragId(s.id)} onDragEnd={() => { setDragId(null); setOverId(null); }}
            onDragOver={(e) => { e.preventDefault(); setOverId(s.id); }}
            onDrop={(e) => { e.preventDefault(); const from = steps.findIndex((x) => x.id === dragId); if (from >= 0) move(from, i); setDragId(null); setOverId(null); }}>
            <span className="grip" title="Drag to reorder"><Grip /></span>
            <span className="num">{i + 1}</span>
            <input aria-label={`Step ${i + 1}`} value={s.text} onChange={(e) => setSteps(steps.map((x) => (x.id === s.id ? { ...x, text: e.target.value } : x)))}
              onKeyDown={(e) => {
                if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); move(i, i - 1); }
                if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); move(i, i + 1); }
              }} />
            <button type="button" className="icon-btn" aria-label={`Move step ${i + 1} up`} onClick={() => move(i, i - 1)} disabled={i === 0}><Chevron up /></button>
            <button type="button" className="icon-btn" aria-label={`Move step ${i + 1} down`} onClick={() => move(i, i + 1)} disabled={i === steps.length - 1}><Chevron /></button>
            <button type="button" className="icon-btn" aria-label={`Delete step ${i + 1}`} onClick={() => setSteps(steps.filter((x) => x.id !== s.id))}><Trash /></button>
          </li>
        ))}
      </ol>
      <button type="button" className="quick" style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, borderStyle: 'dashed', color: 'var(--violet-dark)' }}
        onClick={() => setSteps([...steps, { id: `s${Date.now()}`, text: '' }])}><Plus /> Add a step</button>
      {cp.needed.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 18, borderRadius: 18, background: 'var(--coral-bg)' }}>
          <b>One more thing: I need these to run the journey</b>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            {cp.needed.map((n) => (
              <label key={n.id} className="label-sm" style={{ flex: '1 1 220px' }}>{n.label}
                <input className="input" style={{ background: '#fff' }} type={n.secret ? 'password' : 'text'} autoComplete="off" value={values[n.id] || ''} onChange={(e) => { const v = e.target.value; setValues((x) => ({ ...x, [n.id]: v })); }} />
              </label>
            ))}
          </div>
          <span className="tiny muted">Leave empty if you don't have it; I'll skip what needs it.</span>
        </div>
      )}
      <Actions busy={busy} primary="Yes, looks right" onPrimary={() => go({ kind: 'flow', steps: steps.map((s) => s.text), values })} onDefaults={() => go({ kind: 'flow', useDefaults: true, steps: [], values: {} })} />
    </section>
  );
}

// ---------------- test cases ----------------
function CasesCard({ cp, send }: { cp: Extract<Checkpoint, { kind: 'cases' }>; send: Send }) {
  const groups = GROUP_ORDER.filter((g) => cp.cases.some((c) => c.group === g));
  const [group, setGroup] = useState<CaseGroup>(groups[0]);
  const [edits, setEdits] = useState<Record<string, { expected: string; include: boolean }>>(() =>
    Object.fromEntries(cp.cases.map((c) => [c.id, { expected: c.expected, include: true }])),
  );
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unsure = cp.cases.filter((c) => c.unsure).length;
  const included = Object.values(edits).filter((e) => e.include).length;
  const shown = useMemo(() => cp.cases.filter((c) => c.group === group).sort((a, b) => Number(b.unsure) - Number(a.unsure)), [cp.cases, group]);
  const go = async (a: CheckpointAnswer) => { setBusy(true); await send(a); };
  const setAll = (include: boolean) => setEdits(Object.fromEntries(Object.entries(edits).map(([k, v]) => [k, { ...v, include }])));
  return (
    <section className="turn" aria-labelledby="cp-title">
      <span className="turn-chip">Your turn</span>
      <h2 id="cp-title" style={{ fontSize: 26 }}>{cp.title}</h2>
      <p className="muted" style={{ margin: 0 }}>
        {cp.cases.length} tests, run in this order: the main journey first, then unusual use, then wrong input.
        Check what I expect to happen and fix anything that's wrong.{unsure ? ` ${unsure} marked "Not sure" are shown first.` : ''}
      </p>
      <div className="tabs" role="tablist" aria-label="Test groups">
        {groups.map((g, i) => (
          <button key={g} type="button" role="tab" className="tab" aria-selected={group === g} onClick={() => setGroup(g)}>
            {i + 1} · {GROUP_LABEL[g]} <span className="count">{cp.cases.filter((c) => c.group === g).length}</span>
          </button>
        ))}
      </div>
      <div className="row tiny muted" style={{ justifyContent: 'space-between' }}>
        <span>{included} of {cp.cases.length} tests included</span>
        <span className="row" style={{ gap: 4 }}>
          <button type="button" className="link-btn" onClick={() => setAll(true)}>Include all</button>
          <button type="button" className="link-btn" onClick={() => setAll(false)}>Skip all</button>
        </span>
      </div>
      <div role="tabpanel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {shown.map((c) => {
          const e = edits[c.id];
          return (
            <div key={c.id} className={`case-card ${c.unsure ? 'unsure' : ''} ${e.include ? '' : 'off'}`}>
              <div className="row" style={{ gap: '8px 10px' }}>
                <span className="tiny muted" style={{ fontWeight: 600 }}>{c.id}</span>
                <b style={{ flex: '1 1 240px' }}>{c.title}</b>
                <span className="chip lav">{c.persona}</span>
                <span className={`chip ${c.priority === 'High' ? 'red' : c.priority === 'Medium' ? 'orange' : ''}`}>{c.priority}</span>
                {c.unsure && <span className="chip coral">Not sure</span>}
                <label className="toggle">
                  <input type="checkbox" className="sr-only" checked={e.include} onChange={(ev) => { const on = ev.target.checked; setEdits((x) => ({ ...x, [c.id]: { ...x[c.id], include: on } })); }} />
                  <span className="switch" aria-hidden="true" />
                  {e.include ? 'Include' : 'Skip'}
                </label>
              </div>
              <label className="label-sm">What should happen
                <textarea className="input" rows={2} style={{ background: '#fff', color: 'var(--ink)', fontSize: 15 }} value={e.expected} disabled={!e.include}
                  onChange={(ev) => { const v = ev.target.value; setEdits((x) => ({ ...x, [c.id]: { ...x[c.id], expected: v } })); }} />
              </label>
              <button type="button" className="link-btn" style={{ alignSelf: 'flex-start', paddingLeft: 0, minHeight: 32 }} aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>
                {open === c.id ? 'Hide steps' : 'Show steps'} <Chevron up={open === c.id} />
              </button>
              {open === c.id && (
                <div className="small rise">
                  {c.preconditions && <p style={{ margin: '0 0 6px' }}><b>Before:</b> {c.preconditions}</p>}
                  <ol style={{ margin: 0, paddingLeft: 20 }}>{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                  <p className="muted" style={{ margin: '6px 0 0' }}>Source: {c.source}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Actions busy={busy} primary="Looks good, start testing"
        onPrimary={() => go({ kind: 'cases', cases: Object.entries(edits).map(([id, v]) => ({ id, ...v })) })}
        onDefaults={() => go({ kind: 'cases', useDefaults: true, cases: [] })} />
    </section>
  );
}

// ---------------- E2E gate ----------------
function GateCard({ cp, send }: { cp: Extract<Checkpoint, { kind: 'gate' }>; send: Send }) {
  const [busy, setBusy] = useState(false);
  const go = async (decision: 'continue' | 'skip_related' | 'stop') => { setBusy(true); await send({ kind: 'gate', decision }); };
  return (
    <section className="turn" aria-labelledby="cp-title">
      <span className="turn-chip">Your turn</span>
      <h2 id="cp-title" style={{ fontSize: 24 }}>{cp.title}</h2>
      <p className="muted" style={{ margin: 0 }}>Some of the next tests depend on the main journey, so their results may not mean much yet. Keep testing anyway?</p>
      <ul style={{ margin: 0, paddingLeft: 20 }}>
        {cp.failed.map((f) => <li key={f.id}><b>{f.id} {f.title}:</b> {f.actual}</li>)}
      </ul>
      <div className="row">
        <button type="button" className="btn primary" disabled={busy} onClick={() => go('continue')}>Keep testing</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => go('skip_related')}>Skip tests that depend on it</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => go('stop')}>Stop and get the report</button>
      </div>
    </section>
  );
}

export function CheckpointCard({ cp, send }: { cp: Checkpoint; send: Send }) {
  switch (cp.kind) {
    case 'questions': return <QuestionsCard key={cp.id} cp={cp} send={send} />;
    case 'flow': return <FlowCard key={cp.id} cp={cp} send={send} />;
    case 'cases': return <CasesCard key={cp.id} cp={cp} send={send} />;
    case 'gate': return <GateCard key={cp.id} cp={cp} send={send} />;
  }
}
