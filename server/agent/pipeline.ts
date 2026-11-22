import fs from 'node:fs/promises';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { BrowserSession } from '../browser.js';
import { createModel } from '../providers.js';
import type { Run } from '../runs.js';
import { GROUP_LABEL, GROUP_ORDER, type Brand, type Bug, type CaseGroup, type EnvInfo, type TestCase } from '../types.js';
import { DEPTH_BUDGET, GROUP_GUIDE, ROLE, runContext, understandingText, type RunContextInput } from './prompts.js';
import { bugSchema, casesSchema, exploreSchema, flowSchema, learnSchema, personasSchema, planSchema, summarySchema } from './schemas.js';
import { structured, toolLoop, type LlmCtx } from './llm.js';
import { writeBugFile } from '../report/bugs.js';
import { writePlanFile } from '../report/plan.js';
import { writeHtmlReport, type ReportData } from '../report/html.js';

type Plan = z.infer<typeof planSchema>;
type Explore = z.infer<typeof exploreSchema>;
interface CaseRunInfo {
  consoleErrors: string[];
  failedRequests: string[];
  reproducibility: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
const list = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join('\n');

export async function runPipeline(run: Run) {
  const cfg = run.config;
  const budget = DEPTH_BUDGET[cfg.depth];
  const baseUrl = new URL(cfg.url);
  await fs.mkdir(path.join(run.dir, 'evidence', 'screenshots'), { recursive: true });
  await fs.mkdir(path.join(run.dir, 'bugs'), { recursive: true });

  const secrets: Record<string, string> = {};
  for (const a of cfg.accounts) if (a.password) secrets[a.role] = a.password;

  const model = createModel(cfg.provider, cfg.apiKey, cfg.model);
  const session = new BrowserSession({
    runDir: run.dir,
    baseUrl,
    secrets,
    signal: run.abort.signal,
    onFrame: (f) => run.frame(f),
    onAction: (text, url) => run.live(text, url),
  });

  const input: RunContextInput = {
    url: cfg.url,
    depth: cfg.depth,
    notes: cfg.notes,
    accounts: cfg.accounts.filter((a) => a.role.trim()),
    extraData: [],
    docsText: cfg.docsText,
    clarifications: [],
  };
  const ctx = (): LlmCtx => ({
    model,
    run,
    instructions: `${ROLE}\n\n${runContext(input)}\n\n${understandingText(run.state.understanding, run.state.personas)}`,
  });

  let brand: Brand | null = null;
  let appVersion = 'Not exposed';
  let plan: Plan | null = null;
  let explore: Explore | null = null;
  const caseInfo = new Map<string, CaseRunInfo>();
  const startedAt = new Date();

  try {
    // ================= LEARN =================
    run.setPhase('learn');
    run.log(`Opening ${baseUrl.host}…`);
    await session.launch();
    await session.newContext({ video: false, viewport: { width: 1440, height: 900 } });
    try {
      await session.page!.goto(baseUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
      await session.page!.waitForTimeout(800);
    } catch (e) {
      throw new Error(`Could not open ${baseUrl.host}. Check that the link works and is public. (${e instanceof Error ? e.message.split('\n')[0] : e})`);
    }
    brand = await session.extractBrand();
    appVersion = await session.detectVersion();

    run.log('Reading your website as a new visitor…');
    const exploreRes = await toolLoop(
      ctx(),
      'learn_explore',
      `Explore ${cfg.url} to understand the business. Visit the home page, the main navigation, and pages such as pricing, about, help/FAQ, terms, sign-up and login if they exist (up to ${budget.explorePages} pages).
Do NOT submit forms or create accounts in this step.
When you are done, reply with detailed notes: what the product does, who it is for, the main features and screens (with their exact names), the business goals you can infer, the critical user journeys, and anything that conflicts with the documentation.`,
      session.tools(),
      budget.exploreSteps,
    );
    const pages = exploreRes.toolCalls.filter((c) => c.toolName === 'navigate' || c.toolName === 'click').length;
    run.log(`Explored the website (${pages} pages and actions)${cfg.docsText ? ' and read your documents' : ''}.`);

    const learned = await structured(
      ctx(),
      'learn_summary',
      `Your exploration notes:\n${exploreRes.text || '(no notes)'}\n\nSummarize your understanding of the business. List gaps or conflicts. Ask only questions whose answers change what you will test (0-4).`,
      learnSchema,
    );
    run.state.understanding = {
      productName: learned.productName,
      summary: learned.summary,
      audience: learned.audience,
      businessGoals: learned.businessGoals,
      criticalJourneys: learned.criticalJourneys,
      glossary: learned.glossary,
      gaps: learned.gaps,
    };
    run.log(`Understood ${learned.productName}: ${learned.businessGoals.slice(0, 3).join(', ')}.`);

    if (learned.questions.length) {
      const questions = learned.questions.slice(0, 4).map((q, i) => ({ id: `q${i}`, ...q }));
      const ans = await run.ask({ id: `cp-questions`, kind: 'questions', title: 'A few quick questions', questions });
      for (const q of questions) {
        const a = ans && ans.kind === 'questions' && !ans.useDefaults ? ans.answers[q.id]?.trim() || q.defaultAnswer : q.defaultAnswer;
        input.clarifications.push(`${q.question} → ${a}`);
      }
      run.log(ans && ans.kind === 'questions' && !ans.useDefaults ? 'Got your answers.' : 'Used my best guess for the questions.');
    }

    const per = await structured(
      ctx(),
      'personas',
      'Define the customers (personas) of this product: who they are, their goals, technical skills, habits and likely mistakes. Use the account roles that exist where they fit.',
      personasSchema,
    );
    run.state.personas = per.personas;
    run.log(`Defined ${per.personas.length} types of users: ${per.personas.map((p) => p.name).join(', ')}.`);

    const flowOut = await structured(
      ctx(),
      'flow',
      'Write the full end-to-end flow of the main journey as numbered user steps, from first visit to the business goal. Then list any inputs still missing to run it (accounts for roles that are not given, test payment data, etc.).',
      flowSchema,
    );
    const needed = flowOut.needed.slice(0, 6).map((n, i) => ({ id: `n${i}`, label: n.label, secret: n.secret }));
    const flowAns = await run.ask({ id: 'cp-flow', kind: 'flow', title: 'Is this the main journey of your website?', steps: flowOut.steps, needed });
    let steps = flowOut.steps;
    if (flowAns && flowAns.kind === 'flow' && !flowAns.useDefaults) {
      const edited = flowAns.steps.map((s) => s.trim()).filter(Boolean);
      if (edited.length) steps = edited;
      for (const n of needed) {
        const v = flowAns.values[n.id]?.trim();
        if (!v) continue;
        if (n.secret) {
          secrets[n.label] = v;
          run.extraSecrets.push(v);
          input.extraData.push(`${n.label}: type it with {{secret:${n.label}}}`);
        } else input.extraData.push(`${n.label}: ${v}`);
      }
    }
    run.state.flow = steps;
    run.log('Main journey confirmed. Following it to check nothing is missing…');

    await session.newContext({ video: false, viewport: { width: 1440, height: 900 } });
    const ex = await toolLoop(
      ctx(),
      'explore_flow',
      `Run this end-to-end flow as an exploratory session, then deviate a little the way the personas would (wrong input, back button, double click):
${list(steps)}

Stop before any real payment or destructive confirmation. When finished, reply with notes on: steps or screens missing from the flow, unexpected behavior, risky areas, and the exact names of screens and buttons.`,
      session.tools(),
      budget.exploreSteps,
    );
    explore = await structured(ctx(), 'explore_summary', `Your exploratory session notes:\n${ex.text || '(no notes)'}`, exploreSchema);
    if (explore.candidateIssues.length) run.log(`Noticed ${explore.candidateIssues.length} things worth testing closely.`);

    // ================= PLAN =================
    run.setPhase('plan');
    run.log('Writing the test plan…');
    plan = await structured(
      ctx(),
      'plan',
      `Write the test plan essentials. Confirmed flow:\n${list(steps)}\nExploration findings:\n- ${[...explore.notes, ...explore.risks].join('\n- ')}`,
      planSchema,
    );

    const groups: CaseGroup[] = cfg.depth === 'quick' ? ['happy'] : GROUP_ORDER;
    const cases: TestCase[] = [];
    for (const g of groups) {
      run.log(`Writing ${GROUP_LABEL[g].toLowerCase()} test cases…`);
      const out = await structured(
        ctx(),
        `cases_${g}`,
        `${GROUP_GUIDE[g]}
Write ${budget.groups[g]} test cases for this group only. Link each to a persona and perform steps as that persona would. Base expected results on the documentation and acceptance criteria first, then on your understanding, and say which in "source".
Confirmed main flow:
${list(steps)}
Risks and findings:
- ${[...(explore?.risks ?? []), ...(explore?.candidateIssues ?? [])].join('\n- ') || 'none'}
${cases.length ? `Already written (do not repeat):\n${cases.map((c) => `- ${c.title}`).join('\n')}` : ''}`,
        casesSchema,
      );
      for (const c of out.cases) {
        cases.push({
          ...c,
          id: `TC-${String(cases.length + 1).padStart(3, '0')}`,
          group: g,
          include: true,
          status: 'not_run',
        });
      }
      run.state.cases = [...cases];
      run.changed();
    }
    run.log(`Wrote ${cases.length} test cases.`);

    const casesAns = await run.ask({ id: 'cp-cases', kind: 'cases', title: "Here's what I'll test", cases });
    if (casesAns && casesAns.kind === 'cases' && !casesAns.useDefaults) {
      for (const edit of casesAns.cases) {
        const c = cases.find((x) => x.id === edit.id);
        if (!c) continue;
        if (edit.expected.trim() && edit.expected.trim() !== c.expected) {
          c.expected = edit.expected.trim();
          c.source = 'Confirmed by you';
          c.unsure = false;
        }
        c.include = edit.include;
      }
    }
    for (const c of cases) if (!c.include) { c.status = 'skipped'; c.notes = 'Skipped by you.'; }
    run.state.cases = cases;
    run.changed();

    // ================= TEST =================
    run.setPhase('test');
    let stopped = false;
    for (const g of groups) {
      if (stopped) break;
      for (const c of cases.filter((x) => x.group === g && x.status === 'not_run')) {
        await executeCase(c);
      }
      const failedHappy = cases.filter((x) => x.group === 'happy' && x.status === 'fail');
      if (g === 'happy' && failedHappy.length && groups.length > 1) {
        const gate = await run.ask({
          id: 'cp-gate',
          kind: 'gate',
          title: 'The main journey has a problem',
          failed: failedHappy.map((c) => ({ id: c.id, title: c.title, actual: c.actual || '' })),
        });
        const decision = gate && gate.kind === 'gate' ? gate.decision : 'continue';
        if (decision === 'stop') {
          stopped = true;
          for (const c of cases) if (c.status === 'not_run') c.notes = 'Not run: you stopped after the main journey failed.';
          run.log('Stopping here as you asked, and building the report.');
        } else if (decision === 'skip_related') {
          const features = new Set(failedHappy.map((c) => c.feature.toLowerCase()));
          for (const c of cases) {
            if (c.status === 'not_run' && features.has(c.feature.toLowerCase())) {
              c.status = 'skipped';
              c.notes = `Skipped: depends on ${failedHappy.filter((f) => f.feature.toLowerCase() === c.feature.toLowerCase()).map((f) => f.id).join(', ')}, which failed.`;
            }
          }
          run.log('Skipping tests that depend on the failed journey.');
        } else run.log('Continuing with all tests.');
        run.changed();
      }
    }

    // ================= REPORT =================
    run.setPhase('report');
    run.log('Writing bug reports…');
    const env: EnvInfo = {
      url: cfg.url,
      environment: /staging|stage|uat|dev|test|preview/i.test(baseUrl.host) ? 'Test / staging' : 'As given (environment not stated)',
      appVersion,
      browser: session.browserVersion(),
      viewport: '1440×900 desktop (phone checks at 390×844)',
      os: 'Linux (server)',
      executedAt: startedAt.toISOString(),
      model: `${cfg.provider} · ${cfg.model}`,
    };
    const bugs: Bug[] = [];
    for (const c of cases.filter((x) => x.status === 'fail')) {
      const info = caseInfo.get(c.id);
      const b = await structured(
        ctx(),
        'bug_report',
        `Write a bug report for this failed test case.
Test case ${c.id}: ${c.title}
Persona: ${c.persona} · Feature: ${c.feature}
Preconditions: ${c.preconditions}
Steps:\n${list(c.steps)}
Test data: ${c.testData}
Expected: ${c.expected}
Actual (observed): ${c.actual}
Agent notes: ${c.notes || '-'}
Console errors: ${info?.consoleErrors.join(' | ') || 'none'}
Failed requests: ${info?.failedRequests.join(' | ') || 'none'}
Set severity (technical impact) and priority (business urgency) independently. The business impact must name the business goal it conflicts with in 1-2 sentences. Reproduction steps must start from opening ${cfg.url}.`,
        bugSchema,
      );
      const id = `BUG-${String(bugs.length + 1).padStart(3, '0')}`;
      const bug: Bug = {
        id,
        file: `bugs/${id}-${slug(b.title)}.md`,
        caseIds: [c.id],
        title: b.title,
        severity: b.severity,
        priority: b.priority,
        businessImpact: b.businessImpact,
        feature: c.feature,
        personas: [c.persona],
        description: b.description,
        expected: b.expected,
        actual: b.actual,
        steps: b.steps,
        reproducibility: info?.reproducibility || 'Always',
        consoleErrors: info?.consoleErrors || [],
        failedRequests: info?.failedRequests || [],
        screenshot: c.screenshot,
        video: c.video,
      };
      c.bugId = bug.id;
      bugs.push(bug);
      await writeBugFile(run.dir, bug, env, c, run.mask.bind(run));
      run.state.bugs = [...bugs];
      run.changed();
    }
    const order = ['Blocker', 'Critical', 'High', 'Medium', 'Low'];
    bugs.sort((a, b) => order.indexOf(a.priority) - order.indexOf(b.priority));

    run.log('Writing the report…');
    const counts = countStatuses(cases);
    const summary = await structured(
      ctx(),
      'summary',
      `Results: ${JSON.stringify(counts)}.
Bugs:\n${bugs.map((b) => `- ${b.id} [${b.priority} / ${b.severity}] ${b.title} — ${b.businessImpact}`).join('\n') || 'none'}
Not run or skipped:\n${cases.filter((c) => c.status === 'skipped' || c.status === 'not_run' || c.status === 'blocked').map((c) => `- ${c.id} ${c.title}: ${c.notes || c.actual || ''}`).join('\n') || 'none'}
Plan scope out: ${plan.scopeOut.join('; ') || 'none'}
Write the executive summary for the business.`,
      summarySchema,
    );
    const verdict = computeVerdict(cases, bugs);
    run.state.verdict = verdict;
    run.state.bugs = bugs;

    const data: ReportData = {
      runId: run.id,
      understanding: run.state.understanding!,
      personas: run.state.personas,
      flow: run.state.flow,
      plan,
      explore,
      cases,
      bugs,
      env,
      brand: brand!,
      summary,
      verdict,
      clarifications: input.clarifications,
      testData: [
        ...input.accounts.map((a) => `Account "${a.role}": ${a.username} / ••••••`),
        ...input.extraData.map((d) => d.replace(/\{\{secret:[^}]+\}\}/g, '••••••')),
      ],
      depth: cfg.depth,
    };
    await writePlanFile(run.dir, data, run.mask.bind(run));
    await writeHtmlReport(run.dir, data, run.mask.bind(run));
    run.state.reportReady = true;
    run.log(`Done. ${counts.pass} passed, ${counts.fail} failed, ${bugs.length} bug${bugs.length === 1 ? '' : 's'}.`);
    run.setStatus('done');
  } finally {
    for (const k of Object.keys(secrets)) delete secrets[k];
    await session.close();
    await fs.rm(path.join(run.dir, 'evidence', 'videos', '_raw'), { recursive: true, force: true }).catch(() => {});
  }

  // ---------------- one test case ----------------
  async function executeCase(c: TestCase) {
    c.status = 'running';
    run.log(`Testing ${c.id}: ${c.title}`);
    run.changed();
    const outcomes: { status: 'pass' | 'fail' | 'blocked'; actual: string; notes?: string }[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (run.abort.signal.aborted) throw new Error('Run stopped');
      let result: { status: 'pass' | 'fail' | 'blocked'; actual: string; notes?: string } | null = null;
      const report_result = tool({
        description: 'Report the result of this test case. Call it exactly once, at the end.',
        inputSchema: z.object({
          status: z.enum(['pass', 'fail', 'blocked']),
          actual: z.string().describe('What actually happened. Be specific: quote messages, values and page names.'),
          notes: z.string().optional().describe('Anything else useful, e.g. why it was blocked'),
        }),
        execute: async (r) => {
          result = r;
          return 'Recorded.';
        },
      });
      const label = attempt === 1 ? c.id : `${c.id}-retry`;
      await session.newContext({ video: true, viewport: { width: 1440, height: 900 } });
      try {
        await toolLoop(
          ctx(),
          'execute_case',
          `Run this test case in a fresh browser (not logged in). Act as the persona "${c.persona}".
${attempt > 1 ? 'This is a RETRY to check whether the failure is repeatable. Do exactly the same steps.\n' : ''}
Test case ${c.id}: ${c.title}
Group: ${GROUP_LABEL[c.group]}
Preconditions: ${c.preconditions}
Steps:
${list(c.steps)}
Test data: ${c.testData}
Expected result: ${c.expected}

How to work:
1. Start with navigate to ${cfg.url}, then snapshot to see the page.
2. Do the preconditions first (e.g. log in), then each step, the way this persona would.
3. Snapshot after important actions and compare what you see with the expected result.
4. Finish by calling report_result once: "pass" if the actual result matches the expected result, "fail" if it does not (a product bug), "blocked" if the test environment stopped you (missing data, CAPTCHA, page outside scope) rather than a product bug.`,
          { ...session.tools(), report_result },
          budget.caseSteps,
          'report_result',
        );
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (/stopped|API key|rate limit|quota|overloaded|no credit|cannot be used|busy or slow|per-minute limit|daily limit/i.test(m)) {
          await session.closeContext();
          throw e;
        }
        result = { status: 'blocked', actual: `The test could not be completed: ${m}` };
      }
      const shot = await session.screenshot(label);
      const ev = session.takeEvidence();
      const r = result ?? { status: 'blocked' as const, actual: 'The agent could not finish this test within its step limit.' };
      const video = await session.closeContext(r.status === 'fail' ? label : undefined);
      outcomes.push(r);
      if (attempt === 1) {
        c.actual = run.mask(r.actual);
        c.notes = r.notes ? run.mask(r.notes) : undefined;
        c.screenshot = shot;
        c.video = video;
        caseInfo.set(c.id, { consoleErrors: ev.consoleErrors, failedRequests: ev.failedRequests, reproducibility: 'Always (2 of 2)' });
        if (ev.blockedNavigations.length) c.notes = [c.notes, `Blocked navigation outside scope: ${ev.blockedNavigations.join(', ')}`].filter(Boolean).join(' ');
        if (r.status !== 'fail') break;
        run.log(`${c.id} failed. Running it once more to check it's repeatable…`);
      } else if (r.status === 'pass') {
        caseInfo.get(c.id)!.reproducibility = 'Intermittent (1 of 2)';
        c.notes = [c.notes, 'Failed on the first try and passed on the retry: intermittent.'].filter(Boolean).join(' ');
      }
    }
    c.status = outcomes[0].status;
    c.attempts = outcomes.length;
    run.log(`${c.id} ${c.status === 'pass' ? 'passed' : c.status === 'fail' ? 'failed' : 'was blocked'}.`);
    run.changed();
  }
}

export function countStatuses(cases: TestCase[]) {
  const n = (s: TestCase['status']) => cases.filter((c) => c.status === s).length;
  return { total: cases.length, pass: n('pass'), fail: n('fail'), blocked: n('blocked'), skipped: n('skipped'), not_run: n('not_run') };
}

function computeVerdict(cases: TestCase[], bugs: Bug[]): string {
  const happyFail = cases.some((c) => c.group === 'happy' && c.status === 'fail');
  if (bugs.some((b) => b.priority === 'Blocker' || b.priority === 'Critical') || happyFail) return 'Not ready';
  if (bugs.length || cases.some((c) => c.status === 'blocked')) return 'Ready with risks';
  return 'Ready';
}
