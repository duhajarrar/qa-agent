import fs from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { GROUP_LABEL, GROUP_ORDER, type Brand, type Bug, type EnvInfo, type Persona, type TestCase, type Understanding } from '../types.js';
import type { exploreSchema, planSchema, summarySchema } from '../agent/schemas.js';

export interface ReportData {
  runId: string;
  understanding: Understanding;
  personas: Persona[];
  flow: string[];
  plan: z.infer<typeof planSchema>;
  explore: z.infer<typeof exploreSchema> | null;
  cases: TestCase[];
  bugs: Bug[];
  env: EnvInfo;
  brand: Brand;
  summary: z.infer<typeof summarySchema>;
  verdict: string;
  clarifications: string[];
  testData: string[];
  depth: string;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function luminance(hex: string) {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m) return 0;
  const [r, g, b] = m.map((x) => {
    const v = parseInt(x, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};
/** Darkens a color until white text on it is readable. */
function readableBg(hex: string) {
  let h = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#6d4aff';
  for (let i = 0; i < 12 && contrast(h, '#ffffff') < 4.5; i++) {
    const [r, g, b] = h.slice(1).match(/.{2}/g)!.map((x) => Math.round(parseInt(x, 16) * 0.85));
    h = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  return h;
}

// Images are inserted after secrets are masked, so masking can never corrupt base64 data.
async function dataUri(images: string[], runDir: string, rel?: string) {
  if (!rel) return '';
  try {
    const buf = await fs.readFile(path.join(runDir, rel));
    images.push(`data:image/png;base64,${buf.toString('base64')}`);
    return `__QA_IMG_${images.length - 1}__`;
  } catch {
    return '';
  }
}

const STATUS: Record<TestCase['status'], { label: string; cls: string; icon: string }> = {
  pass: { label: 'Pass', cls: 'pass', icon: '✓' },
  fail: { label: 'Fail', cls: 'fail', icon: '✕' },
  blocked: { label: 'Blocked', cls: 'blocked', icon: '!' },
  skipped: { label: 'Skipped', cls: 'muted', icon: '–' },
  not_run: { label: 'Not run', cls: 'muted', icon: '○' },
  running: { label: 'Not run', cls: 'muted', icon: '○' },
};

const PRIORITY_CLS: Record<string, string> = { Blocker: 'p-crit', Critical: 'p-crit', High: 'p-high', Medium: 'p-med', Low: 'p-low' };

export async function writeHtmlReport(runDir: string, d: ReportData, mask: (s: string) => string) {
  const images: string[] = [];
  const primary = readableBg(d.brand.primary);
  const accent = readableBg(d.brand.accent);
  const n = (s: TestCase['status']) => d.cases.filter((c) => c.status === s).length;
  const executed = n('pass') + n('fail');
  const passRate = executed ? Math.round((n('pass') / executed) * 100) : 0;
  const verdictCls = d.verdict === 'Ready' ? 'pass' : d.verdict === 'Not ready' ? 'fail' : 'blocked'; // Inconclusive / Ready with risks
  const shots = new Map<string, string>();
  for (const c of d.cases) if (c.screenshot) shots.set(c.id, await dataUri(images, runDir, c.screenshot));
  const sevCounts = ['S1 Critical', 'S2 Major', 'S3 Minor', 'S4 Trivial'].map((s) => [s, d.bugs.filter((b) => b.severity === s).length] as const);
  const priCounts = ['Blocker', 'Critical', 'High', 'Medium', 'Low'].map((p) => [p, d.bugs.filter((b) => b.priority === p).length] as const);
  const maxBar = Math.max(1, ...sevCounts.map((x) => x[1]), ...priCounts.map((x) => x[1]));
  const ul = (xs: string[]) => (xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">None</p>');
  const personas = [...new Set(d.cases.map((c) => c.persona))];
  const hideSecret = (s: string) => s.replace(/\{\{secret:[^}]+\}\}/g, '••••••');

  const caseRows = GROUP_ORDER.flatMap((g) => d.cases.filter((c) => c.group === g)).map((c) => {
    const st = STATUS[c.status];
    const bug = d.bugs.find((b) => b.id === c.bugId);
    const shot = shots.get(c.id);
    return `<tbody class="case" data-status="${st.cls === 'muted' ? c.status : st.cls}" data-priority="${c.priority}" data-persona="${esc(c.persona)}" data-group="${c.group}" data-text="${esc((c.id + ' ' + c.title + ' ' + c.feature).toLowerCase())}">
<tr class="row" tabindex="0" aria-expanded="false">
<td class="mono">${c.id}</td>
<td><strong>${esc(c.title)}</strong><div class="sub">${esc(c.persona)} · ${esc(c.feature)}</div></td>
<td>${esc(GROUP_LABEL[c.group])}</td>
<td><span class="chip prio-${c.priority.toLowerCase()}">${c.priority}</span></td>
<td><span class="status ${st.cls}"><span aria-hidden="true">${st.icon}</span> ${st.label}</span></td>
<td>${bug ? `<a href="#${bug.id}">${bug.id}</a>` : ''}</td>
</tr>
<tr class="detail"><td colspan="6"><div class="detail-grid">
<div><h4>Preconditions</h4><p>${esc(c.preconditions || 'None')}</p>
<h4>Steps</h4><ol>${c.steps.map((s) => `<li>${esc(hideSecret(s))}</li>`).join('')}</ol>
<h4>Test data</h4><p>${esc(hideSecret(c.testData) || 'None')}</p></div>
<div><h4>Expected result <span class="src">${esc(c.source)}</span></h4><p>${esc(c.expected)}</p>
<h4>Actual result</h4><p>${esc(c.actual || '—')}</p>
${c.notes ? `<h4>Notes</h4><p>${esc(c.notes)}</p>` : ''}
${shot ? `<img class="thumb" src="${shot}" alt="Screenshot at the end of ${c.id}" loading="lazy">` : ''}</div>
</div></td></tr></tbody>`;
  });

  const bugCards = await Promise.all(
    d.bugs.map(async (b) => {
      const shot = b.screenshot ? shots.get(b.caseIds[0]) || (await dataUri(images, runDir, b.screenshot)) : '';
      return `<article class="bug" id="${b.id}">
<div class="bug-head"><span class="mono muted">${b.id} · ${b.caseIds.join(', ')}</span>
<span class="chip ${PRIORITY_CLS[b.priority]}">Priority: ${b.priority}</span>
<span class="chip sev">Severity: ${b.severity}</span>
<span class="chip sev">${esc(b.reproducibility)}</span></div>
<h3>${esc(b.title)}</h3>
<div class="impact"><span class="label">Business impact</span>${esc(b.businessImpact)}</div>
<div class="bug-media">${shot ? `<img src="${shot}" alt="Screenshot of ${b.id}">` : ''}
${b.video ? `<video controls preload="metadata" src="${esc(b.video)}"><a href="${esc(b.video)}">Download the video</a></video>` : ''}</div>
<div class="ea"><div><h4>Expected</h4><p>${esc(b.expected)}</p></div><div><h4>Actual</h4><p>${esc(b.actual)}</p></div></div>
<details><summary>Description and reproduction steps</summary>
<p>${esc(b.description)}</p>
<h4>Environment</h4><p>${esc(d.env.url)} · app version ${esc(d.env.appVersion)} · ${esc(d.env.browser)} · ${esc(d.env.viewport)}</p>
<h4>Steps to reproduce</h4><ol>${b.steps.map((s) => `<li>${esc(hideSecret(s))}</li>`).join('')}</ol>
${b.consoleErrors.length ? `<h4>Console errors</h4><ul>${b.consoleErrors.map((e) => `<li class="mono">${esc(e)}</li>`).join('')}</ul>` : ''}
${b.failedRequests.length ? `<h4>Failed requests</h4><ul>${b.failedRequests.map((e) => `<li class="mono">${esc(e)}</li>`).join('')}</ul>` : ''}
<p class="muted">Bug file: <a href="${esc(b.file)}">${esc(b.file)}</a></p>
</details></article>`;
    }),
  );

  const bar = (label: string, v: number, cls: string) =>
    `<div class="bar-row"><span>${esc(label)}</span><div class="bar"><div class="${cls}" style="width:${(v / maxBar) * 100}%"></div></div><b>${v}</b></div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test report — ${esc(d.understanding.productName)}</title>
<style>
:root{--brand:${primary};--accent:${accent};--ink:#1b1d24;--muted:#5b6070;--line:#e4e6ec;--bg:#f6f7f9;
--pass:#14632f;--pass-bg:#e3f5ea;--fail:#a1261b;--fail-bg:#fde8e6;--blocked:#7a4100;--blocked-bg:#fff1dc;--grey:#4d5260;--grey-bg:#eef0f3}
*{box-sizing:border-box}
body{margin:0;font-family:${d.brand.font.replace(/[<>;{}]/g, '')}, -apple-system, "Segoe UI", Roboto, sans-serif;color:var(--ink);background:var(--bg);line-height:1.55;font-size:15px}
a{color:var(--accent)}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px}
header.top{background:var(--brand);color:#fff;padding:36px 0 30px}
header.top .wrap{display:flex;flex-wrap:wrap;gap:12px 32px;align-items:flex-end;justify-content:space-between}
header.top h1{margin:0;font-size:32px;line-height:1.15}
header.top .meta{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:14px;opacity:.95}
nav.toc{background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
nav.toc .wrap{display:flex;gap:4px 18px;flex-wrap:wrap;padding-top:10px;padding-bottom:10px;font-size:14px;font-weight:600}
nav.toc a{color:var(--ink);text-decoration:none;padding:4px 0}
nav.toc a:hover{color:var(--accent)}
section{margin:28px 0}
h2{font-size:22px;margin:0 0 14px}
h3{margin:6px 0 10px;font-size:18px}
h4{margin:14px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:16px}
.verdict{display:flex;flex-wrap:wrap;gap:24px;align-items:center}
.pill{display:inline-flex;align-items:center;gap:6px;font-weight:700;padding:5px 14px;border-radius:99px;font-size:14px}
.pill.pass,.status.pass{background:var(--pass-bg);color:var(--pass)}
.pill.fail,.status.fail{background:var(--fail-bg);color:var(--fail)}
.pill.blocked,.status.blocked{background:var(--blocked-bg);color:var(--blocked)}
.status.muted{background:var(--grey-bg);color:var(--grey)}
.status{display:inline-flex;gap:5px;align-items:center;font-weight:700;font-size:13px;padding:2px 10px;border-radius:99px;white-space:nowrap}
.headline{font-size:20px;font-weight:600;margin:10px 0 0;max-width:760px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-top:18px}
.stat{background:var(--bg);border-radius:12px;padding:12px 14px}
.stat b{display:block;font-size:26px}
.stat span{font-size:13px;color:var(--muted)}
.bar-row{display:grid;grid-template-columns:110px 1fr 28px;gap:10px;align-items:center;font-size:14px;margin:6px 0}
.bar{height:10px;background:var(--grey-bg);border-radius:99px;overflow:hidden}
.bar div{height:100%;border-radius:99px}
.b-crit{background:#c0392b}.b-high{background:#d9822b}.b-med{background:var(--accent)}.b-low{background:#9aa0ad}
.chip{display:inline-block;font-size:12px;font-weight:700;padding:2px 9px;border-radius:99px;background:var(--grey-bg);color:var(--grey);white-space:nowrap}
.prio-high,.p-crit{background:var(--fail-bg);color:var(--fail)}
.p-high{background:var(--blocked-bg);color:var(--blocked)}
.prio-medium,.p-med{background:#e9ecff;color:#2f3d8f}
.sev{background:#fff;border:1px solid var(--line);color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);padding:10px 12px;border-bottom:1px solid var(--line);background:#fafbfc}
td{padding:12px;border-top:1px solid var(--line);vertical-align:top}
.row{cursor:pointer}
.row:hover td{background:#fafbfc}
.row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.detail{display:none}
.case.open .detail{display:table-row}
.detail td{background:#fcfcfd}
.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:20px}
.detail ol,.bug ol{padding-left:20px;margin:4px 0}
.sub{font-size:13px;color:var(--muted)}
.src{font-weight:500;text-transform:none;letter-spacing:0;background:var(--grey-bg);padding:1px 8px;border-radius:6px;margin-left:6px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.muted{color:var(--muted)}
.thumb{max-width:100%;border:1px solid var(--line);border-radius:10px;margin-top:10px}
.filters{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}
.filters select,.filters input{font:inherit;font-size:14px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:#fff;min-height:42px}
.filters input{flex:1 1 220px}
.table-box{overflow-x:auto;background:#fff;border:1px solid var(--line);border-radius:14px}
.bug{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px;margin-bottom:16px}
.bug-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.impact{background:var(--bg);border-radius:10px;padding:12px 14px;margin-bottom:14px}
.impact .label{display:block;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.bug-media{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:12px}
.bug-media img,.bug-media video{width:100%;border-radius:10px;border:1px solid var(--line);background:#000}
.ea{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:16px}
details summary{cursor:pointer;font-weight:600;margin-top:12px;min-height:32px}
ul{margin:4px 0;padding-left:20px}
.flow{counter-reset:s;list-style:none;padding:0;display:grid;gap:8px}
.flow li{counter-increment:s;display:flex;gap:12px;align-items:flex-start;background:var(--bg);padding:10px 12px;border-radius:10px}
.flow li::before{content:counter(s);flex:none;width:26px;height:26px;border-radius:99px;background:var(--brand);color:#fff;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}
footer{padding:30px 0 50px;color:var(--muted);font-size:13px}
@media print{nav.toc{display:none}.detail{display:table-row}.row{cursor:auto}details{display:block}}
</style>
</head>
<body>
<header class="top"><div class="wrap">
<div><div style="font-size:14px;font-weight:600;opacity:.9">Test report</div><h1>${esc(d.understanding.productName)}</h1></div>
<div class="meta"><span>${esc(d.env.url)}</span><span>Version: ${esc(d.env.appVersion)}</span><span>${esc(d.env.executedAt.slice(0, 16).replace('T', ' '))} UTC</span><span>Tester: AI QA Agent (${esc(d.env.model)})</span></div>
</div></header>
<nav class="toc" aria-label="Sections"><div class="wrap">
<a href="#summary">Summary</a><a href="#setup">Scope &amp; setup</a><a href="#users">Users &amp; flow</a><a href="#cases">Test cases</a><a href="#bugs">Bugs (${d.bugs.length})</a><a href="#notes">Notes</a>
</div></nav>
<main class="wrap">

<section id="summary" class="card">
<div class="verdict"><span class="pill ${verdictCls}">${esc(d.verdict)}</span><span class="muted">${executed} executed · pass rate ${passRate}%</span></div>
<p class="headline">${esc(d.summary.headline)}</p>
<div class="stats">
<div class="stat"><b>${d.cases.length}</b><span>Test cases</span></div>
<div class="stat"><b style="color:var(--pass)">${n('pass')}</b><span>Passed</span></div>
<div class="stat"><b style="color:var(--fail)">${n('fail')}</b><span>Failed</span></div>
<div class="stat"><b style="color:var(--blocked)">${n('blocked')}</b><span>Blocked</span></div>
<div class="stat"><b>${n('skipped') + n('not_run')}</b><span>Skipped / not run</span></div>
<div class="stat"><b>${d.bugs.length}</b><span>Bugs</span></div>
</div>
<div class="grid" style="margin-top:20px">
<div><h4>Bugs by priority</h4>${priCounts.map(([p, v]) => bar(p, v, p === 'Blocker' || p === 'Critical' ? 'b-crit' : p === 'High' ? 'b-high' : p === 'Medium' ? 'b-med' : 'b-low')).join('')}</div>
<div><h4>Bugs by severity</h4>${sevCounts.map(([s, v]) => bar(s, v, s.startsWith('S1') ? 'b-crit' : s.startsWith('S2') ? 'b-high' : s.startsWith('S3') ? 'b-med' : 'b-low')).join('')}</div>
<div><h4>Top risks</h4>${ul(d.summary.topRisks.slice(0, 3))}</div>
</div>
</section>

<section id="setup"><h2>Scope, setup and test data</h2><div class="grid">
<div class="card"><h4>Environment</h4><table>
<tr><td>Environment</td><td>${esc(d.env.environment)}</td></tr>
<tr><td>URL</td><td>${esc(d.env.url)}</td></tr>
<tr><td>App version</td><td>${esc(d.env.appVersion)}</td></tr>
<tr><td>Browser</td><td>${esc(d.env.browser)}</td></tr>
<tr><td>Viewports</td><td>${esc(d.env.viewport)}</td></tr>
<tr><td>Depth</td><td>${esc(d.depth)}</td></tr>
</table></div>
<div class="card"><h4>In scope</h4>${ul(d.plan.scopeIn)}<h4>Out of scope</h4>${ul(d.plan.scopeOut)}</div>
<div class="card"><h4>Test data</h4>${ul(d.testData)}<h4>Entry criteria</h4>${ul(d.plan.entryCriteria)}<h4>Exit criteria</h4>${ul(d.plan.exitCriteria)}</div>
</div></section>

<section id="users"><h2>Users and the main journey</h2><div class="grid">
<div class="card"><h4>About the product</h4><p>${esc(d.understanding.summary)}</p><h4>Business goals</h4>${ul(d.understanding.businessGoals)}</div>
<div class="card"><h4>Personas</h4>${d.personas.map((p) => `<p><strong>${esc(p.name)}</strong> <span class="muted">(${esc(p.role)})</span><br>${esc(p.goals)}<br><span class="sub">${esc(p.skills)}</span></p>`).join('')}</div>
<div class="card"><h4>End-to-end flow</h4><ol class="flow">${d.flow.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>
</div></section>

<section id="cases"><h2>Test cases</h2>
<div class="filters">
<input id="q" type="search" placeholder="Search test cases" aria-label="Search test cases">
<select id="f-status" aria-label="Filter by status"><option value="">All statuses</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="blocked">Blocked</option><option value="skipped">Skipped</option><option value="not_run">Not run</option></select>
<select id="f-priority" aria-label="Filter by priority"><option value="">All priorities</option><option>High</option><option>Medium</option><option>Low</option></select>
<select id="f-group" aria-label="Filter by type">${['<option value="">All types</option>', ...GROUP_ORDER.map((g) => `<option value="${g}">${GROUP_LABEL[g]}</option>`)].join('')}</select>
<select id="f-persona" aria-label="Filter by persona"><option value="">All personas</option>${personas.map((p) => `<option>${esc(p)}</option>`).join('')}</select>
</div>
<div class="table-box"><table>
<thead><tr><th>Case #</th><th>Title</th><th>Type</th><th>Priority</th><th>Status</th><th>Bug</th></tr></thead>
${caseRows.join('\n')}
</table></div>
<p class="muted" id="count"></p>
</section>

<section id="bugs"><h2>Bugs</h2>${bugCards.join('\n') || '<div class="card">No bugs found.</div>'}</section>

<section id="notes"><h2>Assumptions, open questions and recommendations</h2><div class="grid">
<div class="card"><h4>Assumptions</h4>${ul(d.plan.assumptions)}<h4>Your answers</h4>${ul(d.clarifications)}</div>
<div class="card"><h4>Recommendations</h4>${ul(d.summary.recommendations)}</div>
<div class="card"><h4>Not tested</h4>${ul(d.summary.notTested)}<h4>Gaps found</h4>${ul(d.understanding.gaps)}</div>
</div></section>
</main>
<footer><div class="wrap">Generated by QA Agent. Every result was observed in a real browser; open the bug files and videos in the same folder for full evidence.</div></footer>
<script>
(function(){
  var rows=[].slice.call(document.querySelectorAll('tbody.case'));
  rows.forEach(function(b){var r=b.querySelector('.row');function t(){b.classList.toggle('open');r.setAttribute('aria-expanded',b.classList.contains('open'))}
    r.addEventListener('click',function(e){if(e.target.tagName!=='A')t()});r.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();t()}})});
  var q=document.getElementById('q'),fs=['status','priority','group','persona'].map(function(k){return[k,document.getElementById('f-'+k)]});
  function apply(){var v=q.value.toLowerCase(),n=0;rows.forEach(function(b){var ok=(!v||b.dataset.text.indexOf(v)>-1);fs.forEach(function(f){if(f[1].value&&b.dataset[f[0]]!==f[1].value)ok=false});b.style.display=ok?'':'none';if(ok)n++});
    document.getElementById('count').textContent='Showing '+n+' of '+rows.length+' test cases';}
  q.addEventListener('input',apply);fs.forEach(function(f){f[1].addEventListener('change',apply)});apply();
  document.querySelectorAll('a[href^="#BUG-"]').forEach(function(a){a.addEventListener('click',function(){var d=document.querySelector(a.getAttribute('href')+' details');if(d)d.open=true})});
})();
</script>
</body>
</html>`;
  const out = mask(html).replace(/__QA_IMG_(\d+)__/g, (_m, i: string) => images[Number(i)] || '');
  await fs.writeFile(path.join(runDir, 'report.html'), out, 'utf8');
}
