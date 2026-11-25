# Parallel Task Execution with Worktrunk and Herdr Worktrees

`pi-workflow-executor` supports concurrent task execution and pipelined in-worktree review loops using [Worktrunk (`wt`)](https://worktrunk.dev/) paired with [Herdr](https://github.com/gierdo/herdr) workspace registration (`herdr worktree open` and `herdr workspace close`).

When executing workflows in a Herdr terminal multiplexer environment (`HERDR_ENV=1`) with Worktrunk (`wt`) available, implementation tasks run concurrently in isolated Git worktrees. This prevents file race conditions, lock collisions, and test cache interference. When outside Herdr (or when `wt` is unavailable), workflows gracefully fall back to sequential execution in the main repository workspace.

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
                  [Check HERDR_ENV=1, wt & Confirm Base Branch]
                                         |
                     +-------------------+-------------------+
                     | Serial Worktree Provisioning Loop     |
                     | 1. wt switch --create (Worktree+Hooks)|
                     | 2. herdr worktree open (Herdr WS)     |
                     +-------------------+-------------------+
                                         |
                  +----------------------+----------------------+
                  |                                             |
                  v                                             v
     +-------------------------+                   +-------------------------+
     | Child Run: task-impl-1  |                   | Child Run: task-impl-2  |
     | Worktree: /wt/feat-x-t1 |                   | Worktree: /wt/feat-x-t2 |
     | Branch: feat/x-t1       |                   | Branch: feat/x-t2       |
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
                     |  1. wt merge --no-remove (per task)   |
                     |  2. wt remove --foreground            |
                     |  3. herdr workspace close             |
                     |  4. Full suite verification           |
                     +---------------------------------------+
```

---

## Key Concepts

### 1. Environment Gating (`HERDR_ENV=1` & Worktrunk `wt`)
- **Inside Herdr with Worktrunk**: When `process.env.HERDR_ENV === "1"` and the Worktrunk CLI (`wt`, or `process.env.WORKTRUNK_BIN`) is available, parallel execution is enabled.
- **Outside Herdr**: Workflows fall back to sequential task execution in the project root workspace.

### 2. Base Branch and Task Branch Naming
For parallel wave batches, the orchestrator uses a base branch with an appropriate prefix based on the workflow category:
- `feat/`: for feature implementation workflows
- `fix/`: for bug-fix workflows
- `perf/`: for performance optimization
- `refactor/`: for code refactoring

The base branch pattern is `{prefix}/{workflow-slug}` (e.g., `feat/parallel-subagents`), or the active feature branch if already on one.

Task branches use a hyphen separator `{base-branch}-{task-slug}` (e.g., `feat/parallel-subagents-task-1`) rather than a nested slash (`{base-branch}/{task-slug}`) so Git ref files under `.git/refs/heads/` never collide with the `{base-branch}` ref file.

### 3. Sequential Waves vs Parallel Wave Batches
Worktree isolation is strictly reserved for tasks running concurrently in parallel within a wave:
- **Strictly Sequential Tasks (`[sequential]`)**: Single-task waves or tasks with no concurrent peers (e.g. Wave 1 foundation before a parallel wave, or Wave 3 integration after a parallel wave) execute directly in the main repository workspace with subagents on the base branch. They bypass `wt switch --create`, `herdr worktree open`, branch creation, and merge overhead.
- **Parallel Wave Batches (`[parallel]`)**: When a wave contains multiple independent tasks partitioned across disjoint files/modules, worktrees are provisioned serially prior to launching parallel worker subagents.

### 4. Serial Worktree Provisioning with Worktrunk and Herdr
To avoid Git index lock contention (`.git/index.lock`), worktrees for parallel batches are provisioned **serially** prior to launching parallel subagents:
1. Create the branch and worktree via Worktrunk (which also runs any configured Worktrunk `post-create` / `post-start` hooks):
   ```bash
   wt switch --create "{base-branch}-{task-slug}" --base "{base-branch}" --no-cd --format=json -y
   ```
2. Register and open the checkout as a dedicated Herdr workspace without stealing focus:
   ```bash
   herdr worktree open --cwd "$PWD" --path "<worktree-path>" --label "{task-slug}" --no-focus --json
   ```

### 5. Parallel Worker Isolation & Multi-Child Tracking
- Each parallel task worker runs as a dedicated subagent with its current working directory (`cwd`) pointing to its isolated worktree (and `workspace` set to the opened Herdr workspace ID). Sequential task workers run with `cwd` pointing to the main workspace.
- Child runs use distinct run IDs: `task-implementation-{task-slug}`.
- SQLite connections configure `PRAGMA busy_timeout = 5000;` to smoothly queue concurrent transaction writes without database lock errors.
- The `invocations` table tracks active children with columns: `task_slug`, `child_run_id`, `worktree`, and `branch` (`worktree` and `branch` are null for sequential tasks executed in the main worktree).

### 6. Pipelined In-Worktree Review Loops
Each child `task-implementation` run includes a `task_review` state:
- Delegated to `subagent: reviewer`.
- The reviewer inspects the task diff within the isolated worktree (or main worktree for sequential steps).
- If issues or defects are found, a remediation loop transitions back to `implement` (`max_retries: 2`).
- The task only reaches `done` after both verification and in-worktree review pass.

### 7. Wave Merge Barrier & Worktree Cleanup
When all tasks in a parallel wave complete:
1. The orchestrator sequentially merges each task worktree (`{base-branch}-{task-slug}`) into `{base-branch}` via Worktrunk with `--no-remove` (preventing asynchronous background removal from racing with Herdr workspace teardown):
   ```bash
   wt merge "{base-branch}" -C "<worktree-path>" --no-remove -y
   ```
2. Once merged cleanly, each task's worktree is removed synchronously in the foreground and its Herdr workspace is closed before starting the next wave or entering `verification` and `review`:
   ```bash
   wt remove --foreground -C "$PWD" "{base-branch}-{task-slug}" -y
   herdr workspace close "<workspace-id>"
   ```
3. After all waves are merged into `{base-branch}`, `verification` and `review` evaluate the complete, integrated feature diff on `{base-branch}`, followed by final landing/archival in `integration`.

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

### 10. Multiplexer Surface Placement
- **Direct Worktree Workspace Placement**: Because each worktree provisioned by `wt switch --create` is registered as a Herdr workspace via `herdr worktree open --no-focus`, `pi-herdr-subagents` resolves the worktree's Herdr workspace and places worker and reviewer subagent tabs directly inside the worktree's Herdr workspace rather than crowding the orchestrator's main workspace.
