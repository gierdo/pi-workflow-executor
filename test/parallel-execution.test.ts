import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, createRun, getRun } from "../runner/db.ts";
import {
  createChildInvocation,
  getActiveInvocations,
  getInvocationByTask,
  completeInvocationByTask,
} from "../runner/invocations.ts";
import { isHerdrActive, createHerdrWorktree, removeHerdrWorktree, herdrOps } from "../herdr.ts";
import { loadYamlParser, resolveWorkflowsDir } from "./helpers.ts";
import { readFileSync } from "node:fs";

const parse = loadYamlParser();

test("SQLite concurrent write transaction queuing via busy_timeout (ISC 1)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pw-parallel-db-"));
  const dbPath = join(tempDir, "state.db");

  try {
    const db1 = initDatabase(dbPath);
    const db2 = initDatabase(dbPath);

    // Verify busy_timeout is set to 5000
    const timeout1 = db1.prepare("PRAGMA busy_timeout;").get() as { timeout: number };
    const timeout2 = db2.prepare("PRAGMA busy_timeout;").get() as { timeout: number };
    assert.equal(timeout1.timeout, 5000);
    assert.equal(timeout2.timeout, 5000);

    createRun(db1, {
      id: "parent-concurrent",
      task: "parallel-task",
      workflow: "feature-implementation",
      initialState: "implementation",
      definitionFingerprint: "fp-test",
    });

    // Write from db1
    createChildInvocation(db1, "parent-concurrent", "task-implementation", {
      taskSlug: "task-1",
      childRunId: "child-run-1",
      worktree: "/wt/task-1",
      branch: "feat/wf/task-1",
    });

    // Write from db2
    createChildInvocation(db2, "parent-concurrent", "task-implementation", {
      taskSlug: "task-2",
      childRunId: "child-run-2",
      worktree: "/wt/task-2",
      branch: "feat/wf/task-2",
    });

    const activeInDb1 = getActiveInvocations(db1, "parent-concurrent");
    const activeInDb2 = getActiveInvocations(db2, "parent-concurrent");

    assert.equal(activeInDb1.length, 2);
    assert.equal(activeInDb2.length, 2);
    assert.equal(activeInDb1[0].task_slug, "task-1");
    assert.equal(activeInDb1[1].task_slug, "task-2");

    // Close connections
    db1.close();
    db2.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Parallel task invocations query and completion lifecycle (ISC 2, 3)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pw-parallel-inv-"));
  const dbPath = join(tempDir, "state.db");

  try {
    const db = initDatabase(dbPath);

    createRun(db, {
      id: "parent-stage",
      task: "feature-staged",
      workflow: "feature-implementation",
      initialState: "implementation",
      definitionFingerprint: "fp-staged",
    });

    const tasks = ["task-a", "task-b", "task-c"];
    for (const t of tasks) {
      createChildInvocation(db, "parent-stage", "task-implementation", {
        taskSlug: t,
        childRunId: `task-impl-${t}`,
        worktree: `/path/to/worktrees/${t}`,
        branch: `feat/feature-staged/${t}`,
      });
    }

    const active = getActiveInvocations(db, "parent-stage");
    assert.equal(active.length, 3);
    assert.deepEqual(active.map((a) => a.task_slug), ["task-a", "task-b", "task-c"]);

    // Complete task-b first (out of order completion)
    completeInvocationByTask(db, "parent-stage", "task-b", "completed");

    const remaining = getActiveInvocations(db, "parent-stage");
    assert.equal(remaining.length, 2);
    assert.deepEqual(remaining.map((a) => a.task_slug), ["task-a", "task-c"]);

    const finishedB = getInvocationByTask(db, "parent-stage", "task-b");
    assert.equal(finishedB?.status, "completed");
    assert.ok(finishedB?.finished_at);

    // Complete remaining
    completeInvocationByTask(db, "parent-stage", "task-a", "completed");
    completeInvocationByTask(db, "parent-stage", "task-c", "completed");

    assert.equal(getActiveInvocations(db, "parent-stage").length, 0);

    db.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Herdr worktree provisioning and isolation gating (ISC 4, 5, 7, 8, 10)", () => {
  const origEnv = process.env.HERDR_ENV;
  const origExecSync = herdrOps.execSync;
  const executedCommands: string[] = [];

  try {
    // 1. Outside Herdr: HERDR_ENV is not set
    delete process.env.HERDR_ENV;
    assert.equal(isHerdrActive(), false);
    assert.throws(
      () => {
        createHerdrWorktree({
          cwd: "/workspace",
          branch: "feat/foo/t1",
          label: "t1",
        });
      },
      { message: /Cannot create Herdr worktree outside a Herdr environment/ }
    );

    // 2. In Herdr: HERDR_ENV === '1'
    process.env.HERDR_ENV = "1";
    assert.equal(isHerdrActive(), true);

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

    const baseBranch = "feat/parallel-subagents";
    const taskSlugs = ["task-1", "task-2"];
    const created: Array<{ worktreePath: string; workspaceId?: string }> = [];

    // Serially provision worktrees
    for (const slug of taskSlugs) {
      const wt = createHerdrWorktree({
        cwd: "/workspace",
        branch: `${baseBranch}/${slug}`,
        label: slug,
      });
      created.push(wt);
    }

    assert.equal(created.length, 2);
    assert.equal(created[0].worktreePath, `/tmp/worktrees/${baseBranch}/task-1`);
    assert.equal(created[0].workspaceId, "ws_task-1");
    assert.equal(created[1].worktreePath, `/tmp/worktrees/${baseBranch}/task-2`);
    assert.equal(created[1].workspaceId, "ws_task-2");

    // Worktrees remain intact during task implementation/review.
    // At integration barrier after successful checks, cleanup is triggered:
    for (const wt of created) {
      if (wt.workspaceId) {
        removeHerdrWorktree(wt.workspaceId);
      }
    }

    assert.equal(executedCommands.length, 4);
    assert.ok(executedCommands[0].includes('herdr worktree create --cwd "/workspace" --branch "feat/parallel-subagents/task-1" --label "task-1" --no-focus'));
    assert.ok(executedCommands[1].includes('herdr worktree create --cwd "/workspace" --branch "feat/parallel-subagents/task-2" --label "task-2" --no-focus'));
    assert.equal(executedCommands[2], 'herdr worktree remove --workspace "ws_task-1" --force');
    assert.equal(executedCommands[3], 'herdr worktree remove --workspace "ws_task-2" --force');
  } finally {
    herdrOps.execSync = origExecSync;
    if (origEnv !== undefined) {
      process.env.HERDR_ENV = origEnv;
    } else {
      delete process.env.HERDR_ENV;
    }
  }
});

test("Workflow definitions reflect in-worktree review and concurrency attributes (ISC 11, 13)", () => {
  const taskImplPath = join(resolveWorkflowsDir(), "task-implementation/task-implementation.yaml");
  const taskImplDef = parse(readFileSync(taskImplPath, "utf-8"));

  assert.ok(taskImplDef.states.task_review, "task-implementation must define task_review state");
  assert.equal(taskImplDef.states.task_review.subagent, "reviewer");
  const reviewTransitions = taskImplDef.states.task_review.transitions;
  assert.ok(reviewTransitions.some((t: any) => t.outcome === "review_passed" && t.to === "report"));
  assert.ok(
    reviewTransitions.some(
      (t: any) => t.outcome === "review_defects_found" && t.to === "implement" && t.max_retries === 2
    )
  );

  const featImplPath = join(resolveWorkflowsDir(), "feature-implementation/feature-implementation.yaml");
  const featImplDef = parse(readFileSync(featImplPath, "utf-8"));

  assert.equal(featImplDef.concurrency, 3);
  assert.equal(featImplDef.states.implementation.concurrency, 3);
  assert.ok(featImplDef.states.integration.goal.includes("integration barrier"));
});
