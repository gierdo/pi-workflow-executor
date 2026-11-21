export interface InputDefinition {
  description?: string;
  required?: boolean;
  default?: unknown;
}

export interface ArtifactDefinition {
  path: string;
  description?: string;
}

export interface ChildInvocationDefinition {
  workflow: string;
  inputs?: Record<string, unknown>;
  entry?: string;
}

export interface TransitionDefinition {
  outcome?: string;
  when?: string;
  to: string;
  reason?: string;
  requires_approval?: boolean;
  max_retries?: number;
}

export interface SubagentDefinition {
  agent: string;
  skills?: string;
  task?: string;
}

export interface StateDefinition {
  goal?: string;
  consumes?: string[];
  produces?: string[];
  exit_gate?: string;
  terminal?: boolean;
  invoke?: ChildInvocationDefinition;
  subagent?: string | SubagentDefinition;
  transitions?: TransitionDefinition[];
  concurrency?: number;
}

export interface WorkflowDefinition {
  name: string;
  version?: number | string;
  description?: string;
  inputs?: Record<string, InputDefinition>;
  artifacts?: Record<string, ArtifactDefinition>;
  initial: string;
  states: Record<string, StateDefinition>;
  herdr?: unknown;
  concurrency?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export type RunStatus = "active" | "paused" | "completed" | "aborted";

export interface RunRecord {
  id: string;
  task: string;
  workflow: string;
  current_state: string;
  revision: number;
  definition_fingerprint: string;
  status: RunStatus;
  pause_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface StateVisitRecord {
  id: number;
  run_id: string;
  state_id: string;
  visit_index: number;
  entered_at: string;
  exited_at?: string;
}

export interface TransitionInput {
  runId: string;
  outcomeId: string;
  expectedRevision: number;
  evidence?: string[];
}

export interface TransitionResult {
  status: "advanced" | "pending_approval" | "paused" | "terminal";
  nextState?: string;
  gate?: string;
  reason?: string;
  revision?: number;
}

export interface InvocationRecord {
  id: number;
  parent_run_id: string;
  invocation_id: string;
  child_workflow: string;
  entry_override?: string;
  task_slug?: string;
  child_run_id?: string;
  worktree?: string;
  branch?: string;
  status: "active" | "completed" | "aborted";
  created_at: string;
  finished_at?: string;
}
