import { chromium, type Browser, type BrowserContext, type Locator, type Page, type CDPSession } from 'playwright';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isBlockedHostname, maskSecrets } from './security.js';
import type { Brand } from './types.js';

const AUTH_AND_PAYMENT_HOSTS = [
  'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'github.com',
  'auth0.com', 'okta.com', 'clerk.accounts.dev', 'stripe.com', 'paypal.com', 'checkout.com',
];

export interface BrowserSessionOptions {
  runDir: string;
  baseUrl: URL;
  secrets: Record<string, string>; // token name -> value, e.g. "Customer" -> "p@ss"
  signal: AbortSignal;
  onFrame: (jpegBase64: string) => void;
  onAction: (text: string, url: string) => void;
}

export interface CaseEvidence {
  consoleErrors: string[];
  failedRequests: string[];
  blockedNavigations: string[];
}

const targetSchema = z.object({
  role: z.string().optional().describe('ARIA role from the snapshot, e.g. button, link, textbox, checkbox, combobox, heading, menuitem, tab'),
  name: z.string().optional().describe('Accessible name of the element exactly as in the snapshot (used with role)'),
  label: z.string().optional().describe('Form field label text'),
  placeholder: z.string().optional().describe('Input placeholder text'),
  text: z.string().optional().describe('Visible text of the element'),
  css: z.string().optional().describe('CSS selector, only when nothing else works'),
  nth: z.number().int().min(0).optional().describe('0-based index when several elements match'),
});
type Target = z.infer<typeof targetSchema>;

function baseDomain(host: string): string {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  const take = tld.length === 2 && ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'].includes(sld) ? 3 : 2;
  return parts.slice(-take).join('.');
}

export class BrowserSession {
  private browser: Browser | null = null;
  context: BrowserContext | null = null;
  page: Page | null = null;
  private cdp: CDPSession | null = null;
  private lastFrameAt = 0;
  private evidence: CaseEvidence = { consoleErrors: [], failedRequests: [], blockedNavigations: [] };
  readonly scopeDomain: string;
  viewport = { width: 1440, height: 900 };

  constructor(private opts: BrowserSessionOptions) {
    this.scopeDomain = baseDomain(opts.baseUrl.hostname);
  }

  async launch() {
    this.browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  }

  browserVersion() {
    return this.browser ? `Chromium ${this.browser.version()}` : 'Chromium';
  }

  private allowedNavigation(host: string): boolean {
    if (host === this.opts.baseUrl.hostname || host.endsWith('.' + this.scopeDomain) || host === this.scopeDomain) return true;
    return AUTH_AND_PAYMENT_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  }

