import express, { type Request, type Response } from 'express';
import multer from 'multer';
import { ZipArchive } from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkKey, PROVIDERS } from './providers.js';
import { createRun, getRun, setRunStarter, type RunConfig } from './runs.js';
import { runPipeline } from './agent/pipeline.js';
import { assertPublicUrl } from './security.js';
import { extractDocsText } from './docs.js';
import type { CheckpointAnswer, Depth, ProviderId } from './types.js';

const PORT = Number(process.env.PORT || 7860);
const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = [path.resolve(here, '../web'), path.resolve(here, '../dist/web')].find((p) => fs.existsSync(path.join(p, 'index.html')));
const MOCK = process.env.ENABLE_MOCK_PROVIDER === 'true';

setRunStarter(runPipeline);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Tiny in-memory rate limiter (per IP), enough for a free single-instance deployment.
const hits = new Map<string, number[]>();
function limited(req: Request, key: string, max: number, windowMs: number) {
  const id = `${key}:${req.ip}`;
  const now = Date.now();
  const list = (hits.get(id) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(id, list);
  return list.length > max;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 5 } });

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mock: MOCK });
});

app.post('/api/check-key', async (req, res) => {
  if (limited(req, 'key', 30, 10 * 60_000)) return res.status(429).json({ ok: false, error: 'Too many tries. Wait a few minutes.', models: [] });
  const { provider, apiKey } = req.body as { provider: ProviderId | 'mock'; apiKey: string };
  if (provider === 'mock' && MOCK) return res.json({ ok: true, models: [{ id: 'mock-qa', label: 'Mock (testing only)' }], recommended: 'mock-qa' });
  if (!PROVIDERS.includes(provider as ProviderId)) return res.status(400).json({ ok: false, error: 'Unknown provider.', models: [] });
  res.json(await checkKey(provider as ProviderId, String(apiKey || '')));
});

/** Quick look at the website so the user knows we can reach it. */
app.post('/api/preview', async (req, res) => {
  if (limited(req, 'preview', 60, 10 * 60_000)) return res.status(429).json({ ok: false, error: 'Too many tries.' });
  try {
    const url = await assertPublicUrl(String(req.body?.url || ''));
    let current = url;
    let html = '';
    for (let i = 0; i < 4; i++) {
      const r = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 QA-Agent-Preview' } });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        current = await assertPublicUrl(new URL(r.headers.get('location')!, current).toString());
        continue;
      }
      html = (await r.text()).slice(0, 300_000);
      break;
    }
    const title = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.trim() || current.host;
    const themeColor = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-f]{3,8})["']/i)?.[1] || null;
    res.json({ ok: true, host: current.host, title: title.replace(/&amp;/g, '&').replace(/&#39;/g, "'"), themeColor });
  } catch (e) {
    res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/runs', upload.array('docs', 5), async (req, res) => {
  if (limited(req, 'runs', 6, 60 * 60_000)) return res.status(429).json({ error: 'You started many tests in the last hour. Please wait a bit.' });
  try {
    const body = JSON.parse(String(req.body?.config || '{}'));
    const provider = body.provider as ProviderId | 'mock';
    if (!(PROVIDERS as string[]).includes(provider) && !(provider === 'mock' && MOCK)) throw new Error('Pick an AI provider.');
    if (!body.apiKey && provider !== 'mock') throw new Error('Add your API key.');
    if (!body.model) throw new Error('Pick a model.');
    const url = await assertPublicUrl(String(body.url || ''));
    const files = (req.files as Express.Multer.File[] | undefined) || [];
    const config: RunConfig = {
      provider,
      model: String(body.model),
      apiKey: String(body.apiKey || ''),
      url: url.toString(),
      depth: (['quick', 'standard', 'deep'].includes(body.depth) ? body.depth : 'standard') as Depth,
      notes: String(body.notes || '').slice(0, 2000),
      accounts: (Array.isArray(body.accounts) ? body.accounts : [])
        .slice(0, 6)
        .map((a: { role?: string; username?: string; password?: string }) => ({
          role: String(a.role || '').trim().slice(0, 60),
          username: String(a.username || '').trim().slice(0, 200),
          password: String(a.password || '').slice(0, 200),
        }))
        .filter((a: { role: string; username: string }) => a.role && a.username),
      docsText: files.length ? await extractDocsText(files) : '',
      mobile: Boolean(body.mobile),
    };
    const run = createRun(config);
    res.json({ id: run.id });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/runs/:id', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'This test was not found. Tests are kept for a few hours.' });
  res.json(run.state);
});

app.get('/api/runs/:id/events', (req: Request<{ id: string }>, res: Response) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event: string, data: string) => res.write(`event: ${event}\ndata: ${data}\n\n`);
  send('state', JSON.stringify(run.state));
  const onState = () => send('state', JSON.stringify(run.state));
  const onFrame = (f: string) => send('frame', f);
  run.on('state', onState);
  run.on('frame', onFrame);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    run.off('state', onState);
    run.off('frame', onFrame);
  });
});

app.post('/api/runs/:id/answer', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  const { checkpointId, answer } = req.body as { checkpointId: string; answer: CheckpointAnswer };
  if (!run.answer(checkpointId, answer)) return res.status(409).json({ error: 'This question was already answered.' });
  res.json({ ok: true });
});

app.post('/api/runs/:id/stop', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  run.stop();
  res.json({ ok: true });
});

app.get('/api/runs/:id/download.zip', (req, res) => {
  const run = getRun(req.params.id);
  if (!run || !run.state.reportReady) return res.status(404).send('Report not ready');
  const host = new URL(run.state.url).host.replace(/[^a-z0-9.-]/gi, '');
  res.attachment(`qa-report-${host}-${new Date(run.createdAt).toISOString().slice(0, 10)}.zip`);
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.on('error', () => res.end());
  zip.pipe(res);
  zip.glob('**/*', { cwd: run.dir, ignore: ['evidence/videos/_raw/**'] });
  void zip.finalize();
});

// Report, bug files and evidence. The report is our own generated HTML; sandbox it anyway.
app.get('/api/runs/:id/files/*path', (req, res) => {
  const run = getRun(req.params.id as string);
  if (!run) return res.status(404).send('Not found');
  const rel = ([] as string[]).concat((req.params as { path: string | string[] }).path).join('/');
  const file = path.resolve(run.dir, rel);
  if (!file.startsWith(run.dir + path.sep) || rel.includes('_raw') || !fs.existsSync(file)) return res.status(404).send('Not found');
  if (file.endsWith('.html')) res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-popups allow-downloads; default-src 'none'; img-src data:; media-src *; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  if (file.endsWith('.md')) res.type('text/markdown; charset=utf-8');
  res.sendFile(file, { dotfiles: 'allow' });
});

if (WEB_DIR) {
  app.use(express.static(WEB_DIR, { index: false, maxAge: '1h' }));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`QA Agent listening on http://localhost:${PORT}${MOCK ? ' (mock provider enabled)' : ''}`);
});
