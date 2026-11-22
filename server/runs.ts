import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Account, Checkpoint, CheckpointAnswer, Depth, Phase, ProviderId, PublicRunState, RunStatus } from './types.js';
import { maskSecrets } from './security.js';

export const RUNS_DIR = process.env.RUNS_DIR || path.join(os.tmpdir(), 'qa-agent-runs');
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_RUNS || 2);
const CHECKPOINT_TIMEOUT_MS = Number(process.env.CHECKPOINT_TIMEOUT_MIN || 20) * 60_000;
const RUN_TTL_MS = Number(process.env.RUN_TTL_HOURS || 6) * 3_600_000;

export interface RunConfig {
  provider: ProviderId | 'mock';
  model: string;
  apiKey: string;
  url: string;
  depth: Depth;
  notes: string;
  accounts: Account[];
  docsText: string;
  mobile: boolean;
}

export class Run extends EventEmitter {
  readonly id = randomUUID();
  readonly dir: string;
  readonly createdAt = Date.now();
  readonly abort = new AbortController();
  config: RunConfig;
  extraSecrets: string[] = [];
  state: PublicRunState;
  private pending: { id: string; resolve: (a: CheckpointAnswer | null) => void; timer: NodeJS.Timeout } | null = null;
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(config: RunConfig) {
    super();
    this.setMaxListeners(50);
    this.config = config;
    this.dir = path.join(RUNS_DIR, this.id);
    this.state = {
      id: this.id,
      status: 'queued',
      phase: 'learn',
      url: config.url,
      provider: config.provider === 'mock' ? 'anthropic' : config.provider,
      model: config.model,
      depth: config.depth,
      createdAt: this.createdAt,
      queuePosition: 0,
      activity: [],
      checkpoint: null,
      understanding: null,
      personas: [],
      flow: [],
      cases: [],
      bugs: [],
      live: { url: '', action: '' },
      usage: { inputTokens: 0, outputTokens: 0 },
      aiWaitingSince: null,
      error: null,
      reportReady: false,
      verdict: null,
    };
  }

  get secrets(): string[] {
    return [this.config.apiKey, ...this.config.accounts.map((a) => a.password), ...this.extraSecrets].filter(Boolean);
  }

  mask(text: string) {
    return maskSecrets(text, this.secrets);
  }

  /** Coalesces rapid updates into one push to the browser. */
  changed() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('state', this.state);
    }, 120);
  }

  log(text: string) {
    this.state.activity.push({ t: Date.now() - this.createdAt, text: this.mask(text) });
    if (this.state.activity.length > 300) this.state.activity.splice(0, this.state.activity.length - 300);
    this.changed();
  }

  setPhase(p: Phase) {
    this.state.phase = p;
    this.changed();
  }

  setStatus(s: RunStatus) {
    this.state.status = s;
    this.changed();
  }

  live(action: string, url: string) {
    this.state.live = { ...this.state.live, action: this.mask(action), url };
    this.changed();
  }

  stepProgress(step: string | undefined) {
    this.state.live = { ...this.state.live, step };
    this.changed();
  }

  aiWaiting(on: boolean) {
    this.state.aiWaitingSince = on ? Date.now() : null;
    this.changed();
  }

  frame(jpegBase64: string) {
    this.emit('frame', jpegBase64);
  }

  addUsage(u: { inputTokens?: number; outputTokens?: number } | undefined) {
    if (!u) return;
    this.state.usage.inputTokens += u.inputTokens || 0;
    this.state.usage.outputTokens += u.outputTokens || 0;
    this.changed();
  }

  /** Waits for the user. Returns null when the user did not answer in time (the agent then uses its defaults). */
  ask(cp: Checkpoint): Promise<CheckpointAnswer | null> {
    if (this.abort.signal.aborted) return Promise.resolve(null);
    this.state.checkpoint = cp;
    this.setStatus('waiting');
    this.emit('checkpoint', cp);
    return new Promise((resolve) => {
      const done = (a: CheckpointAnswer | null) => {
        clearTimeout(timer);
        this.pending = null;
        this.state.checkpoint = null;
        if (!this.abort.signal.aborted) this.setStatus('running');
        this.abort.signal.removeEventListener('abort', onAbort);
        resolve(a);
      };
      const onAbort = () => done(null);
      this.abort.signal.addEventListener('abort', onAbort);
      const timer = setTimeout(() => {
        this.log('No answer for a while, so I continued with my best guess.');
        done(null);
      }, CHECKPOINT_TIMEOUT_MS);
      this.pending = { id: cp.id, resolve: done, timer };
    });
  }

  answer(checkpointId: string, a: CheckpointAnswer): boolean {
    if (!this.pending || this.pending.id !== checkpointId) return false;
    this.pending.resolve(a);
    return true;
  }

  stop() {
    if (['done', 'failed', 'stopped'].includes(this.state.status)) return;
    this.abort.abort();
    this.log('Stopped by you.');
    this.setStatus('stopped');
  }

  /** Forget the key and passwords as soon as the run no longer needs them. */
  wipeSecrets() {
    this.config.apiKey = '';
    this.config.accounts = this.config.accounts.map((a) => ({ ...a, password: '' }));
    this.extraSecrets = [];
  }
}

// ---------------- store + queue ----------------

const runs = new Map<string, Run>();
const queue: Run[] = [];
let active = 0;
let starter: ((run: Run) => Promise<void>) | null = null;

export function setRunStarter(fn: (run: Run) => Promise<void>) {
  starter = fn;
}

export function getRun(id: string) {
  return runs.get(id);
}

export function createRun(config: RunConfig): Run {
  const run = new Run(config);
  runs.set(run.id, run);
  queue.push(run);
  updateQueuePositions();
  pump();
  return run;
}

function updateQueuePositions() {
  queue.forEach((r, i) => {
    r.state.queuePosition = i + 1;
    r.changed();
  });
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length && starter) {
    const run = queue.shift()!;
    updateQueuePositions();
    if (run.abort.signal.aborted) continue;
    run.state.queuePosition = 0;
    active++;
    run.setStatus('running');
    void starter(run)
      .catch((e) => {
        run.state.error = run.mask(e instanceof Error ? e.message : String(e));
        if (run.state.status !== 'stopped') run.setStatus('failed');
      })
      .finally(() => {
        run.wipeSecrets();
        active--;
        run.changed();
        pump();
      });
  }
}

// Remove old runs and their files.
setInterval(async () => {
  const now = Date.now();
  for (const [id, run] of runs) {
    if (now - run.createdAt > RUN_TTL_MS && !['running', 'waiting', 'queued'].includes(run.state.status)) {
      runs.delete(id);
      await fs.rm(run.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}, 10 * 60_000).unref();
