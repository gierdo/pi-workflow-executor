# Bug Diagnosis: skip-worktree-for-sequential-steps

## Report

### Observed Behavior
When running workflows under Herdr (`HERDR_ENV=1`), orchestrator prompts and execution instructions require worktrees for every task invocation in a workflow if the workflow utilizes parallel execution. Even strictly sequential tasks (e.g. Task 1 before parallel tasks 2-4, or Task 5 after parallel tasks 2-4) are provisioned into separate Git worktrees via `herdr worktree create` and subsequently merged into the base branch, incurring significant disk, git ref, and multiplexer overhead.

### Expected Behavior
Worktrees are only provisioned for concurrent tasks that actually execute in parallel (where worktree isolation is required to prevent file collision, git index locks, or test cache interference). Strictly sequential steps (single-task batches or stages with no concurrent peers) should execute directly in the main worktree using subagents without worktree provisioning or branch merging overhead.

### Environment
- `pi-workflow-executor` orchestrator prompt builder (`index.ts`)
- Workflow definitions (`workflows/feature-implementation/feature-implementation.yaml`, `workflows/task-implementation/task-implementation.yaml`)
- Architecture documentation (`docs/parallel-execution.md`, `README.md`)
- Herdr multiplexer environment (`HERDR_ENV=1`)

### Exact Trigger
A workflow with mixed sequential and parallel stages (e.g., 5 tasks where stage 1 is Task 1, stage 2 is Tasks 2-3-4 in parallel, stage 3 is Task 5) is executed under `HERDR_ENV=1`. The orchestrator provisions worktrees for all 5 tasks instead of only for the parallel tasks (Tasks 2, 3, 4).

## Reproduction

### Steps to Reproduce
1. Run `node --test --experimental-strip-types test/sequential-worktree-repro.test.ts`.
2. The test verifies that `workflow_start` generates an orchestrator execution prompt that distinguishes strictly sequential tasks from parallel tasks.
3. The test fails because `buildWorkflowPrompt` in `index.ts` unconditionally tells the orchestrator under `HERDR_ENV=1` that tasks are provisioned into worktrees without directing sequential tasks to execute directly in the main worktree.

### Failing Test Path
`test/sequential-worktree-repro.test.ts`
Test assertion error: `ERR_ASSERTION: Orchestrator prompt must explicitly instruct sequential steps to run in the main worktree without worktree provisioning`.

## Root Cause

### Detailed Analysis
In `index.ts`, `buildWorkflowPrompt()` defines Section 8 ("Parallel Execution & Herdr Worktrees") which is delivered to the LLM orchestrator whenever a workflow starts or resumes.
The instruction currently states:
```text
8. **Parallel Execution & Herdr Worktrees**:
   - Parallel execution is ONLY permitted when HERDR_ENV=1. If not running in Herdr, execute tasks sequentially in the main workspace.
   - For parallel batches (concurrency ceiling default: 3, overridable by user prompt):
     a. Propose a base branch name with an appropriate prefix based on workflow kind (feat/, fix/, perf/, refactor/) and confirm {prefix}/{workflow-slug} with the user.
     b. Serially provision worktrees using herdr worktree create with branch {base-branch}/{task-slug}.
     c. Launch worker subagents in parallel with cwd pointing to their respective worktrees and distinct child runIds.
     d. Each child executes task-implementation including in-worktree review.
     e. Retain worktrees until integration verification succeeds.
     f. In the integration state, sequentially merge task branches into {base-branch}.
     g. Upon successful verification, clean up worktrees via herdr worktree remove.
```

The instructions fail to distinguish between:
1. **Concurrent / parallel batches**: Multiple tasks executed at the same time where worktrees are necessary to prevent git index lock contention, file collisions, and test interference.
2. **Strictly sequential tasks / steps**: Single-task steps or tasks that have no concurrent peers (e.g. task 1 before a parallel batch, or task 5 after a parallel batch).

Because the instructions only mention worktrees when in Herdr (`HERDR_ENV=1`), and provide no rule for sequential tasks in Herdr, orchestrating agents assume all tasks executed under Herdr must be created in individual worktrees.

Furthermore:
- `workflows/feature-implementation/feature-implementation.yaml` states in `implementation` that in Herdr environments all tasks execute within isolated Git worktrees.
- `docs/parallel-execution.md` describes leaf execution as "invoked per task in an isolated Git worktree" without documenting the sequential optimization.

## Blast Radius
- `index.ts`: Orchestrator prompt builder in `buildWorkflowPrompt`
- `workflows/feature-implementation/feature-implementation.yaml`: `implementation` and `integration` state goals
- `workflows/task-implementation/task-implementation.yaml`: `task_review` state description
- `docs/parallel-execution.md` & `README.md`: Architecture overview and execution guide
- `test/parallel-execution.test.ts` & `test/sequential-worktree-repro.test.ts`: Regression suite tests

Risk is minimal and localized: Existing SQLite database schema and `createChildInvocation` already support null/omitted `worktree` and `branch`.

## Fix Approach
1. In `index.ts`: Update Section 8 of `buildWorkflowPrompt` to explicitly instruct that:
   - Worktree isolation (`herdr worktree create`) is strictly reserved for concurrent tasks executing in parallel.
   - Strictly sequential steps (single-task batches or tasks with no concurrent peers) must execute directly in the main worktree using subagents, on the base branch (or active branch), without creating temporary worktrees or branches.
   - Parallel batches (multiple tasks running concurrently, up to the concurrency ceiling) continue using serial worktree provisioning and branch merging.
2. In `workflows/feature-implementation/feature-implementation.yaml`:
   - Clarify in `implementation` and `integration` goals that only parallel batches provision worktrees, while sequential steps run in the main worktree.
3. In `workflows/task-implementation/task-implementation.yaml`:
   - Clarify in `task_review` that review occurs in the task worktree (for parallel tasks) or the main worktree (for sequential tasks).
4. In `docs/parallel-execution.md` and `README.md`:
   - Document the sequential step optimization clearly.
5. In tests:
   - Ensure `test/sequential-worktree-repro.test.ts` passes and integrate the test into `test/parallel-execution.test.ts`.

## Revision History
- 2026-11-23: Initial diagnosis created.


