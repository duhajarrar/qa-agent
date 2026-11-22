// A scripted model used ONLY for automated end-to-end tests (ENABLE_MOCK_PROVIDER=true).
// It drives the real browser tools against the demo shop in fixtures/demo-shop, so the whole
// pipeline (browser, checkpoints, evidence, bug files, report) runs without a paid API key.
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModel } from 'ai';

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};
let callId = 0;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] });
const call = (toolName: string, input: unknown) => ({
  content: [{ type: 'tool-call' as const, toolCallId: `call-${++callId}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: undefined },
  usage,
  warnings: [],
});
const json = (o: unknown) => text(JSON.stringify(o));

const CASE = (title: string, persona: string, feature: string, expected: string, steps: string[], unsure = false) => ({
  title, persona, feature, priority: 'High', preconditions: 'None', steps, testData: 'Code SAVE10', expected, source: 'Inferred', unsure,
});

const STRUCTURED: Record<string, unknown> = {
  learn_summary: {
    productName: 'ShopLite',
    summary: 'ShopLite is an online shoe store where shoppers browse products, add them to a cart and check out.',
    audience: 'Online shoppers',
    businessGoals: ['Complete purchases', 'Use discount campaigns'],
    criticalJourneys: ['Browse → add to cart → apply discount → check out'],
    glossary: [{ term: 'Discount code', meaning: 'Promo code that lowers the order total' }],
    gaps: ['No documentation was provided.'],
    questions: [{ question: 'Can guests check out without an account?', suggestions: ['Yes', 'No'], defaultAnswer: 'Yes' }],
  },
  personas: { personas: [{ name: 'First-time shopper', role: 'Guest', goals: 'Buy shoes quickly', skills: 'Mobile-first, low patience', behaviors: 'Double-clicks buttons' }] },
  flow: { steps: ['Open the home page', 'Open Running Shoes', 'Add to cart', 'Apply discount code SAVE10', 'Check out'], needed: [] },
  explore_summary: { notes: ['Cart and discount code field exist'], missingSteps: [], risks: ['Discount calculation'], candidateIssues: ['Total may not change after applying a code'] },
  plan: { scopeIn: ['Browsing', 'Cart', 'Discount codes'], scopeOut: ['Payments'], risks: ['Discount math'], assumptions: ['Guests can check out'], entryCriteria: ['Site reachable'], exitCriteria: ['All happy paths executed'] },
  cases_happy: {
    cases: [
      CASE('Add a product to the cart', 'First-time shopper', 'Cart', 'The cart shows Running Shoes and a total of $80.00.', ['Open the home page', 'Open Running Shoes', 'Click Add to cart']),
      CASE('Apply a valid discount code', 'First-time shopper', 'Discount codes', 'The total drops from $80.00 to $72.00 after applying SAVE10.', ['Add Running Shoes to the cart', 'Open the cart', 'Type SAVE10 in Discount code', 'Click Apply'], true),
    ],
  },
  cases_edge: { cases: [CASE('Open the cart when it is empty', 'First-time shopper', 'Cart', 'The cart says it is empty.', ['Open the cart directly'])] },
  cases_negative: { cases: [CASE('Apply an invalid discount code', 'First-time shopper', 'Discount codes', 'An error says the code is not valid.', ['Open the cart', 'Type WRONG', 'Click Apply'])] },
  cases_nonfunctional: { cases: [CASE('Home page on a phone', 'First-time shopper', 'Home', 'No sideways scrolling at 390 px.', ['Resize to 390x844', 'Open the home page'])] },
  bug_report: {
    title: 'Discount code shows as applied but the order total is not reduced',
    severity: 'S2 Major',
    priority: 'Critical',
    businessImpact: 'Shoppers who use a promo code pay full price, which breaks the "complete a purchase" goal and every discount campaign.',
    description: 'After applying SAVE10 in the cart, the page says the code was applied but the total stays at $80.00.',
    expected: 'Total is $72.00 after applying SAVE10.',
    actual: 'Message "Code SAVE10 applied" is shown, but the total stays $80.00.',
    steps: ['Open the home page', 'Open Running Shoes', 'Click Add to cart', 'Open the cart', 'Type SAVE10 in Discount code', 'Click Apply', 'Look at the total'],
  },
  summary: {
    headline: 'Discount codes do not lower the total, so shoppers pay full price. Fix this before release.',
    topRisks: ['Discount codes do not change the order total'],
    recommendations: ['Fix the discount calculation and re-run the discount tests'],
    notTested: ['Payments (out of scope)'],
  },
};

function promptText(prompt: unknown): { task: string; first: string; toolResults: number; last: string } {
  const msgs = prompt as { role: string; content: unknown }[];
  const user = msgs.find((m) => m.role === 'user');
  const first = JSON.stringify(user?.content ?? '');
  const task = first.match(/TASK: ([a-z_]+)/)?.[1] || '';
  const toolMsgs = msgs.filter((m) => m.role === 'tool');
  return { task, first, toolResults: toolMsgs.length, last: JSON.stringify(toolMsgs.at(-1)?.content ?? '') };
}

function executeCase(first: string, step: number, last: string) {
  const title = first.match(/Test case TC-\d+: ([^\\]+)/)?.[1] || '';
  if (/valid discount/i.test(title) && !/invalid/i.test(title)) {
    const script = [
      () => call('navigate', { url: '/' }),
      () => call('click', { target: { role: 'link', name: 'Running Shoes' } }),
      () => call('click', { target: { role: 'button', name: 'Add to cart' } }),
      () => call('click', { target: { role: 'link', name: 'Cart' } }),
      () => call('fill', { target: { label: 'Discount code' }, value: 'SAVE10' }),
      () => call('click', { target: { role: 'button', name: 'Apply' } }),
      () => call('snapshot', {}),
    ];
    if (step < script.length) return script[step]();
    const ok = last.includes('$72.00');
    return call('report_result', ok
      ? { status: 'pass', actual: 'Total dropped to $72.00.' }
      : { status: 'fail', actual: 'Message "Code SAVE10 applied" is shown, but the total stays $80.00.' });
  }
  if (step === 0) return call('navigate', { url: /empty|cart/i.test(title) ? '/cart.html' : '/' });
  if (step === 1) return call('snapshot', {});
  return call('report_result', { status: 'pass', actual: `Checked "${title}": the page behaved as expected.` });
}

export function createMockModel(): LanguageModel {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      const { task, first, toolResults, last } = promptText(options.prompt);
      await new Promise((r) => setTimeout(r, Number(process.env.MOCK_DELAY_MS || 150)));
      if (task === 'learn_explore' || task === 'explore_flow') {
        if (toolResults === 0) return call('navigate', { url: '/' });
        if (toolResults === 1) return call('snapshot', {});
        return text('ShopLite sells shoes. Home page lists Running Shoes ($80). There is a cart with a Discount code field.');
      }
      if (task === 'execute_case') return executeCase(first, toolResults, last);
      if (task in STRUCTURED) return json(STRUCTURED[task]);
      return json({});
    },
  }) as unknown as LanguageModel;
}
