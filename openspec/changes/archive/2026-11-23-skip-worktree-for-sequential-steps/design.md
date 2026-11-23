# Design

## Context
See proposal.md - Why.
In Herdr environments (`HERDR_ENV=1`), task-implementation workers can execute concurrently. Previously, instructions instructed worktree creation unconditionally for every task under Herdr. The database (`invocations` table) and runner helpers (`createChildInvocation`) already allow null `worktree` and `branch`.

## Goals / Non-Goals

**Goals:**
- Provide clear orchestrator instructions in `index.ts` distinguishing strictly sequential steps (which run directly in the main worktree) from concurrent batches (which run in isolated Git worktrees).
- Update workflow YAML goals in `feature-implementation.yaml` and `task-implementation.yaml` to reflect this distinction.
- Update documentation in `docs/parallel-execution.md` and `README.md`.
- Maintain complete backwards compatibility for existing single-task and multi-child invocation APIs.

**Non-Goals:**
- Automated graph dependency parsing of arbitrary plans within the engine (task batching and staging remains an orchestrator LLM / plan responsibility).
- Altering SQLite database schema (nullable columns already support running in main workspace).

## Decisions

### Decision 1: Differentiate Sequential Steps vs Parallel Batches in Prompt Builder
- **Approach**: In `index.ts` (`buildWorkflowPrompt`), update Section 8 to explicitly state that strictly sequential tasks (single-task stages with no concurrent peers) execute directly in the main worktree using subagents on the base branch (or active branch) with no worktree provisioning. Only parallel batches (concurrent tasks) serially provision worktrees and merge on completion.
- **Rationale**: The orchestrator prompt is the direct steering mechanism for how the LLM parent orchestrator plans, provisions, and delegates tasks.
- **Alternatives Considered**: Automatically intercepting every subagent launch inside the runtime and detecting whether another subagent is active. Rejected: The parent orchestrator owns the plan, stages, and worktree creation; runtime guessing is brittle and defeats deliberate batching.

### Decision 2: In-Worktree Review Generalization
- **Approach**: Clarify in `task_review` of `task-implementation.yaml` that review occurs in the task worktree (for parallel tasks) or in the main worktree (for sequential tasks).
- **Rationale**: Ensures reviewer subagent performs code review regardless of whether a separate worktree was provisioned.

### Decision 3: Regression Test Coverage
- **Approach**: Test prompt generation in `test/sequential-worktree-repro.test.ts` and test mixed sequential/parallel invocation lifecycle in `test/parallel-execution.test.ts`.

## Risks / Trade-offs
- [Risk: Orchestrator agent could attempt to run two parallel tasks in the main worktree] → Mitigation: Prompt instructions strictly state that concurrent parallel tasks MUST use isolated Git worktrees.
