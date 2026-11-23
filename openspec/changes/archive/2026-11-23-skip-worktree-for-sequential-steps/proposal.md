# Proposal

## Why
When running workflows under Herdr (`HERDR_ENV=1`), current orchestrator prompt instructions and documentation unconditionally guide the agent to provision separate Git worktrees via `herdr worktree create` for every task. Even strictly sequential tasks (such as an initial setup task before a parallel batch, or a final completion task after a parallel batch) are provisioned into separate worktrees and later merged into the base branch. This adds unnecessary overhead in disk allocation, Git branching/merging, multiplexer workspaces, and execution latency.

Worktree isolation is only required when concurrent tasks execute in parallel (preventing file race conditions, git index lock collisions, and test cache interference). Strictly sequential tasks can and should run directly in the main worktree using subagents on the base branch.

## What Changes
- Update orchestrator prompt generation in `index.ts` (`buildWorkflowPrompt`) so Section 8 explicitly instructs that:
  - Strictly sequential steps (single-task batches or tasks with no concurrent peers) execute directly in the main worktree using subagents without creating separate worktrees or branches.
  - Worktree provisioning via `herdr worktree create` is strictly reserved for concurrent batches (tasks running in parallel).
- Update workflow documentation (`docs/parallel-execution.md` and `README.md`) to document the sequential execution optimization.
- Update workflow definitions (`workflows/feature-implementation/feature-implementation.yaml` and `workflows/task-implementation/task-implementation.yaml`) to reflect that only parallel batch tasks use isolated worktrees, while sequential tasks execute in the main worktree.
- Add regression tests covering prompt generation and mixed sequential/parallel lifecycle patterns.

## Capabilities

### New Capabilities
- `parallel-execution`: Specifies task batching and worktree isolation behavior, distinguishing strictly sequential tasks (which execute directly in the main worktree) from concurrent parallel tasks (which use isolated Herdr worktrees).

### Modified Capabilities
<!-- None -->

## Impact
- Affected code: `index.ts`, `workflows/feature-implementation/feature-implementation.yaml`, `workflows/task-implementation/task-implementation.yaml`, `docs/parallel-execution.md`, `README.md`.
- No breaking API changes or database schema alterations: child invocations in SQLite already support null/omitted `worktree` and `branch`.
