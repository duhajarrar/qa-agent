import fs from 'node:fs/promises';
import path from 'node:path';
import type { Bug, EnvInfo, TestCase } from '../types.js';

export function bugMarkdown(bug: Bug, env: EnvInfo, c: TestCase): string {
  const rel = (p?: string) => (p ? `../${p}` : '');
  return `# ${bug.id}: ${bug.title}

| Field | Value |
|---|---|
| Severity | ${bug.severity} |
| Priority | ${bug.priority} |
| Business impact | ${bug.businessImpact.replace(/\|/g, '\\|')} |
| Feature / Area | ${bug.feature} |
| Affected persona(s) | ${bug.personas.join(', ')} |
| Related test case(s) | ${bug.caseIds.join(', ')} |
| Reproducibility | ${bug.reproducibility} |
| Environment | ${env.url} · app version ${env.appVersion} · ${env.browser} · ${env.os} · ${env.viewport} |
| Date found | ${env.executedAt.slice(0, 10)} |

## Description
${bug.description}

${bug.screenshot ? `![screenshot](${rel(bug.screenshot)})` : '_No screenshot captured._'}

${bug.video ? `Video of the full reproduction: [${path.basename(bug.video)}](${rel(bug.video)})` : '_No video captured._'}

## Expected result
${bug.expected}

## Actual result
${bug.actual}

## Reproduction details
**Environment:** ${env.environment} · ${env.url} · app version ${env.appVersion} · ${env.browser} · ${env.os} · ${env.viewport}

**Test data:** ${c.testData.replace(/\{\{secret:[^}]+\}\}/g, '••••••') || 'None'}

**Preconditions:** ${c.preconditions || 'None'}

**Steps to reproduce:**
${bug.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Additional information
- Console errors: ${bug.consoleErrors.length ? bug.consoleErrors.map((e) => `\`${e.replace(/`/g, "'")}\``).join('; ') : 'none'}
- Failed network requests: ${bug.failedRequests.length ? bug.failedRequests.join('; ') : 'none'}
`;
}

export async function writeBugFile(runDir: string, bug: Bug, env: EnvInfo, c: TestCase, mask: (s: string) => string) {
  await fs.mkdir(path.join(runDir, 'bugs'), { recursive: true });
  await fs.writeFile(path.join(runDir, bug.file), mask(bugMarkdown(bug, env, c)), 'utf8');
}
