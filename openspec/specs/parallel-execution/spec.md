# parallel-execution Specification

## Purpose

Defines execution isolation rules for workflow tasks, separating strictly sequential steps from concurrent parallel batches.

## Requirements

### Requirement: Sequential tasks execute in the main worktree
The workflow orchestrator SHALL instruct and execute strictly sequential tasks directly in the main worktree without provisioning dedicated Git worktrees or temporary task branches.

#### Scenario: Single sequential task in a mixed workflow
- **WHEN** a workflow executes a task stage containing only a single sequential task (e.g. task 1 or task 5)
- **THEN** the task worker subagent executes with cwd pointing to the main worktree without invoking `wt switch --create` or `herdr worktree open` or creating temporary task branches

### Requirement: Concurrent tasks use isolated Git worktrees
The workflow orchestrator SHALL provision isolated Git worktrees via Worktrunk (`wt`) and register them in Herdr (`herdr worktree open`) for tasks running concurrently in parallel batches.

#### Scenario: Parallel task batch execution
- **WHEN** a workflow executes a staged batch of multiple tasks concurrently in Herdr (`HERDR_ENV=1`) with Worktrunk (`wt`) available
- **THEN** each concurrent task is provisioned in a dedicated Git worktree via `wt switch --create` (using branch `{base-branch}-{task-slug}`) and opened as a Herdr workspace via `herdr worktree open`, and upon completion of the wave is merged into the base branch via `wt merge --no-remove` and cleaned up via `wt remove --foreground` and `herdr workspace close`
