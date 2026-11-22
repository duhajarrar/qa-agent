// Shared types between the server and the web UI. No Node imports here.

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'openrouter' | 'groq';
export type Depth = 'quick' | 'standard' | 'deep';
export type Phase = 'learn' | 'plan' | 'test' | 'report';
export type RunStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
export type CaseGroup = 'happy' | 'edge' | 'negative' | 'nonfunctional';
export type CaseStatus = 'not_run' | 'running' | 'pass' | 'fail' | 'blocked' | 'skipped';
export type Priority = 'High' | 'Medium' | 'Low';
export type BugPriority = 'Blocker' | 'Critical' | 'High' | 'Medium' | 'Low';
export type Severity = 'S1 Critical' | 'S2 Major' | 'S3 Minor' | 'S4 Trivial';

export const GROUP_ORDER: CaseGroup[] = ['happy', 'edge', 'negative', 'nonfunctional'];
export const GROUP_LABEL: Record<CaseGroup, string> = {
  happy: 'Happy paths',
  edge: 'Edge cases',
  negative: 'Negative',
  nonfunctional: 'Look & accessibility',
};

export interface Account {
  role: string;
  username: string;
  password: string;
}

export interface Persona {
  name: string;
  role: string;
  goals: string;
  skills: string;
  behaviors: string;
}

export interface Understanding {
  productName: string;
  summary: string;
  audience: string;
  businessGoals: string[];
  criticalJourneys: string[];
  glossary: { term: string; meaning: string }[];
  gaps: string[];
}

export interface TestCase {
  id: string;
  group: CaseGroup;
  title: string;
  persona: string;
  feature: string;
  priority: Priority;
  preconditions: string;
  steps: string[];
  testData: string;
  expected: string;
  source: string;
  unsure: boolean;
  include: boolean;
  status: CaseStatus;
  actual?: string;
  notes?: string;
  bugId?: string;
  screenshot?: string; // relative path inside the run folder
  video?: string; // relative path inside the run folder
  attempts?: number;
}

export interface Bug {
  id: string;
  file: string; // bugs/BUG-001-slug.md
  caseIds: string[];
  title: string;
  severity: Severity;
  priority: BugPriority;
  businessImpact: string;
  feature: string;
  personas: string[];
  description: string;
  expected: string;
  actual: string;
  steps: string[];
  reproducibility: string;
  consoleErrors: string[];
  failedRequests: string[];
  screenshot?: string;
  video?: string;
}

export interface EnvInfo {
  url: string;
  environment: string;
  appVersion: string;
  browser: string;
  viewport: string;
  os: string;
  executedAt: string;
  model: string;
}

export interface Brand {
  primary: string;
  accent: string;
  background: string;
  text: string;
  font: string;
  logoText: string;
}

// ---------- Checkpoints: the moments the agent waits for the user ----------

export interface QuestionItem {
  id: string;
  question: string;
  suggestions: string[];
  defaultAnswer: string;
}

export type Checkpoint =
  | { id: string; kind: 'questions'; title: string; questions: QuestionItem[] }
  | { id: string; kind: 'flow'; title: string; steps: string[]; needed: { id: string; label: string; secret: boolean }[] }
  | { id: string; kind: 'cases'; title: string; cases: TestCase[] }
  | { id: string; kind: 'gate'; title: string; failed: { id: string; title: string; actual: string }[] };

export type CheckpointAnswer =
  | { kind: 'questions'; useDefaults?: boolean; answers: Record<string, string> }
  | { kind: 'flow'; useDefaults?: boolean; steps: string[]; values: Record<string, string> }
  | { kind: 'cases'; useDefaults?: boolean; cases: { id: string; expected: string; include: boolean }[] }
  | { kind: 'gate'; decision: 'continue' | 'skip_related' | 'stop' };

export interface ActivityItem {
  t: number; // ms since run start
  text: string;
}

// The run state the browser sees (never contains the API key or passwords).
export interface PublicRunState {
  id: string;
  status: RunStatus;
  phase: Phase;
  url: string;
  provider: ProviderId;
  model: string;
  depth: Depth;
  createdAt: number;
  queuePosition: number;
  activity: ActivityItem[];
  checkpoint: Checkpoint | null;
  understanding: Understanding | null;
  personas: Persona[];
  flow: string[];
  cases: TestCase[];
  bugs: Bug[];
  live: { url: string; action: string };
  usage: { inputTokens: number; outputTokens: number };
  aiWaitingSince: number | null; // set while a request to the AI provider is in flight
  error: string | null;
  reportReady: boolean;
  verdict: string | null;
}

export interface ModelInfo {
  id: string;
  label: string;
}

export interface KeyCheckResult {
  ok: boolean;
  error?: string;
  models: ModelInfo[];
  recommended?: string;
}