  /** Opens a fresh browser context (clean cookies) with optional video recording. */
  async newContext(opts: { video: boolean; viewport?: { width: number; height: number } }) {
    await this.closeContext();
    if (!this.browser) await this.launch();
    if (opts.viewport) this.viewport = opts.viewport;
    this.evidence = { consoleErrors: [], failedRequests: [], blockedNavigations: [] };
    const rawDir = path.join(this.opts.runDir, 'evidence', 'videos', '_raw');
    this.context = await this.browser!.newContext({
      viewport: this.viewport,
      ignoreHTTPSErrors: true,
      recordVideo: opts.video ? { dir: rawDir, size: { width: 1024, height: Math.round((1024 * this.viewport.height) / this.viewport.width) } } : undefined,
    });
    this.context.setDefaultTimeout(10000);
    await this.context.route('**/*', async (route) => {
      const req = route.request();
      let u: URL;
      try { u = new URL(req.url()); } catch { return route.continue(); }
      if ((u.protocol === 'http:' || u.protocol === 'https:') && isBlockedHostname(u.hostname)) return route.abort('blockedbyclient');
      if (req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame() && !this.allowedNavigation(u.hostname)) {
        this.evidence.blockedNavigations.push(u.origin);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    this.context.on('page', (p) => { void this.attachPage(p); });
    const page = await this.context.newPage();
    await this.attachPage(page);
  }

  private async attachPage(page: Page) {
    this.page = page;
    page.on('console', (m) => {
      if (m.type() === 'error') this.evidence.consoleErrors.push(this.mask(m.text()).slice(0, 400));
    });
    page.on('pageerror', (e) => this.evidence.consoleErrors.push(this.mask(String(e.message)).slice(0, 400)));
    page.on('response', (r) => {
      if (r.status() >= 400) this.evidence.failedRequests.push(`${r.request().method()} ${this.shortUrl(r.url())} → ${r.status()}`);
    });
    page.on('requestfailed', (r) => {
      const f = r.failure()?.errorText || 'failed';
      if (!f.includes('blockedbyclient') && !f.includes('ERR_ABORTED')) this.evidence.failedRequests.push(`${r.method()} ${this.shortUrl(r.url())} → ${f}`);
    });
    page.on('dialog', (d) => {
      this.opts.onAction(`Dialog: "${d.message().slice(0, 80)}" (accepted)`, page.url());
      void d.accept().catch(() => {});
    });
    await this.startScreencast(page);
  }

  private async startScreencast(page: Page) {
    try {
      if (this.cdp) await this.cdp.detach().catch(() => {});
      const cdp = await page.context().newCDPSession(page);
      this.cdp = cdp;
      cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
        void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
        const now = Date.now();
        if (now - this.lastFrameAt < 300) return; // ~3 fps is plenty for a live view
        this.lastFrameAt = now;
        this.opts.onFrame(f.data);
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 960, maxHeight: 720, everyNthFrame: 1 });
    } catch {
      // Live view is best effort; testing continues without it.
    }
  }

  /** Closes the current context. Returns the saved video path (relative to the run dir) when one was recorded. */
  async closeContext(saveVideoAs?: string): Promise<string | undefined> {
    if (!this.context) return undefined;
    const video = this.page?.video();
    const ctx = this.context;
    this.context = null;
    this.page = null;
    this.cdp = null;
    await ctx.close().catch(() => {});
    if (!video) return undefined;
    try {
      if (saveVideoAs) {
        const rel = path.join('evidence', 'videos', `${saveVideoAs}.webm`);
        await video.saveAs(path.join(this.opts.runDir, rel));
        await video.delete().catch(() => {});
        return rel;
      }
      await video.delete().catch(() => {});
    } catch {
      /* video is best effort */
    }
    return undefined;
  }

  takeEvidence(): CaseEvidence {
    return {
      consoleErrors: [...new Set(this.evidence.consoleErrors)].slice(0, 10),
      failedRequests: [...new Set(this.evidence.failedRequests)].slice(0, 10),
      blockedNavigations: [...new Set(this.evidence.blockedNavigations)],
    };
  }

  async screenshot(name: string): Promise<string | undefined> {
    if (!this.page) return undefined;
    const rel = path.join('evidence', 'screenshots', `${name}.png`);
    try {
      await fs.mkdir(path.join(this.opts.runDir, 'evidence', 'screenshots'), { recursive: true });
      await this.page.screenshot({ path: path.join(this.opts.runDir, rel), fullPage: false, timeout: 10000 });
      return rel;
    } catch {
      return undefined;
    }
  }

  async close() {
    await this.closeContext();
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }

  // ---------------- helpers ----------------

  private mask(s: string) {
    return maskSecrets(s, Object.values(this.opts.secrets));
  }

  private shortUrl(u: string) {
    try {
      const x = new URL(u);
      return (x.origin === this.opts.baseUrl.origin ? '' : x.host) + x.pathname;
    } catch {
      return u.slice(0, 120);
    }
  }

  private resolveSecrets(value: string): string {
    return value.replace(/\{\{secret:([^}]+)\}\}/g, (m, name: string) => this.opts.secrets[name.trim()] ?? m);
  }

