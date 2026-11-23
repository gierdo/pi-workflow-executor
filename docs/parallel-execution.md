# Parallel Task Execution with Herdr Worktrees

`pi-workflow-executor` supports concurrent task execution and pipelined in-worktree review loops using [Herdr](https://github.com/gierdo/herdr)'s native Git worktree management.

When executing workflows in a Herdr terminal multiplexer environment (`HERDR_ENV=1`), implementation tasks run concurrently in isolated Git worktrees. This prevents file race conditions, lock collisions, and test cache interference. When outside Herdr, workflows gracefully fall back to sequential execution in the main repository workspace.

---

## Architecture Overview

Parallel task execution operates on a two-tier hierarchy distinguishing lifecycle orchestration from task execution:
- **Parent Lifecycle Orchestrator (`feature-implementation` / `bug-fix`)**: Owns the end-to-end lifecycle, OpenSpec specifications, task batching, worktree provisioning, integration merging, and change archival. It never writes task code directly; it coordinates and delegates execution.
- **Leaf Execution Engine (`task-implementation`)**: Bounded worker execution engine invoked per task. Concurrent tasks in parallel batches execute within isolated Git worktrees, while strictly sequential tasks execute directly in the main worktree without worktree allocation. It performs quality intake against the task context or plan, implements the code, verifies with test evidence, passes in-worktree review (`task_review`), records evidence, and halts without re-planning or scope creep.

```
                     +---------------------------------------+
                     |  Parent Workflow (e.g. feature-impl)  |
                     |  RunRecord: run-123 (Revision N)      |
                     +-------------------+-------------------+
                                         |
                       [Check HERDR_ENV=1 & Confirm Base Branch]
                                         |
                     +-------------------+-------------------+
                     | Serial Worktree Provisioning Loop     |
                     | herdr worktree create (Branch/Worktree)|
                     +-------------------+-------------------+
                                         |
                  +----------------------+----------------------+
                  |                                             |
                  v                                             v
     +-------------------------+                   +-------------------------+
     | Child Run: task-impl-1  |                   | Child Run: task-impl-2  |
     | Worktree: /wt/feat/t1   |                   | Worktree: /wt/feat/t2   |
     | Branch: feat/x/t1       |                   | Branch: feat/x/t2       |
     +------------+------------+                   +------------+------------+
                  |                                             |
           [implement]                                   [implement]
                  |                                             |
            [verify]                                      [verify]
                  |                                             |
          [task_review]                                 [task_review]
                  |                                             |
               [done]                                        [done]
                  |                                             |
                  +----------------------+----------------------+
                                         |
                            (Both Tasks Report Done)
                                         |
                                         v
                     +---------------------------------------+
                     |  Integration Barrier in Parent Run    |
                     |  1. Sequential merge of task branches |
                     |  2. Full suite verification           |
                     |  3. herdr worktree remove (cleanup)   |
                     +---------------------------------------+
```

---

## Key Concepts

### 1. Environment Gating (`HERDR_ENV=1`)
- **Inside Herdr**: When `process.env.HERDR_ENV === "1"`, parallel execution is enabled.
- **Outside Herdr**: Workflows fall back to sequential task execution in the project root workspace.

### 2. Base Branch Proposal & Naming
Before provisioning worktrees, the orchestrator proposes a base branch name with an appropriate prefix based on the workflow category:
- `feat/`: for feature implementation workflows
- `fix/`: for bug-fix workflows
- `perf/`: for performance optimization
- `refactor/`: for code refactoring

The branch pattern is `{prefix}/{workflow-slug}` (e.g., `feat/parallel-subagents`). The user confirms the base branch name before worktree creation begins.

### 3. Sequential Steps vs Parallel Batches
Worktree isolation is strictly reserved for tasks running concurrently in parallel:
- **Strictly Sequential Tasks**: Tasks that have no concurrent peers (e.g. Task 1 before a parallel batch, or Task 5 after a parallel batch, or any single-task stage) execute directly in the main repository workspace with subagents on the base branch (or active branch). They bypass `herdr worktree create`, branch creation, and merge overhead.
- **Parallel Batches**: When multiple tasks can be executed concurrently in parallel, worktrees are provisioned serially prior to launching worker subagents.

### 4. Serial Worktree Provisioning
To avoid Git index lock contention (`.git/index.lock`), worktrees for parallel batches are provisioned **serially** prior to launching parallel subagents:
```bash
herdr worktree create --cwd "$PWD" --branch "{base-branch}/{task-slug}" --label "{task-slug}" --no-focus
```

### 5. Parallel Worker Isolation & Multi-Child Tracking
- Each parallel task worker runs as a dedicated subagent with its current working directory (`cwd`) pointing to its isolated worktree. Sequential task workers run with `cwd` pointing to the main workspace.
- Child runs use distinct run IDs: `task-implementation-{task-slug}`.
- SQLite connections configure `PRAGMA busy_timeout = 5000;` to smoothly queue concurrent transaction writes without database lock errors.
- The `invocations` table tracks active children with columns: `task_slug`, `child_run_id`, `worktree`, and `branch` (`worktree` and `branch` are null for sequential tasks executed in the main worktree).

### 6. Pipelined In-Worktree Review Loops
Each child `task-implementation` run includes a `task_review` state:
- Delegated to `subagent: reviewer`.
- The reviewer inspects the task diff within the isolated worktree (or main worktree for sequential steps).
- If issues or defects are found, a remediation loop transitions back to `implement` (`max_retries: 2`).
- The task only reaches `done` after both verification and in-worktree review pass.

### 7. Integration Barrier & Worktree Cleanup
When all tasks in a batch complete:
1. The parent workflow reaches its integration barrier (e.g. `integration` state).
2. The orchestrator sequentially merges task branches into `{base-branch}` via `git merge --no-ff`. If a merge conflict occurs, the merge is aborted and remediation returns to the task worktree.
3. Full integration tests are executed across the merged workspace.
4. Once integration verification passes, temporary worktrees are cleaned up:
   ```bash
   herdr worktree remove --workspace "{workspace-id}" --force
   ```

### 8. Concurrency Ceilings
- Workflow definitions support a `concurrency` ceiling attribute at the workflow root or state level (defaults to 3; must be a positive integer >= 1).
- User prompt instructions can override the concurrency ceiling for a given run (e.g., specifying concurrency of 2 or 5).

Example in workflow YAML:
```yaml
name: feature-implementation
version: 1
concurrency: 3 # Workflow-wide default ceiling

states:
  implementation:
    goal: "Implement planned tasks concurrently across isolated Herdr worktrees."
    concurrency: 4 # State-specific override
    invoke:
      workflow: task-implementation
    transitions:
      - outcome: tasks_completed
        to: integration
```


### 9. Strict Safety Boundaries
- All operations are strictly local.
- Zero Git branches or commits are pushed to remote origins during the worktree lifecycle.
- Subagents never share a working directory or Git index during parallel execution.
