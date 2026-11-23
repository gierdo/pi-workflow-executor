import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import workflowExtension from "../index.ts";
import { createMockPi } from "./helpers.ts";
import { initDatabase, createRun } from "../runner/db.ts";
import { createChildInvocation, getActiveInvocations, completeInvocationByTask } from "../runner/invocations.ts";
import { createHerdrWorktree, removeHerdrWorktree, herdrOps } from "../herdr.ts";

test("reproduction: orchestrator prompt directs sequential tasks to execute in the main worktree without worktree overhead", async () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), "pw-repro-seq-"));
  process.chdir(tempDir);

  try {
    const { mockPi, registeredTools } = createMockPi();
    await workflowExtension(mockPi);

    const startTool = registeredTools["workflow_start"];
    assert.ok(startTool);

    const res = await startTool.execute(
      "c1",
      { workflow: "feature-implementation", task: "test-task" },
      undefined,
      undefined,
      { ui: {} }
    );

    const prompt = res.content[0].text;

    // The prompt should instruct that strictly sequential tasks execute in the main worktree,
    // and worktrees are ONLY provisioned for concurrent / parallel tasks.
    assert.match(
      prompt,
      /sequential (tasks|steps).*main worktree/i,
      "Orchestrator prompt must explicitly instruct sequential steps to run in the main worktree without worktree provisioning"
    );
    assert.match(
      prompt,
      /only.*parallel.*worktree/i,
      "Orchestrator prompt must restrict worktree provisioning to parallel tasks"
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sequential vs parallel batch execution pattern: only parallel tasks allocate worktrees", () => {
  const origEnv = process.env.HERDR_ENV;
  const origExecSync = herdrOps.execSync;
  const executedCommands: string[] = [];

  try {
    process.env.HERDR_ENV = "1";

    herdrOps.execSync = ((cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.startsWith("herdr worktree create")) {
        const branchMatch = cmd.match(/--branch "([^"]+)"/);
        const labelMatch = cmd.match(/--label "([^"]+)"/);
        const branch = branchMatch ? branchMatch[1] : "unknown";
        const label = labelMatch ? labelMatch[1] : "unknown";
        return JSON.stringify({
          result: {
            worktree: { path: `/tmp/worktrees/${branch}` },
            workspace: { id: `ws_${label}` },
          },
        });
      }
      return "";
    }) as any;

    const tempDir = mkdtempSync(join(tmpdir(), "pw-seq-pattern-"));
    const db = initDatabase(join(tempDir, "state.db"));

    createRun(db, {
      id: "parent-plan-mixed",
      task: "mixed-tasks",
      workflow: "feature-implementation",
      initialState: "implementation",
      definitionFingerprint: "fp-mixed",
    });

    // Plan structure:
    // Stage 1: task-1 (strictly sequential)
    // Stage 2: task-2, task-3, task-4 (parallel batch)
    // Stage 3: task-5 (strictly sequential)
    const baseBranch = "fix/mixed-tasks";

    // 1. Stage 1: task-1 runs sequentially in main worktree
    createChildInvocation(db, "parent-plan-mixed", "task-implementation", {
      taskSlug: "task-1",
      childRunId: "task-impl-task-1",
      // No worktree or branch allocated: main worktree is used
    });

    const activeStage1 = getActiveInvocations(db, "parent-plan-mixed");
    assert.equal(activeStage1.length, 1);
    assert.equal(activeStage1[0].worktree, null);
    assert.equal(activeStage1[0].branch, null);
    completeInvocationByTask(db, "parent-plan-mixed", "task-1", "completed");

    // 2. Stage 2: parallel tasks 2, 3, 4 require worktrees
    const parallelTasks = ["task-2", "task-3", "task-4"];
    const createdWts: Array<{ worktreePath: string; workspaceId?: string }> = [];

    for (const slug of parallelTasks) {
      const wt = createHerdrWorktree({
        cwd: "/workspace",
        branch: `${baseBranch}/${slug}`,
        label: slug,
      });
      createdWts.push(wt);
      createChildInvocation(db, "parent-plan-mixed", "task-implementation", {
        taskSlug: slug,
        childRunId: `task-impl-${slug}`,
        worktree: wt.worktreePath,
        branch: `${baseBranch}/${slug}`,
      });
    }

    const activeStage2 = getActiveInvocations(db, "parent-plan-mixed");
    assert.equal(activeStage2.length, 3);
    for (const inv of activeStage2) {
      assert.ok(inv.worktree?.startsWith("/tmp/worktrees/"));
    }

    for (const slug of parallelTasks) {
      completeInvocationByTask(db, "parent-plan-mixed", slug, "completed");
    }

    // Worktree cleanup for parallel stage
    for (const wt of createdWts) {
      if (wt.workspaceId) removeHerdrWorktree(wt.workspaceId);
    }

    // 3. Stage 3: task-5 runs sequentially in main worktree
    createChildInvocation(db, "parent-plan-mixed", "task-implementation", {
      taskSlug: "task-5",
      childRunId: "task-impl-task-5",
      // No worktree: runs in main worktree
    });
    const activeStage3 = getActiveInvocations(db, "parent-plan-mixed");
    assert.equal(activeStage3.length, 1);
    assert.equal(activeStage3[0].worktree, null);
    completeInvocationByTask(db, "parent-plan-mixed", "task-5", "completed");

    // Assert that worktree commands were only executed for the 3 parallel tasks
    const createCommands = executedCommands.filter((c) => c.startsWith("herdr worktree create"));
    const removeCommands = executedCommands.filter((c) => c.startsWith("herdr worktree remove"));

    assert.equal(createCommands.length, 3, "Only parallel tasks 2, 3, 4 should create worktrees");
    assert.equal(removeCommands.length, 3, "Only parallel tasks 2, 3, 4 should remove worktrees");

    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  } finally {
    herdrOps.execSync = origExecSync;
    if (origEnv !== undefined) {
      process.env.HERDR_ENV = origEnv;
    } else {
      delete process.env.HERDR_ENV;
    }
  }
});
