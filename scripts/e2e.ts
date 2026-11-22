// End-to-end check of the whole pipeline with the scripted mock model and the demo shop.
// Run: npm run e2e
import express from 'express';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PublicRunState, CheckpointAnswer } from '../server/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOP_PORT = 4321;
const APP_PORT = 7861;
const APP = `http://localhost:${APP_PORT}`;

const shop = express();
shop.post('/api/discount', (_req, res) => {
  res.status(500).json({ error: 'discount service down' });
});
shop.use(express.static(path.join(root, 'fixtures/demo-shop')));
const shopServer = shop.listen(SHOP_PORT);

const runsDir = path.join(root, '.e2e-runs');
fs.rmSync(runsDir, { recursive: true, force: true });
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: root,
  env: { ...process.env, PORT: String(APP_PORT), ENABLE_MOCK_PROVIDER: 'true', ALLOW_PRIVATE_URLS: 'true', RUNS_DIR: runsDir },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

async function main() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${APP}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  const key = await (await fetch(`${APP}/api/check-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'mock', apiKey: 'x' }) })).json();
  check(key.ok && key.recommended === 'mock-qa', 'key check returns models');

  const preview = await (await fetch(`${APP}/api/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `http://localhost:${SHOP_PORT}/` }) })).json();
  check(preview.ok && preview.title.includes('ShopLite') && preview.themeColor === '#1f3b73', 'website preview reads title and theme color');

  const form = new FormData();
  form.set('config', JSON.stringify({ provider: 'mock', model: 'mock-qa', apiKey: 'sk-test-secret-123', url: `http://localhost:${SHOP_PORT}/`, depth: 'standard', notes: 'Focus on the cart', accounts: [{ role: 'Customer', username: 'qa@example.com', password: 'hunter2-secret' }] }));
  form.append('docs', new Blob(['# ShopLite PRD\nAC-1: SAVE10 gives 10% off the order total.'], { type: 'text/markdown' }), 'prd.md');
  const created = await (await fetch(`${APP}/api/runs`, { method: 'POST', body: form })).json();
  check(typeof created.id === 'string', 'run created');
  const id = created.id as string;

  const seenCheckpoints: string[] = [];
  let frames = 0;
  const sse = await fetch(`${APP}/api/runs/${id}/events`);
  const reader = sse.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let state: PublicRunState | null = null;
  const answered = new Set<string>();
  const deadline = Date.now() + 240_000;

  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = chunk.match(/^event: (\w+)/m)?.[1];
      const data = chunk.match(/^data: (.*)$/m)?.[1];
      if (ev === 'frame') frames++;
      if (ev !== 'state' || !data) continue;
      state = JSON.parse(data) as PublicRunState;
      const cp = state.checkpoint;
      if (cp && !answered.has(cp.id)) {
        answered.add(cp.id);
        seenCheckpoints.push(cp.kind);
        let answer: CheckpointAnswer;
        if (cp.kind === 'questions') answer = { kind: 'questions', answers: { [cp.questions[0].id]: 'Yes, guests can check out' } };
        else if (cp.kind === 'flow') answer = { kind: 'flow', steps: [...cp.steps, 'See the order confirmation'], values: {} };
        else if (cp.kind === 'cases') answer = { kind: 'cases', cases: cp.cases.map((c) => ({ id: c.id, expected: c.expected, include: !/phone/i.test(c.title) })) };
        else answer = { kind: 'gate', decision: 'continue' };
        await sleep(300);
        await fetch(`${APP}/api/runs/${id}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkpointId: cp.id, answer }) });
      }
      if (['done', 'failed', 'stopped'].includes(state.status)) break;
    }
    if (state && ['done', 'failed', 'stopped'].includes(state.status)) break;
  }
  await reader.cancel().catch(() => {});

  check(state?.status === 'done', `run finished (status ${state?.status}${state?.error ? `: ${state.error}` : ''})`);
  check(seenCheckpoints.join(',') === 'questions,flow,cases,gate', `checkpoints in order: ${seenCheckpoints.join(',')}`);
  check(frames > 3, `live browser frames streamed (${frames})`);
  const cases = state?.cases ?? [];
  const order = cases.map((c) => c.group);
  check(order.indexOf('happy') === 0 && order.lastIndexOf('happy') < order.indexOf('edge') && order.indexOf('edge') < order.indexOf('negative'), 'cases ordered happy → edge → negative');
  const disc = cases.find((c) => /valid discount/i.test(c.title) && !/invalid/i.test(c.title));
  check(disc?.status === 'fail' && disc.attempts === 2, 'discount case fails and was retried');
  check(cases.find((c) => /phone/i.test(c.title))?.status === 'skipped', 'case excluded by the user is skipped');
  check(cases.filter((c) => c.status === 'pass').length >= 3, 'other cases pass');
  check(state?.bugs.length === 1 && state.bugs[0].priority === 'Critical', 'one Critical bug reported');
  check(state?.verdict === 'Not ready', 'verdict is Not ready');
  check(state?.flow.at(-1) === 'See the order confirmation', 'flow edit was applied');

  const dir = path.join(runsDir, id);
  const report = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
  check(report.includes('ShopLite') && report.includes('BUG-001') && report.includes('data:image/png;base64'), 'report has product, bug and embedded screenshots');
  check(report.includes('--brand:#1f3b73'), 'report uses the product brand color');
  check(!report.includes('hunter2-secret') && !report.includes('sk-test-secret-123'), 'no secrets in report');
  const bugFile = fs.readdirSync(path.join(dir, 'bugs'))[0];
  const bugMd = fs.readFileSync(path.join(dir, 'bugs', bugFile), 'utf8');
  check(/Severity \| S2 Major/.test(bugMd) && /Business impact/.test(bugMd) && /discount/i.test(bugMd), 'bug file has severity, priority and business impact');
  check(/\/api\/discount → 500/.test(bugMd), 'bug file lists the failed network request');
  check(fs.existsSync(path.join(dir, 'test-plan.md')), 'test-plan.md written');
  const videos = fs.readdirSync(path.join(dir, 'evidence', 'videos')).filter((f) => f.endsWith('.webm'));
  check(videos.some((v) => v.startsWith(disc?.id ?? 'x')), `video saved for the failed case (${videos.join(', ')})`);
  check(!fs.existsSync(path.join(dir, 'evidence', 'videos', '_raw')), 'raw video folder cleaned up');

  const zip = await fetch(`${APP}/api/runs/${id}/download.zip`);
  const zipBuf = Buffer.from(await zip.arrayBuffer());
  check(zip.ok && zipBuf.subarray(0, 2).toString() === 'PK' && zipBuf.length > 10_000, `zip download works (${zipBuf.length} bytes)`);
  const rep = await fetch(`${APP}/api/runs/${id}/files/report.html`);
  check(rep.ok && (rep.headers.get('content-security-policy') || '').includes('sandbox'), 'report served sandboxed');
  const trav = await fetch(`${APP}/api/runs/${id}/files/..%2F..%2Fetc%2Fpasswd`);
  check(trav.status === 404, 'path traversal blocked');

  fs.mkdirSync(path.join(root, '.e2e-output'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'report.html'), path.join(root, '.e2e-output', 'report.html'));
  fs.copyFileSync(path.join(dir, 'bugs', bugFile), path.join(root, '.e2e-output', bugFile));
  console.log(`\n${failures ? `${failures} check(s) failed` : 'All checks passed'}. Usage: ${JSON.stringify(state?.usage)}`);
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    server.kill();
    shopServer.close();
    process.exit(failures ? 1 : 0);
  });
