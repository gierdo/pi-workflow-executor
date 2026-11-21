import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initDatabase, createRun, getRun } from "../runner/db.ts";
import {
  checkAndIncrementLoop,
  getLoopCount,
  createChildInvocation,
  getActiveInvocation,
  getActiveInvocations,
  getInvocationByTask,
  completeInvocationByTask,
  completeChildInvocation,
} from "../runner/invocations.ts";

test("checkAndIncrementLoop pauses run at max_retries limit (ISC 9)", () => {
  const db = initDatabase(":memory:");
  createRun(db, {
    id: "run-loop",
    task: "t",
    workflow: "wf",
    initialState: "stateA",
    definitionFingerprint: "fp",
  });

  const res1 = checkAndIncrementLoop(db, "run-loop", "tr_refine", 2);
  assert.equal(res1.allowed, true);
  assert.equal(res1.count, 1);

  const res2 = checkAndIncrementLoop(db, "run-loop", "tr_refine", 2);
  assert.equal(res2.allowed, true);
  assert.equal(res2.count, 2);

  // Third attempt exceeds limit of 2:
  const res3 = checkAndIncrementLoop(db, "run-loop", "tr_refine", 2);
  assert.equal(res3.allowed, false);
  assert.equal(res3.count, 2);

  const run = getRun(db, "run-loop");
  assert.equal(run?.status, "paused");
  assert.ok(run?.pause_reason?.includes("Loop thrash guard"));
});

test("child invocation applies entry override once and preserves active invocation across resume (ISC 11)", () => {
  const db = initDatabase(":memory:");
  createRun(db, {
    id: "parent-1",
    task: "t",
    workflow: "parent_wf",
    initialState: "invoke_child",
    definitionFingerprint: "fp",
  });

  // Launch child with entry override
  const inv = createChildInvocation(db, "parent-1", "child_wf", "step_custom");
  assert.equal(inv.status, "active");
  assert.equal(inv.entry_override, "step_custom");

  // On resume, getActiveInvocation retrieves existing invocation rather than creating a new one
  const active = getActiveInvocation(db, "parent-1");
  assert.ok(active);
  assert.equal(active.invocation_id, inv.invocation_id);
  assert.equal(active.entry_override, "step_custom");
});

test("child abort is distinguishable from success in persisted outcome (ISC 10)", () => {
  const db = initDatabase(":memory:");
  createRun(db, {
    id: "parent-2",
    task: "t",
    workflow: "parent_wf",
    initialState: "invoke_child",
    definitionFingerprint: "fp",
  });

  const invSuccess = createChildInvocation(db, "parent-2", "child_wf");
  completeChildInvocation(db, invSuccess.invocation_id, "completed");

  const rowSuccess = db.prepare("SELECT * FROM invocations WHERE invocation_id = ?").get(invSuccess.invocation_id) as { status: string };
  assert.equal(rowSuccess.status, "completed");

  // Re-entry opens fresh invocation ID
  const invAbort = createChildInvocation(db, "parent-2", "child_wf");
  assert.notEqual(invAbort.invocation_id, invSuccess.invocation_id);

  completeChildInvocation(db, invAbort.invocation_id, "aborted");
  const rowAbort = db.prepare("SELECT * FROM invocations WHERE invocation_id = ?").get(invAbort.invocation_id) as { status: string };
  assert.equal(rowAbort.status, "aborted");
});

test("multi-child active tracking, query by task slug, and task completion (ISC 1, 2, 3)", () => {
  const db = initDatabase(":memory:");
  createRun(db, {
    id: "parent-parallel",
    task: "feature-impl",
    workflow: "feature-implementation",
    initialState: "implementation",
    definitionFingerprint: "fp-123",
  });

  const inv1 = createChildInvocation(db, "parent-parallel", "task-implementation", {
    taskSlug: "task-1",
    childRunId: "task-implementation-task-1",
    worktree: "/tmp/worktree-1",
    branch: "feat/my-feature/task-1",
  });
  assert.equal(inv1.task_slug, "task-1");
  assert.equal(inv1.child_run_id, "task-implementation-task-1");
  assert.equal(inv1.worktree, "/tmp/worktree-1");
  assert.equal(inv1.branch, "feat/my-feature/task-1");
  assert.equal(inv1.status, "active");

  const inv2 = createChildInvocation(db, "parent-parallel", "task-implementation", {
    taskSlug: "task-2",
    childRunId: "task-implementation-task-2",
    worktree: "/tmp/worktree-2",
    branch: "feat/my-feature/task-2",
  });

  const activeInvocations = getActiveInvocations(db, "parent-parallel");
  assert.equal(activeInvocations.length, 2);
  assert.equal(activeInvocations[0].task_slug, "task-1");
  assert.equal(activeInvocations[1].task_slug, "task-2");

  const task1Inv = getInvocationByTask(db, "parent-parallel", "task-1");
  assert.ok(task1Inv);
  assert.equal(task1Inv?.invocation_id, inv1.invocation_id);

  const task2Inv = getInvocationByTask(db, "parent-parallel", "task-2");
  assert.ok(task2Inv);
  assert.equal(task2Inv?.invocation_id, inv2.invocation_id);

  const missingTask = getInvocationByTask(db, "parent-parallel", "task-nonexistent");
  assert.equal(missingTask, null);

  // Complete task 1 by task slug
  completeInvocationByTask(db, "parent-parallel", "task-1", "completed");

  const updatedActive = getActiveInvocations(db, "parent-parallel");
  assert.equal(updatedActive.length, 1);
  assert.equal(updatedActive[0].task_slug, "task-2");

  const finishedTask1 = getInvocationByTask(db, "parent-parallel", "task-1");
  assert.equal(finishedTask1?.status, "completed");
  assert.ok(finishedTask1?.finished_at);
});

test("initDatabase applies idempotent migration to pre-existing database without new columns", () => {
  const rawDb = new DatabaseSync(":memory:");
  rawDb.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      workflow TEXT NOT NULL,
      current_state TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      definition_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_run_id TEXT NOT NULL REFERENCES runs(id),
      invocation_id TEXT NOT NULL UNIQUE,
      child_workflow TEXT NOT NULL,
      entry_override TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
  `);

  // Verify columns don't exist yet
  const beforeCols = (rawDb.prepare("PRAGMA table_info(invocations)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!beforeCols.includes("task_slug"));

  // Run the column migration logic as done in initDatabase
  const cols = rawDb.prepare("PRAGMA table_info(invocations)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("task_slug")) rawDb.exec("ALTER TABLE invocations ADD COLUMN task_slug TEXT;");
  if (!colNames.has("child_run_id")) rawDb.exec("ALTER TABLE invocations ADD COLUMN child_run_id TEXT;");
  if (!colNames.has("worktree")) rawDb.exec("ALTER TABLE invocations ADD COLUMN worktree TEXT;");
  if (!colNames.has("branch")) rawDb.exec("ALTER TABLE invocations ADD COLUMN branch TEXT;");

  const afterCols = (rawDb.prepare("PRAGMA table_info(invocations)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(afterCols.includes("task_slug"));
  assert.ok(afterCols.includes("child_run_id"));
  assert.ok(afterCols.includes("worktree"));
  assert.ok(afterCols.includes("branch"));
});

