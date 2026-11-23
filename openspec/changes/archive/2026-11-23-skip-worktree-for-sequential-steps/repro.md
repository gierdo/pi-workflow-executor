# Reproduction

## Steps to Reproduce
1. Run `node --test --experimental-strip-types test/sequential-worktree-repro.test.ts`.
2. The test verifies that `workflow_start` generates an orchestrator execution prompt that distinguishes strictly sequential tasks from parallel tasks.
3. The test fails because `buildWorkflowPrompt` in `index.ts` unconditionally tells the orchestrator under `HERDR_ENV=1` that tasks are provisioned into worktrees without directing sequential tasks to execute directly in the main worktree.

## Failing Test Path
`test/sequential-worktree-repro.test.ts`
Test assertion error: `ERR_ASSERTION: Orchestrator prompt must explicitly instruct sequential steps to run in the main worktree without worktree provisioning`.