  private describe(t: Target) {
    if (t.role) return `${t.role}${t.name ? ` "${t.name}"` : ''}`;
    return t.label ? `field "${t.label}"` : t.placeholder ? `field "${t.placeholder}"` : t.text ? `"${t.text}"` : t.css || 'element';
  }

  private async locate(t: Target): Promise<{ loc: Locator; note: string }> {
    const page = this.requirePage();
    let loc: Locator;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (t.role) loc = page.getByRole(t.role as any, t.name ? { name: t.name } : undefined);
    else if (t.label) loc = page.getByLabel(t.label);
    else if (t.placeholder) loc = page.getByPlaceholder(t.placeholder);
    else if (t.text) loc = page.getByText(t.text);
    else if (t.css) loc = page.locator(t.css);
    else throw new Error('Give a role+name, label, placeholder, text or css to find the element.');
    const count = await loc.count();
    if (count === 0) {
      if (t.role && t.name) {
        const loose = page.getByRole(t.role as any, { name: t.name, exact: false }); // eslint-disable-line @typescript-eslint/no-explicit-any
        if ((await loose.count()) > 0) return { loc: loose.nth(t.nth ?? 0), note: '' };
      }
      throw new Error(`No element found for ${this.describe(t)}. Take a snapshot to see what is on the page now.`);
    }
    const idx = Math.min(t.nth ?? 0, count - 1);
    const note = count > 1 && t.nth === undefined ? ` (${count} elements matched, used the first; pass nth to pick another)` : '';
    return { loc: loc.nth(idx), note };
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('No browser page is open.');
    return this.page;
  }

  private async settle() {
    const page = this.requirePage();
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(350);
  }

  private async state(prefix: string) {
    const page = this.requirePage();
    const title = await page.title().catch(() => '');
    return `${prefix} Now at ${page.url()} — "${title}"`;
  }

  async snapshotText(max = 9000): Promise<string> {
    const page = this.requirePage();
    let snap = '';
    try {
      snap = await page.locator('body').ariaSnapshot({ timeout: 8000 });
    } catch {
      snap = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')) || '';
    }
    snap = this.mask(snap);
    if (snap.length > max) snap = snap.slice(0, max) + `\n… (snapshot cut at ${max} characters; scroll or navigate to see more)`;
    return `URL: ${page.url()}\nTitle: ${await page.title().catch(() => '')}\n\n${snap}`;
  }

  // ---------------- tools for the model ----------------

