import { z } from 'zod';

export const learnSchema = z.object({
  productName: z.string().describe('Product name as the business uses it'),
  summary: z.string().describe('2-4 sentences: what the product does and for whom'),
  audience: z.string(),
  businessGoals: z.array(z.string()).describe('Main business goals, e.g. sign-ups, bookings, payments'),
  criticalJourneys: z.array(z.string()).describe('User journeys that serve the business goals'),
  glossary: z.array(z.object({ term: z.string(), meaning: z.string() })).describe('Terms the product uses'),
  gaps: z.array(z.string()).describe('Gaps or conflicts between docs, the live product and public info'),
  questions: z
    .array(
      z.object({
        question: z.string().describe('A short clarification question for the product owner'),
        suggestions: z.array(z.string()).describe('2-3 short likely answers the user can click'),
        defaultAnswer: z.string().describe('The answer you will assume if the user does not reply'),
      }),
    )
    .describe('Only questions whose answer changes what you test. 0-4 questions.'),
});

export const personasSchema = z.object({
  personas: z
    .array(
      z.object({
        name: z.string().describe('Short persona name, e.g. "First-time shopper"'),
        role: z.string().describe('Account role used to log in, or "Guest"'),
        goals: z.string(),
        skills: z.string().describe('Technical skill, device habits, patience, language'),
        behaviors: z.string().describe('Likely mistakes and edge behavior'),
      }),
    )
    .describe('2-5 personas'),
});

export const flowSchema = z.object({
  steps: z.array(z.string()).describe('The main end-to-end journey as 5-12 short user steps, from first visit to the business goal'),
  needed: z
    .array(z.object({ label: z.string().describe('What you need, e.g. "Store admin password"'), secret: z.boolean() }))
    .describe('Inputs still missing to run the flow (accounts per role, test payment data, etc.). Empty if nothing is missing.'),
});

export const exploreSchema = z.object({
  notes: z.array(z.string()).describe('What you observed while following the flow'),
  missingSteps: z.array(z.string()).describe('Steps or screens missing from the flow'),
  risks: z.array(z.string()).describe('Areas that look risky and deserve more tests'),
  candidateIssues: z.array(z.string()).describe('Unexpected behavior worth a test case'),
});

export const planSchema = z.object({
  scopeIn: z.array(z.string()),
  scopeOut: z.array(z.string()),
  risks: z.array(z.string()),
  assumptions: z.array(z.string()),
  entryCriteria: z.array(z.string()),
  exitCriteria: z.array(z.string()),
});

export const casesSchema = z.object({
  cases: z.array(
    z.object({
      title: z.string().describe('Short title in business terms'),
      persona: z.string().describe('One of the persona names'),
      feature: z.string().describe('Feature or screen name in business terms'),
      priority: z.enum(['High', 'Medium', 'Low']),
      preconditions: z.string(),
      steps: z.array(z.string()).describe('Numbered user steps, concrete and observable'),
      testData: z.string().describe('Inputs used. Use {{secret:<Role>}} for passwords, never real values'),
      expected: z.string().describe('Specific, observable expected result'),
      source: z.string().describe('Where the expected result comes from: an acceptance criterion id, "Docs", or "Inferred"'),
      unsure: z.boolean().describe('true when you are not confident about the expected result'),
    }),
  ),
});

export const bugSchema = z.object({
  title: z.string().describe('Short title anyone can understand without reading details, in the business terms'),
  severity: z.enum(['S1 Critical', 'S2 Major', 'S3 Minor', 'S4 Trivial']),
  priority: z.enum(['Blocker', 'Critical', 'High', 'Medium', 'Low']),
  businessImpact: z.string().describe('1-2 sentences: which business goal or critical journey this breaks and why it gets this severity/priority'),
  description: z.string().describe('What happens, where, and why it matters'),
  expected: z.string(),
  actual: z.string(),
  steps: z.array(z.string()).describe('Full reproduction steps starting from opening the product URL'),
});

export const summarySchema = z.object({
  headline: z.string().describe('One sentence verdict in plain business language'),
  topRisks: z.array(z.string()).describe('Top 3 risks in plain business language'),
  recommendations: z.array(z.string()),
  notTested: z.array(z.string()).describe('Areas not tested and why'),
});
