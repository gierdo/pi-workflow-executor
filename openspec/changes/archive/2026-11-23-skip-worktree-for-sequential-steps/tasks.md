# Tasks

## 1. Prompt Builder and Orchestrator Instructions

- [x] 1.1 Update `buildWorkflowPrompt` in `index.ts` to explicitly instruct that strictly sequential tasks execute directly in the main worktree without worktree allocation, while only concurrent parallel tasks provision worktrees via `herdr worktree create`. Verify with `node --test --experimental-strip-types test/sequential-worktree-repro.test.ts`.

## 2. Workflow Definitions and Documentation

- [x] 2.1 Update `feature-implementation.yaml` (`implementation` and `integration` goals) and `task-implementation.yaml` (`task_review` goal) to reflect main worktree execution for sequential tasks. Verify definitions are valid with `pnpm test`.
- [x] 2.2 Update `docs/parallel-execution.md` and `README.md` to document the distinction between strictly sequential steps (main worktree) and concurrent batches (isolated worktrees).

## 3. Regression Testing and Verification

- [x] 3.1 Integrate sequential vs parallel batch execution assertions into `test/parallel-execution.test.ts` and ensure full test suite passes with `pnpm test`.
