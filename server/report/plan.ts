import fs from 'node:fs/promises';
import path from 'node:path';
import { GROUP_LABEL } from '../types.js';
import type { ReportData } from './html.js';

const cell = (s: string | undefined) => (s || '').replace(/\|/g, '\\|').replace(/\n+/g, '<br>');

export async function writePlanFile(runDir: string, d: ReportData, mask: (s: string) => string) {
  const bullets = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- None');
  const md = `# Test plan — ${d.understanding.productName}

## Scope
**In scope**
${bullets(d.plan.scopeIn)}

**Out of scope**
${bullets(d.plan.scopeOut)}

## Test setup
| Item | Value |
|---|---|
| Environment | ${d.env.environment} |
| URL | ${d.env.url} |
| App version | ${d.env.appVersion} |
| Browser | ${d.env.browser} |
| OS | ${d.env.os} |
| Viewports | ${d.env.viewport} |
| Tools | Playwright, AI model ${d.env.model} |
| Executed | ${d.env.executedAt} |

## Test data
${bullets(d.testData)}

## Common information
**Personas**
${d.personas.map((p) => `- **${p.name}** (${p.role}): ${p.goals}`).join('\n')}

**Main end-to-end flow**
${d.flow.map((s, i) => `${i + 1}. ${s}`).join('\n')}

**Glossary**
${bullets(d.understanding.glossary.map((g) => `${g.term}: ${g.meaning}`))}

## Risks and assumptions
${bullets([...d.plan.risks, ...d.plan.assumptions])}

## Entry / exit criteria
**Entry**
${bullets(d.plan.entryCriteria)}

**Exit**
${bullets(d.plan.exitCriteria)}

## Test cases
| Case # | Title | Persona | Feature | Type | Priority | Preconditions | Steps | Test data | Expected result | Actual result | Status | Bug file |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${d.cases
  .map((c) => {
    const bug = d.bugs.find((b) => b.id === c.bugId);
    return `| ${c.id} | ${cell(c.title)} | ${cell(c.persona)} | ${cell(c.feature)} | ${GROUP_LABEL[c.group]} | ${c.priority} | ${cell(c.preconditions)} | ${cell(c.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'))} | ${cell(c.testData.replace(/\{\{secret:[^}]+\}\}/g, '••••••'))} | ${cell(c.expected)} | ${cell(c.actual || c.notes)} | ${c.status.replace('_', ' ')} | ${bug ? bug.file : ''} |`;
  })
  .join('\n')}
`;
  await fs.writeFile(path.join(runDir, 'test-plan.md'), mask(md), 'utf8');
}