  tools(): ToolSet {
    const run = async (label: string, fn: () => Promise<string>) => {
      if (this.opts.signal.aborted) throw new Error('Run stopped');
      this.opts.onAction(this.mask(label), this.page?.url() ?? '');
      try {
        return await fn();
      } catch (e) {
        const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
        return `ERROR: ${this.mask(msg)}`;
      }
    };

    return {
      snapshot: tool({
        description: 'Read the current page as an accessibility tree (roles, names, text). Use it before acting and after the page changes.',
        inputSchema: z.object({}),
        execute: async () => run('Reading the page', () => this.snapshotText()),
      }),
      navigate: tool({
        description: 'Open a URL (absolute, or a path relative to the product URL).',
        inputSchema: z.object({ url: z.string() }),
        execute: async ({ url }) =>
          run(`Opening ${url}`, async () => {
            const target = new URL(url, this.opts.baseUrl);
            if (!this.allowedNavigation(target.hostname)) return `ERROR: ${target.hostname} is outside the test scope (${this.scopeDomain}).`;
            await this.requirePage().goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
            await this.settle();
            return this.state('Opened.');
          }),
      }),
      click: tool({
        description: 'Click an element.',
        inputSchema: z.object({ target: targetSchema }),
        execute: async ({ target }) =>
          run(`Clicking ${this.describe(target)}`, async () => {
            const { loc, note } = await this.locate(target);
            await loc.click({ timeout: 8000 });
            await this.settle();
            return this.state(`Clicked${note}.`);
          }),
      }),
      fill: tool({
        description: 'Clear a text field and type a value. To type a password use the token {{secret:<role>}} exactly as given; never guess passwords.',
        inputSchema: z.object({ target: targetSchema, value: z.string() }),
        execute: async ({ target, value }) =>
          run(`Typing into ${this.describe(target)}`, async () => {
            const { loc, note } = await this.locate(target);
            await loc.fill(this.resolveSecrets(value), { timeout: 8000 });
            return `Filled${note}.`;
          }),
      }),
      select_option: tool({
        description: 'Choose an option in a <select> dropdown by its visible label or value.',
        inputSchema: z.object({ target: targetSchema, option: z.string() }),
        execute: async ({ target, option }) =>
          run(`Choosing "${option}"`, async () => {
            const { loc } = await this.locate(target);
            await loc.selectOption({ label: option }).catch(() => loc.selectOption(option));
            await this.settle();
            return this.state('Selected.');
          }),
      }),
      set_checked: tool({
        description: 'Tick or untick a checkbox or radio button.',
        inputSchema: z.object({ target: targetSchema, checked: z.boolean() }),
        execute: async ({ target, checked }) =>
          run(`${checked ? 'Ticking' : 'Unticking'} ${this.describe(target)}`, async () => {
            const { loc } = await this.locate(target);
            await loc.setChecked(checked, { timeout: 8000 });
            return 'Done.';
          }),
      }),
      press_key: tool({
        description: 'Press a keyboard key, e.g. Enter, Tab, Escape, ArrowDown.',
        inputSchema: z.object({ key: z.string() }),
        execute: async ({ key }) =>
          run(`Pressing ${key}`, async () => {
            await this.requirePage().keyboard.press(key);
            await this.settle();
            return this.state(`Pressed ${key}.`);
          }),
      }),
      hover: tool({
        description: 'Move the mouse over an element (e.g. to open a menu).',
        inputSchema: z.object({ target: targetSchema }),
        execute: async ({ target }) =>
          run(`Hovering ${this.describe(target)}`, async () => {
            const { loc } = await this.locate(target);
            await loc.hover({ timeout: 8000 });
            return 'Done.';
          }),
      }),
      scroll: tool({
        description: 'Scroll the page up or down by one screen.',
        inputSchema: z.object({ direction: z.enum(['up', 'down']) }),
        execute: async ({ direction }) =>
          run(`Scrolling ${direction}`, async () => {
            await this.requirePage().mouse.wheel(0, direction === 'down' ? this.viewport.height * 0.8 : -this.viewport.height * 0.8);
            await this.requirePage().waitForTimeout(300);
            return 'Scrolled.';
          }),
      }),
      wait_for_text: tool({
        description: 'Wait until some text appears on the page (max 15 s).',
        inputSchema: z.object({ text: z.string(), timeoutSeconds: z.number().max(15).optional() }),
        execute: async ({ text, timeoutSeconds }) =>
          run(`Waiting for "${text}"`, async () => {
            await this.requirePage().getByText(text).first().waitFor({ timeout: (timeoutSeconds ?? 10) * 1000 });
            return `"${text}" is visible.`;
          }),
      }),
      go_back: tool({
        description: 'Press the browser Back button.',
        inputSchema: z.object({}),
        execute: async () =>
          run('Going back', async () => {
            await this.requirePage().goBack({ timeout: 15000 });
            await this.settle();
            return this.state('Went back.');
          }),
      }),
      reload: tool({
        description: 'Reload the current page (useful for edge cases like refreshing mid-flow).',
        inputSchema: z.object({}),
        execute: async () =>
          run('Reloading the page', async () => {
            await this.requirePage().reload({ timeout: 30000 });
            await this.settle();
            return this.state('Reloaded.');
          }),
      }),
      set_viewport: tool({
        description: 'Resize the browser, e.g. 390x844 for a phone or 1440x900 for desktop.',
        inputSchema: z.object({ width: z.number().int().min(320).max(1920), height: z.number().int().min(480).max(1200) }),
        execute: async ({ width, height }) =>
          run(`Resizing to ${width}×${height}`, async () => {
            this.viewport = { width, height };
            await this.requirePage().setViewportSize({ width, height });
            return `Viewport is now ${width}×${height}.`;
          }),
      }),
      check_console: tool({
        description: 'List console errors, failed network requests and blocked navigations seen so far in this test.',
        inputSchema: z.object({}),
        execute: async () =>
          run('Checking console and network', async () => {
            const ev = this.takeEvidence();
            return JSON.stringify(ev);
          }),
      }),
    };
  }

