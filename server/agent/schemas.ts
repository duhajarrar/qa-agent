import { z } from 'zod';

// Models (especially free/small ones) often leave out fields or send slightly wrong types.
// These helpers fill sensible defaults instead of failing the whole run over one missing field.
const str = (d = '') => z.string().default(d);
const strs = () => z.array(z.string()).default([]);
const bool = (d = false) => z.boolean().default(d);

export const learnSchema = z.object({
  productName: str('The product').describe('Product name as the business uses it'),
  summary: str().describe('2-4 sentences: what the product does and for whom'),
  audience: str(),
  businessGoals: strs().describe('Main business goals, e.g. sign-ups, bookings, payments'),
  criticalJourneys: strs().describe('User journeys that serve the business goals'),
  glossary: z.array(z.object({ term: str(), meaning: str() })).default([]).describe('Terms the product uses'),
  gaps: strs().describe('Gaps or conflicts between docs, the live product and public info'),
  questions: z
    .array(
      z.object({
        question: str().describe('A short clarification question for the product owner'),
        suggestions: strs().describe('2-3 short likely answers the user can click'),
        defaultAnswer: str().describe('The answer you will assume if the user does not reply'),
      }),
    )
    .default([])
    .describe('Only questions whose answer changes what you test. 0-4 questions.'),
});

export const personasSchema = z.object({
  personas: z
    .array(
      z.object({
        name: str('User').describe('Short persona name, e.g. "First-time shopper"'),
        role: str('Guest').describe('Account role used to log in, or "Guest"'),
        goals: str(),
        skills: str().describe('Technical skill, device habits, patience, language'),
        behaviors: str().describe('Likely mistakes and edge behavior'),
      }),
    )
    .default([])
    .describe('2-5 personas'),
});

export const flowSchema = z.object({
  steps: strs().describe('The main end-to-end journey as 5-12 short user steps, from first visit to the business goal'),
  needed: z
    .array(z.object({ label: str().describe('What you need, e.g. "Store admin password"'), secret: bool() }))
    .default([])
    .describe('Inputs still missing to run the flow (accounts per role, test payment data, etc.). Empty if nothing is missing.'),
});

export const exploreSchema = z.object({
  notes: strs().describe('What you observed while following the flow'),
  missingSteps: strs().describe('Steps or screens missing from the flow'),
  risks: strs().describe('Areas that look risky and deserve more tests'),
  candidateIssues: strs().describe('Unexpected behavior worth a test case'),
});

export const planSchema = z.object({
  scopeIn: strs(),
  scopeOut: strs(),
  risks: strs(),
  assumptions: strs(),
  entryCriteria: strs(),
  exitCriteria: strs(),
});

export const casesSchema = z.object({
  cases: z
    .array(
      z.object({
        title: str('Untitled test').describe('Short title in business terms'),
        persona: str('User').describe('One of the persona names'),
        feature: str('General').describe('Feature or screen name in business terms'),
        priority: z.enum(['High', 'Medium', 'Low']).catch('Medium'),
        preconditions: str(),
        steps: strs().describe('Numbered user steps, concrete and observable'),
        testData: str().describe('Inputs used. Use {{secret:<Role>}} for passwords of listed accounts, never real values'),
        expected: str().describe('Specific, observable expected result'),
        source: str('Inferred').describe('Where the expected result comes from: an acceptance criterion id, "Docs", or "Inferred"'),
        unsure: bool().describe('true when you are not confident about the expected result'),
      }),
    )
    .default([]),
});

export const bugSchema = z.object({
  title: str('Unexpected behavior').describe('Short title anyone can understand without reading details, in the business terms'),
  severity: z.enum(['S1 Critical', 'S2 Major', 'S3 Minor', 'S4 Trivial']).catch('S3 Minor'),
  priority: z.enum(['Blocker', 'Critical', 'High', 'Medium', 'Low']).catch('Medium'),
  businessImpact: str().describe('1-2 sentences: which business goal or critical journey this breaks and why it gets this severity/priority'),
  description: str().describe('What happens, where, and why it matters'),
  expected: str(),
  actual: str(),
  steps: strs().describe('Full reproduction steps starting from opening the product URL'),
});

export const summarySchema = z.object({
  headline: str().describe('One sentence verdict in plain business language'),
  topRisks: strs().describe('Top 3 risks in plain business language'),
  recommendations: strs(),
  notTested: strs().describe('Areas not tested and why'),
});
