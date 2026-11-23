# parallel-execution Specification

## Purpose

Defines execution isolation rules for workflow tasks, separating strictly sequential steps from concurrent parallel batches.

## Requirements

### Requirement: Sequential tasks execute in the main worktree
The workflow orchestrator SHALL instruct and execute strictly sequential tasks directly in the main worktree without provisioning dedicated Git worktrees or temporary task branches.

#### Scenario: Single sequential task in a mixed workflow
- **WHEN** a workflow executes a task stage containing only a single sequential task (e.g. task 1 or task 5)
- **THEN** the task worker subagent executes with cwd pointing to the main worktree without invoking `herdr worktree create` or creating temporary task branches

### Requirement: Concurrent tasks use isolated Git worktrees
The workflow orchestrator SHALL provision isolated Git worktrees via Herdr for tasks running concurrently in parallel batches.

#### Scenario: Parallel task batch execution
- **WHEN** a workflow executes a staged batch of multiple tasks concurrently in Herdr (`HERDR_ENV=1`)
- **THEN** each concurrent task is provisioned in a dedicated Git worktree via `herdr worktree create` and merged into the base branch upon completion