  // ---------------- product info ----------------

  async extractBrand(): Promise<Brand> {
    const fallback: Brand = { primary: '#6D4AFF', accent: '#FF8A66', background: '#FFFFFF', text: '#1B1340', font: 'Inter, system-ui, sans-serif', logoText: this.opts.baseUrl.hostname };
    const page = this.page;
    if (!page) return fallback;
    try {
      // Passed as a string so build tools cannot inject helpers that do not exist in the page.
      const b = (await page.evaluate(String.raw`(() => {
        const toHex = (c) => {
          const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
          if (!m) return null;
          if (m[4] !== undefined && Number(m[4]) < 0.5) return null;
          return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
        };
        const neutral = (hex) => {
          const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), bl = parseInt(hex.slice(5, 7), 16);
          return Math.max(r, g, bl) - Math.min(r, g, bl) < 24;
        };
        const counts = new Map();
        document.querySelectorAll('button, [role=button], a[class*=btn], a[class*=button], input[type=submit], header, nav').forEach((el) => {
          const hex = toHex(getComputedStyle(el).backgroundColor);
          if (hex && !neutral(hex)) counts.set(hex, (counts.get(hex) || 0) + 1);
        });
        const links = new Map();
        document.querySelectorAll('a').forEach((el) => {
          const hex = toHex(getComputedStyle(el).color);
          if (hex && !neutral(hex)) links.set(hex, (links.get(hex) || 0) + 1);
        });
        const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
        const bodyStyle = getComputedStyle(document.body);
        const buttons = top(counts);
        const linkColors = top(links);
        return {
          primary: buttons[0] || linkColors[0] || null,
          accent: buttons[1] || linkColors.find((c) => c !== buttons[0]) || null,
          background: toHex(bodyStyle.backgroundColor) || '#ffffff',
          text: toHex(bodyStyle.color) || '#1b1340',
          font: bodyStyle.fontFamily,
          title: document.title,
        };
      })()`)) as { primary: string | null; accent: string | null; background: string; text: string; font: string; title: string };
      return {
        primary: b.primary || fallback.primary,
        accent: b.accent || fallback.accent,
        background: b.background,
        text: b.text,
        font: b.font || fallback.font,
        logoText: (b.title || '').split(/[|\-–—:·]/)[0].trim() || fallback.logoText,
      };
    } catch {
      return fallback;
    }
  }

  async detectVersion(): Promise<string> {
    const page = this.page;
    if (!page) return 'Not exposed';
    try {
      const meta = await page.evaluate(() => {
        const m = document.querySelector('meta[name*="version" i], meta[name="generator"], meta[name="build" i]');
        const w = window as unknown as Record<string, unknown>;
        return (m?.getAttribute('content') || (w.__APP_VERSION__ as string) || (w.APP_VERSION as string) || '') as string;
      });
      if (meta) return meta.slice(0, 80);
      for (const p of ['/version', '/api/version', '/version.json', '/health']) {
        const res = await page.request.get(new URL(p, this.opts.baseUrl).toString(), { timeout: 4000, maxRedirects: 0 }).catch(() => null);
        if (res && res.ok() && (res.headers()['content-type'] || '').match(/json|text\/plain/)) {
          const body = (await res.text()).slice(0, 200);
          const v = body.match(/"?(version|build|commit)"?\s*[:=]\s*"?([\w.\-+]+)/i);
          if (v) return `${v[2]} (from ${p})`;
        }
      }
    } catch {
      /* ignore */
    }
    return 'Not exposed';
  }
}
